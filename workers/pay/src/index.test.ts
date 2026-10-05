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
					const bal = Math.max(0, ((s.get('balance') as number) ?? 0) - b.amount);
					s.set('balance', bal);
					s.set('spent', ((s.get('spent') as number) ?? 0) + b.amount);
					out = { paid: bal > 0, balanceSeconds: bal };
				} else if (op === '/claim') {
					out = s.get(`nonce:${b.nonce}`) ? { ok: false } : (s.set(`nonce:${b.nonce}`, 1), { ok: true });
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
