import { describe, it, expect, vi } from 'vitest';
import { type Env } from './index';

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
		PAY_SUB: JSON.stringify({ priceId: 'price_sub', seconds: 20000, label: 'Pro', paymentLink: 'https://buy.stripe.com/sub_link' }),
		PAY_PACKAGES: JSON.stringify([{ id: 'pack8k', seconds: 8000, priceId: 'price_p8', paymentLink: 'https://buy.stripe.com/p8_link' }]),
		...over
	};
}

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

describe('payment-link checkout — no Stripe credential on cic-pay', () => {
	it('assembles a Payment Link with the account bound as client_reference_id', async () => {
		const res = await worker.fetch(
			new Request('https://pay.test/pay/checkout', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ accountId: ACCT, kind: 'pack', packId: 'pack8k' })
			}),
			env()
		);
		const body = (await res.json()) as { url?: string };
		expect(res.status).toBe(200);
		expect(body.url).toBe(`https://buy.stripe.com/p8_link?client_reference_id=${ACCT}`);
	});

	it('binds room top-ups as accountId:room in the reference', async () => {
		const res = await worker.fetch(
			new Request('https://pay.test/pay/checkout', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ accountId: ACCT, kind: 'room', packId: 'pack8k', room: 'ROOM9' })
			}),
			env()
		);
		const body = (await res.json()) as { url?: string };
		expect(body.url).toContain(`client_reference_id=${ACCT}%3AROOM9`);
	});

	it('never calls the Stripe API — checkout works with zero Stripe env', async () => {
		const calls: string[] = [];
		vi.stubGlobal('fetch', async (u: unknown) => { calls.push(String(u)); return new Response('{}'); });
		try {
			await worker.fetch(
				new Request('https://pay.test/pay/checkout', {
					method: 'POST', headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ accountId: ACCT, kind: 'sub' })
				}),
				env()
			);
			expect(calls.filter((u) => u.includes('api.stripe.com'))).toHaveLength(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('portal + webhook forward to cic-pay-hook', () => {
	const fakeHook = (seen: { url: string; body: string; sig: string | null }[]) =>
		({
			fetch: async (u: string, init?: RequestInit) => {
				seen.push({
					url: String(u),
					body: String(init?.body ?? ''),
					sig: (init?.headers as Headers).get('stripe-signature')
				});
				return new Response(JSON.stringify({ received: true }));
			}
		}) as unknown as Fetcher;

	it('webhook forwards the raw signed payload verbatim via the binding', async () => {
		const seen: { url: string; body: string; sig: string | null }[] = [];
		const evt = JSON.stringify({ id: 'evt_1', type: 'ping', data: { object: {} } });
		const res = await worker.fetch(
			new Request('https://pay.test/pay/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=x' },
				body: evt
			}),
			env({ PAY_HOOK: fakeHook(seen) })
		);
		expect(res.status).toBe(200);
		expect(seen[0].url).toBe('https://pay-hook/pay-hook/webhook');
		expect(seen[0].body).toBe(evt);
		expect(seen[0].sig).toBe('t=1,v1=x');
	});

	it('webhook is 503 when the hook is unbound', async () => {
		const res = await worker.fetch(
			new Request('https://pay.test/pay/webhook', { method: 'POST', body: '{}' }),
			env()
		);
		expect(res.status).toBe(503);
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
