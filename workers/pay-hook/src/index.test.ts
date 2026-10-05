import { describe, it, expect, vi } from 'vitest';
import worker, { verifyStripeSignature, handleEvent, type Env } from './index';

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
 * ops the hook worker uses (get/credit/debit/claim/kvget/kvput/kvlist).
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
					out = { paid: (s.get('balance') ?? 0) > 0, balanceSeconds: s.get('balance') ?? 0 };
				} else if (op === '/credit') {
					s.set('balance', ((s.get('balance') as number) ?? 0) + b.amount);
					if (b.creditId) s.set(`credit:${b.creditId}`, b.amount);
					out = { ok: true, balanceSeconds: s.get('balance') };
				} else if (op === '/debit') {
					// emulate the DO's clawback bound
					const credited = (s.get(`credit:${b.clawbackOf}`) as number) ?? 0;
					const clawed = (s.get(`clawed:${b.clawbackOf}`) as number) ?? 0;
					const amt = Math.min(b.amount ?? 0, credited - clawed);
					if (amt <= 0) return new Response(JSON.stringify({ error: 'no matching credit' }), { status: 403 });
					s.set(`clawed:${b.clawbackOf}`, clawed + amt);
					const bal = Math.max(0, ((s.get('balance') as number) ?? 0) - amt);
					s.set('balance', bal);
					out = { paid: bal > 0, balanceSeconds: bal, debitedSeconds: amt };
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
				} else if (op === '/audit') {
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
		PAY_SUB: JSON.stringify({ priceId: 'price_sub', seconds: 20000 }),
		PAY_PACKAGES: JSON.stringify([{ id: 'pack8k', seconds: 8000, priceId: 'price_p8' }]),
		...over
	};
}

describe('handleEvent — checkout.session.completed (Payment Links)', () => {
	it('credits the wallet using client_reference_id + price lookup', async () => {
		vi.stubGlobal('fetch', async (u: unknown) =>
			String(u).includes('/line_items')
				? new Response(JSON.stringify({ data: [{ price: { id: 'price_p8' } }] }))
				: new Response('{}')
		);
		try {
			const m = fakeMeter();
			await handleEvent(env({ METER: m.ns, STRIPE_READ_KEY: 'rk_t' }), 'checkout.session.completed', {
				id: 'cs_1', mode: 'payment', customer: 'cus_1', client_reference_id: ACCT,
				payment_intent: 'pi_1'
			});
			const s = m.stores.get(`acct:${ACCT}`)!;
			expect(s.get('balance')).toBe(8000);
			expect(s.get('customer')).toBe('cus_1');
			expect(s.get('credit:pi:pi_1')).toBe(8000);
			expect(m.stores.get('cust:cus_1')!.get('accountId')).toBe(ACCT);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('credits the room pool for <accountId>:<room> references', async () => {
		vi.stubGlobal('fetch', async () =>
			new Response(JSON.stringify({ data: [{ price: { id: 'price_p8' } }] }))
		);
		try {
			const m = fakeMeter();
			await handleEvent(env({ METER: m.ns, STRIPE_READ_KEY: 'rk_t' }), 'checkout.session.completed', {
				id: 'cs_2', mode: 'payment', customer: 'cus_2',
				client_reference_id: `${ACCT}:ROOM9`, payment_intent: 'pi_2'
			});
			expect(m.stores.get('ROOM9')!.get('balance')).toBe(8000);
			expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('links the customer but does not credit on subscription checkout', async () => {
		const m = fakeMeter();
		await handleEvent(env({ METER: m.ns }), 'checkout.session.completed', {
			id: 'cs_3', mode: 'subscription', customer: 'cus_3', subscription: 'sub_3',
			client_reference_id: ACCT
		});
		expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBeUndefined();
		expect(m.stores.get(`acct:${ACCT}`)!.get('subscriptionId')).toBe('sub_3');
	});
});

describe('handleEvent — invoice.paid', () => {
	it('credits the monthly allotment once per invoice, priced by line item', async () => {
		const m = fakeMeter();
		const e = env({ METER: m.ns });
		m.stores.set('cust:cus_4', new Map([['accountId', ACCT]]));
		const inv = {
			id: 'in_1', customer: 'cus_4', subscription: 'sub_4', billing_reason: 'subscription_cycle',
			lines: { data: [{ price: { id: 'price_sub' } }] }
		};
		await handleEvent(e, 'invoice.paid', inv);
		await handleEvent(e, 'invoice.paid', inv); // resent event → no double credit
		expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBe(20000);
	});
});

describe('handleEvent — clawback', () => {
	it('clawback debits at most the recorded credit', async () => {
		vi.stubGlobal('fetch', async (u: unknown) =>
			String(u).includes('/charges/')
				? new Response(JSON.stringify({ customer: 'cus_7', payment_intent: 'pi_9' }))
				: new Response('{}')
		);
		try {
			const m = fakeMeter();
			const e = env({ METER: m.ns, STRIPE_READ_KEY: 'rk_t' });
			m.stores.set('cust:cus_7', new Map([['accountId', ACCT]]));
			m.stores.set(`acct:${ACCT}`, new Map([['balance', 5000], ['credit:pi:pi_9', 300]]));
			await handleEvent(e, 'charge.refunded', { id: 'ch_1' });
			expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBe(4700);
			expect(m.stores.get(`acct:${ACCT}`)!.get('lastChargeback')).toBeDefined();
			// second event for the same charge → nothing left to claw
			await handleEvent(e, 'charge.refunded', { id: 'ch_1' });
			expect(m.stores.get(`acct:${ACCT}`)!.get('balance')).toBe(4700);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('webhook event re-verification', () => {
	const mkWebhook = (body: object, secret: string) =>
		sign(JSON.stringify(body), secret).then(
			(sig) =>
				new Request('https://hook.test/pay-hook/webhook', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'stripe-signature': sig },
					body: JSON.stringify(body)
				})
		);

	it('rejects events Stripe cannot confirm — leaked secret ≠ minted credits', async () => {
		vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
		try {
			const m = fakeMeter();
			const e = env({ METER: m.ns, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_READ_KEY: 'rk_test_x' });
			const evt = { id: 'evt_forge', type: 'checkout.session.completed', data: { object: { id: 'cs_x', client_reference_id: ACCT } } };
			const res = await worker.fetch(await mkWebhook(evt, SECRET), e);
			expect(res.status).toBe(400);
			expect(m.stores.get(`acct:${ACCT}`)).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('rejects tampered payloads even when the event id is real', async () => {
		vi.stubGlobal('fetch', async () =>
			new Response(JSON.stringify({ id: 'evt_real', type: 'checkout.session.completed', data: { object: { id: 'cs_REAL' } } }))
		);
		try {
			const e = env({ STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_READ_KEY: 'rk_test_x' });
			const evt = { id: 'evt_real', type: 'checkout.session.completed', data: { object: { id: 'cs_FORGED', client_reference_id: ACCT } } };
			expect((await worker.fetch(await mkWebhook(evt, SECRET), e)).status).toBe(400);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('portal — signature required, no customer → 404', () => {
	it('rejects unsigned requests', async () => {
		const res = await worker.fetch(
			new Request('https://hook.test/pay-hook/portal', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ accountId: ACCT })
			}),
			env({ PAY_PORTAL_LINK: 'https://billing.stripe.com/p/login/test' })
		);
		expect(res.status).toBe(401);
	});
});
