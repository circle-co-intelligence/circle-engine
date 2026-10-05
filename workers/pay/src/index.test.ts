import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verifyStripeSignature, handleEvent, type Env } from './index';

const SECRET = 'whsec_testsecret';

async function sign(raw: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `t=${t},v1=${hex}`;
}

describe('verifyStripeSignature', () => {
	it('accepts a correctly-signed payload', async () => {
		const raw = '{"id":"evt_1"}';
		expect(await verifyStripeSignature(raw, await sign(raw, SECRET), SECRET)).toBe(true);
	});

	it('rejects tampered payloads and wrong secrets', async () => {
		const raw = '{"id":"evt_1"}';
		const h = await sign(raw, SECRET);
		expect(await verifyStripeSignature('{"id":"evt_2"}', h, SECRET)).toBe(false);
		expect(await verifyStripeSignature(raw, await sign(raw, 'whsec_other'), SECRET)).toBe(false);
	});

	it('rejects stale timestamps and malformed headers', async () => {
		const raw = '{"id":"evt_1"}';
		const old = Math.floor(Date.now() / 1000) - 600;
		expect(await verifyStripeSignature(raw, await sign(raw, SECRET, old), SECRET)).toBe(false);
		expect(await verifyStripeSignature(raw, 't=1', SECRET)).toBe(false);
		expect(await verifyStripeSignature(raw, null, SECRET)).toBe(false);
	});
});

/**
 * MeterBus stub — in-memory instances keyed by name; implements just the
 * ops the pay worker uses (get/credit/debit/claim/kvget/kvput/kvlist/sponsor).
 */
function fakeMeter() {
	const stores = new Map<string, Map<string, unknown>>();
	const calls: { instance: string; op: string; body: Record<string, unknown> }[] = [];
	const store = (n: string) => stores.get(n) ?? stores.set(n, new Map()).get(n)!;
	const ns = {
		idFromName: (n: string) => n as unknown as DurableObjectId,
		get: (id: unknown) => ({
			fetch: async (url: string | URL | Request, init?: RequestInit) => {
				const name = id as unknown as string;
				const op = new URL(url.toString()).pathname;
				const b = init?.body ? JSON.parse(init.body as string) : {};
				calls.push({ instance: name, op, body: b });
				const s = store(name);
				let out: unknown = {};
				if (op === '/get') {
					out = {
						paid: (s.get('balance') ?? 0) > 0,
						balanceSeconds: s.get('balance') ?? 0,
						spentSeconds: s.get('spent') ?? 0,
						sponsor: s.get('sponsor') ?? null
					};
				} else if (op === '/credit') {
					s.set('balance', ((s.get('balance') as number) ?? 0) + b.amount);
					out = { ok: true, balanceSeconds: s.get('balance') };
				} else if (op === '/debit') {
					const lim = s.get('limits') as { maxSecondsPerDay?: number } | undefined;
					const day = new Date().toISOString().slice(0, 10);
					const dk = `spendDay:${day}`;
					if (lim?.maxSecondsPerDay && ((s.get(dk) as number) ?? 0) + b.amount > lim.maxSecondsPerDay) {
						out = { ok: false, status: 'cap' };
						return new Response(JSON.stringify(out), { status: 402 });
					}
					if (lim?.maxSecondsPerDay) s.set(dk, ((s.get(dk) as number) ?? 0) + b.amount);
					const bal = Math.max(0, ((s.get('balance') as number) ?? 0) - b.amount);
					s.set('balance', bal);
					s.set('spent', ((s.get('spent') as number) ?? 0) + b.amount);
					out = { paid: bal > 0, balanceSeconds: bal };
				} else if (op === '/transfer') {
					const lim = s.get('limits') as { maxSecondsPerDay?: number } | undefined;
					const dk = `spendDay:${new Date().toISOString().slice(0, 10)}`;
					const bal0 = (s.get('balance') as number) ?? 0;
					if (lim?.maxSecondsPerDay && ((s.get(dk) as number) ?? 0) + b.amount > lim.maxSecondsPerDay)
						out = { ok: false, status: 'cap' };
					else if (bal0 < b.amount) out = { ok: false, status: 'insufficient', available: bal0 };
					else {
						if (lim?.maxSecondsPerDay) s.set(dk, ((s.get(dk) as number) ?? 0) + b.amount);
						s.set('balance', bal0 - b.amount);
						s.set('spent', ((s.get('spent') as number) ?? 0) + b.amount);
						const t = store(b.to as string);
						t.set('balance', ((t.get('balance') as number) ?? 0) + b.amount);
						out = { ok: true, balanceSeconds: t.get('balance') };
					}
				} else if (op === '/audit') {
					const list = (s.get('audit') as unknown[]) ?? [];
					list.unshift(b.entry);
					s.set('audit', list.slice(0, 50));
					out = { ok: true };
				} else if (op === '/claim') {
					if (s.get(`nonce:${b.nonce}`))
						return new Response(JSON.stringify({ ok: false }), { status: 409 });
					s.set(`nonce:${b.nonce}`, 1);
					out = { ok: true };
				} else if (op === '/kvget') {
					out = { value: s.get(b.key) ?? null };
				} else if (op === '/kvput') {
					s.set(b.key, b.value);
					out = { ok: true };
				} else if (op === '/kvlist') {
					const items: Record<string, unknown> = {};
					for (const [k, v] of s) if (k.startsWith(b.prefix ?? '')) items[k] = v;
					out = { items };
				} else if (op === '/sponsor') {
					b.account ? s.set('sponsor', b.account) : s.delete('sponsor');
					out = { ok: true };
				}
				return new Response(JSON.stringify(out), { status: 200 });
			}
		})
	} as unknown as DurableObjectNamespace;
	return { ns, calls, stores };
}

const ACCT = 'a'.repeat(64);

function env(over: Partial<Env> = {}): Env {
	return {
		METER: fakeMeter().ns,
		PAY_SUB: JSON.stringify({ priceId: 'price_sub', seconds: 20000, label: 'Pro' }),
		PAY_PACKAGES: JSON.stringify([{ id: 'pack8k', seconds: 8000, priceId: 'price_p8' }]),
		...over
	};
}

describe('handleEvent — checkout.session.completed', () => {
	it('credits the account wallet on pack purchase', async () => {
		const m = fakeMeter();
		const e = env({ METER: m.ns });
		await handleEvent(e, 'checkout.session.completed', {
			id: 'cs_1', mode: 'payment', customer: 'cus_1',
			metadata: { accountId: ACCT, kind: 'pack', seconds: '8000' }
		});
		const s = m.stores.get(`acct:${ACCT}`)!;
		expect(s.get('balance')).toBe(8000);
		expect(s.get('customer')).toBe('cus_1');
		expect(m.stores.get('cust:cus_1')!.get('accountId')).toBe(ACCT);
	});

	it('credits the room pool for room top-ups', async () => {
		const m = fakeMeter();
		await handleEvent(env({ METER: m.ns }), 'checkout.session.completed', {
			id: 'cs_2', mode: 'payment', customer: 'cus_2',
			metadata: { accountId: ACCT, kind: 'room', room: 'ROOM9', seconds: '1800' }
		});
		expect(m.stores.get('ROOM9')!.get('balance')).toBe(1800);
		expect(m.stores.get(`acct:${ACCT}`)).toBeDefined(); // cust link still recorded
		expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBeUndefined();
	});

	it('links the customer but does not credit on subscription checkout', async () => {
		const m = fakeMeter();
		await handleEvent(env({ METER: m.ns }), 'checkout.session.completed', {
			id: 'cs_3', mode: 'subscription', customer: 'cus_3', subscription: 'sub_3',
			metadata: { accountId: ACCT, kind: 'sub' }
		});
		expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBeUndefined();
		expect(m.stores.get(`acct:${ACCT}`)!.get('subscriptionId')).toBe('sub_3');
	});
});

describe('handleEvent — invoice.paid', () => {
	it('credits the monthly allotment once per invoice', async () => {
		const m = fakeMeter();
		const e = env({ METER: m.ns });
		m.stores.set('cust:cus_4', new Map([['accountId', ACCT]]));
		const inv = { id: 'in_1', customer: 'cus_4', subscription: 'sub_4', billing_reason: 'subscription_cycle' };
		await handleEvent(e, 'invoice.paid', inv);
		await handleEvent(e, 'invoice.paid', inv); // resent event → no double credit
		expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBe(20000);
	});

	it('ignores non-subscription invoices', async () => {
		const m = fakeMeter();
		const e = env({ METER: m.ns });
		m.stores.set('cust:cus_5', new Map([['accountId', ACCT]]));
		await handleEvent(e, 'invoice.paid', {
			id: 'in_2', customer: 'cus_5', subscription: 'sub_5', billing_reason: 'subscription_update'
		});
		expect(m.stores.get(`acct:${ACCT}`)).toBeUndefined();
	});
});

describe('handleEvent — subscription lifecycle + clawback', () => {
	it('records subscription status on the account', async () => {
		const m = fakeMeter();
		const e = env({ METER: m.ns });
		m.stores.set('cust:cus_6', new Map([['accountId', ACCT]]));
		await handleEvent(e, 'customer.subscription.deleted', {
			id: 'sub_6', customer: 'cus_6', status: 'canceled',
			cancel_at_period_end: false, current_period_end: 1_800_000_000,
			items: { data: [{ price: { id: 'price_sub' } }] }
		});
		const sub = m.stores.get(`acct:${ACCT}`)!.get('sub') as Record<string, unknown>;
		expect(sub.status).toBe('canceled');
		expect(sub.priceId).toBe('price_sub');
	});

	it('clamp-debits on charge.refunded using payment-intent metadata', async () => {
		const m = fakeMeter();
		const e = env({ METER: m.ns });
		m.stores.set(`acct:${ACCT}`, new Map([['balance', 5000]]));
		await handleEvent(e, 'charge.refunded', {
			id: 'ch_1', metadata: { accountId: ACCT, seconds: '8000' }
		});
		// 5000 - 8000 floors at 0
		expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBe(0);
	});
});

// ------------------------------------------------------------ signed auth

import worker, { verifyPasskey } from './index';

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hexBytes = (h: string) => {
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return out;
};
const sha256hex = async (d: Uint8Array | string) =>
	toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', (typeof d === 'string' ? new TextEncoder().encode(d) : d) as BufferSource)));
const b64url = (b: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function deviceKey() {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
	const pub = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
	return { pair, pub, keyHash: await sha256hex(pub) };
}

/** replicate the client's signRequest: payload fields + x-cic-* headers */
async function signedRequest(
	path: string,
	method: 'GET' | 'POST',
	bodyStr: string | undefined,
	dev: Awaited<ReturnType<typeof deviceKey>>,
	claimed: string,
	over: { ts?: number; nonce?: string; signAs?: string } = {}
): Promise<Request> {
	const ts = over.ts ?? Math.floor(Date.now() / 1000);
	const nonce = over.nonce ?? crypto.randomUUID();
	const bodyHash = await sha256hex(bodyStr ?? '');
	const payload = [claimed, method, path, bodyHash, String(ts), nonce, dev.keyHash].join('\n');
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		dev.pair.privateKey,
		new TextEncoder().encode(over.signAs ?? payload)
	);
	return new Request(`https://pay.test${path}`, {
		method,
		headers: {
			'content-type': 'application/json',
			'x-cic-pub': toHex(dev.pub),
			'x-cic-ts': String(ts),
			'x-cic-nonce': nonce,
			'x-cic-sig': toHex(new Uint8Array(sig)),
			'x-cic-account': claimed
		},
		body: method === 'GET' ? undefined : bodyStr
	});
}

describe('signed billing endpoints', () => {
	it('rejects unsigned wallet spend', async () => {
		const m = fakeMeter();
		m.stores.set(`acct:${ACCT}`, new Map([['balance', 5000]]));
		const res = await worker.fetch(
			new Request('https://pay.test/pay/convert', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ accountId: ACCT, room: 'ROOM1', seconds: 100 })
			}),
			env({ METER: m.ns })
		);
		expect(res.status).toBe(401);
		expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBe(5000);
	});

	it('accepts a correctly-signed convert and audits it', async () => {
		const m = fakeMeter();
		const dev = await deviceKey();
		m.stores.set(`acct:${dev.keyHash}`, new Map([['balance', 5000]]));
		const bodyStr = JSON.stringify({ accountId: dev.keyHash, room: 'ROOM1', seconds: 100 });
		const res = await worker.fetch(
			await signedRequest('/pay/convert', 'POST', bodyStr, dev, dev.keyHash),
			env({ METER: m.ns })
		);
		expect(res.status).toBe(200);
		expect(m.stores.get('ROOM1')!.get('balance')).toBe(100);
		const audit = m.stores.get(`acct:${dev.keyHash}`)!.get('audit') as { op: string }[];
		expect(audit[0].op).toBe('convert');
	});

	it('rejects tampered signatures, stale ts, and replayed nonces', async () => {
		const m = fakeMeter();
		const dev = await deviceKey();
		m.stores.set(`acct:${dev.keyHash}`, new Map([['balance', 5000]]));
		const mk = (over = {}) =>
			signedRequest('/pay/convert', 'POST', JSON.stringify({ accountId: dev.keyHash, room: 'R', seconds: 10 }), dev, dev.keyHash, over);
		expect((await worker.fetch(await mk({ signAs: 'forged' }), env({ METER: m.ns }))).status).toBe(401);
		expect((await worker.fetch(await mk({ ts: Math.floor(Date.now() / 1000) - 600 }), env({ METER: m.ns }))).status).toBe(401);
		const nonce = crypto.randomUUID();
		expect((await worker.fetch(await mk({ nonce }), env({ METER: m.ns }))).status).toBe(200);
		expect((await worker.fetch(await mk({ nonce }), env({ METER: m.ns }))).status).toBe(409);
	});

	it('authorizes registered delegate keys and rejects revoked ones', async () => {
		const m = fakeMeter();
		const primary = await deviceKey();
		const delegate = await deviceKey();
		const acct = primary.keyHash;
		m.stores.set(`acct:${acct}`, new Map([['balance', 5000], [`key:${delegate.keyHash}`, { at: 1 }]]));
		const bodyStr = JSON.stringify({ accountId: acct, room: 'R', seconds: 10 });
		const ok = await worker.fetch(await signedRequest('/pay/convert', 'POST', bodyStr, delegate, acct), env({ METER: m.ns }));
		expect(ok.status).toBe(200);
		// revoke → the same signature is now rejected
		m.stores.get(`acct:${acct}`)!.set(`key:${delegate.keyHash}`, null);
		const bodyStr2 = JSON.stringify({ accountId: acct, room: 'R', seconds: 10 });
		const no = await worker.fetch(await signedRequest('/pay/convert', 'POST', bodyStr2, delegate, acct), env({ METER: m.ns }));
		expect(no.status).toBe(401);
	});

	it('enforces the user-set daily spend cap on convert', async () => {
		const m = fakeMeter();
		const dev = await deviceKey();
		m.stores.set(`acct:${dev.keyHash}`, new Map([['balance', 999999], ['limits', { maxSecondsPerDay: 100 }]]));
		const mk = () => signedRequest('/pay/convert', 'POST', JSON.stringify({ accountId: dev.keyHash, room: 'R', seconds: 80 }), dev, dev.keyHash);
		expect((await worker.fetch(await mk(), env({ METER: m.ns }))).status).toBe(200);
		// 80 spent of a 100/day cap → next 80 exceeds → 402 insufficient
		const res = await worker.fetch(await mk(), env({ METER: m.ns }));
		expect(res.status).toBe(402);
	});
});

describe('webhook event re-verification', () => {
	const mkWebhook = (body: object, secret: string) =>
		sign(JSON.stringify(body), secret).then(
			(sig) =>
				new Request('https://pay.test/pay/webhook', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'stripe-signature': sig },
					body: JSON.stringify(body)
				})
		);

	it('rejects events Stripe cannot confirm — leaked secret ≠ minted credits', async () => {
		vi.stubGlobal('fetch', async (u: unknown) =>
			String(u).includes('/v1/events/') ? new Response('{}', { status: 404 }) : new Response('{}')
		);
		try {
			const m = fakeMeter();
			const e = env({ METER: m.ns, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'rk_test_x' });
			const evt = { id: 'evt_forge', type: 'checkout.session.completed', data: { object: { id: 'cs_x', metadata: { accountId: ACCT, seconds: '8000' } } } };
			const res = await worker.fetch(await mkWebhook(evt, SECRET), e);
			expect(res.status).toBe(400);
			expect(m.stores.get(`acct:${ACCT}`)).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('rejects tampered payloads even when the event id is real', async () => {
		vi.stubGlobal('fetch', async (u: unknown) =>
			String(u).includes('/v1/events/')
				? new Response(JSON.stringify({ id: 'evt_real', type: 'checkout.session.completed', data: { object: { id: 'cs_REAL' } } }))
				: new Response('{}')
		);
		try {
			const m = fakeMeter();
			const e = env({ METER: m.ns, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'rk_test_x' });
			// real event id but swapped object → data.object.id mismatch
			const evt = { id: 'evt_real', type: 'checkout.session.completed', data: { object: { id: 'cs_FORGED', metadata: { accountId: ACCT, seconds: '8000' } } } };
			const res = await worker.fetch(await mkWebhook(evt, SECRET), e);
			expect(res.status).toBe(400);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('processes a Stripe-confirmed event and credits once', async () => {
		vi.stubGlobal('fetch', async (u: unknown) =>
			String(u).includes('/v1/events/')
				? new Response(JSON.stringify({ id: 'evt_ok', type: 'checkout.session.completed', data: { object: { id: 'cs_ok' } } }))
				: new Response('{}')
		);
		try {
			const m = fakeMeter();
			const e = env({ METER: m.ns, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'rk_test_x' });
			const evt = { id: 'evt_ok', type: 'checkout.session.completed', data: { object: { id: 'cs_ok', mode: 'payment', customer: 'cus_9', metadata: { accountId: ACCT, kind: 'pack', seconds: '8000' } } } };
			expect((await worker.fetch(await mkWebhook(evt, SECRET), e)).status).toBe(200);
			expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBe(8000);
			// replayed verbatim → dedupe
			const dup = await worker.fetch(await mkWebhook(evt, SECRET), e);
			expect((await dup.json() as { duplicate?: boolean }).duplicate).toBe(true);
			expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBe(8000);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('webauthn step-up', () => {
	const b64urlBytes = (u: Uint8Array) => b64url(u);
	async function makeAssertion(accountId: string, cred: Awaited<ReturnType<typeof deviceKey>>, credId: string, challenge: string, rpHost: string, signCount = 1) {
		const authData = new Uint8Array(37);
		authData.set(hexBytes(await sha256hex(rpHost)), 0);
		authData[32] = 0x05; // UP|UV
		new DataView(authData.buffer).setUint32(33, signCount);
		const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge }));
		const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData as BufferSource));
		const signed = new Uint8Array(authData.length + cdHash.length);
		signed.set(authData); signed.set(cdHash, authData.length);
		const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cred.pair.privateKey, signed));
		// DER-encode like an authenticator would
		const int = (v: Uint8Array) => (v[0] & 0x80 ? new Uint8Array([0, ...v]) : v);
		const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
		const der = new Uint8Array(2 + 2 + r.length + 2 + s.length);
		der.set([0x30, 2 + r.length + 2 + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);
		return { credId, authenticatorData: b64urlBytes(authData), clientDataJSON: b64urlBytes(clientData), signature: b64urlBytes(der) };
	}

	it('verifies a real assertion and consumes the challenge', async () => {
		const m = fakeMeter();
		const e = env({ METER: m.ns, APP_ORIGIN: 'https://app.example' });
		const cred = await deviceKey();
		const credId = 'cred1';
		m.stores.set(`acct:${ACCT}`, new Map([[`passkey:${credId}`, { pubSpki: toHex(cred.pub), signCount: 0 }]]));
		// issue a challenge through the endpoint
		const chRes = await worker.fetch(
			new Request('https://pay.test/pay/challenge', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ accountId: ACCT })
			}), e);
		const { challenge } = await chRes.json() as { challenge: string };
		const assertion = await makeAssertion(ACCT, cred, credId, challenge, 'app.example');
		expect(await verifyPasskey(e, ACCT, assertion)).toBe(true);
		// replay → challenge consumed
		expect(await verifyPasskey(e, ACCT, assertion)).toBe(false);
	});

	it('rejects wrong-rp and unsigned assertions', async () => {
		const m = fakeMeter();
		const e = env({ METER: m.ns, APP_ORIGIN: 'https://app.example' });
		const cred = await deviceKey();
		m.stores.set(`acct:${ACCT}`, new Map([[`passkey:c`, { pubSpki: toHex(cred.pub), signCount: 0 }]]));
		const chRes = await worker.fetch(
			new Request('https://pay.test/pay/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: ACCT }) }), e);
		const { challenge } = await chRes.json() as { challenge: string };
		const bad = await makeAssertion(ACCT, cred, 'c', challenge, 'evil.example');
		expect(await verifyPasskey(e, ACCT, bad)).toBe(false);
		expect(await verifyPasskey(e, ACCT, { credId: 'c' })).toBe(false);
	});
});
