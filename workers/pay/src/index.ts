/**
 * cic-pay — Stripe billing bridge (Cloudflare Worker).
 *
 * The bearer billing identity is the browser-local accountId (an unguessable
 * 64-hex token held in the user's localStorage — see src/lib/bridge/account.ts).
 * Stripe Checkout carries it as client_reference_id + metadata; the webhook
 * settles events into MeterBus-backed pools:
 *
 *   acct:<accountId>   — the user's wallet ({balance,spent} + 'customer',
 *                        'sub', 'sponsored:<room>' KV records)
 *   <room>             — room pool (existing paid-tier semantics) + 'sponsor'
 *   cust:<customerId>  — stripe customer → accountId (subscription events
 *                        carry the customer, not our metadata)
 *   evt:<eventId>      — webhook dedupe via the /claim op
 *
 * No Stripe SDK — api.stripe.com speaks form-encoded HTTP and WebCrypto
 * verifies webhook signatures; zero deps keeps the deploy surface clean.
 *
 * Endpoints:
 *   GET  /pay/config                       → public package/plan catalog
 *   POST /pay/checkout {accountId,kind,…}  → Stripe Checkout Session url
 *   POST /pay/webhook                      → Stripe event intake (signed)
 *   GET  /pay/account?account=             → balance + subscription state
 *   POST /pay/portal   {accountId}         → Stripe Billing Portal url
 *   POST /pay/convert  {accountId,room,seconds} → acct→room credit move
 *   POST /pay/sponsor  {room,accountId,on} → host covers this circle
 */

export interface Env {
	METER?: DurableObjectNamespace;
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	APP_ORIGIN?: string;
	PAY_PACKAGES?: string;
	PAY_SUB?: string;
}

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'cache-control': 'no-store'
};

interface Pack {
	id: string;
	label: string;
	seconds: number;
	priceId: string;
	amountCents?: number;
	currency?: string;
}
interface SubPlan {
	priceId: string;
	seconds: number;
	label: string;
	amountCents?: number;
	currency?: string;
}

const ACCOUNT_RE = /^[0-9a-f]{16,128}$/i;
const ROOM_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SIG_TOLERANCE_S = 300;

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
		const url = new URL(req.url);
		try {
			if (url.pathname === '/pay/config' && req.method === 'GET')
				return json({ packages: packs(env), subscription: subPlan(env) });
			if (url.pathname === '/pay/checkout' && req.method === 'POST')
				return await checkout(req, env);
			if (url.pathname === '/pay/webhook' && req.method === 'POST')
				return await webhook(req, env);
			if (url.pathname === '/pay/account' && req.method === 'GET')
				return await accountInfo(url, env);
			if (url.pathname === '/pay/portal' && req.method === 'POST')
				return await portal(req, env);
			if (url.pathname === '/pay/convert' && req.method === 'POST')
				return await convert(req, env);
			if (url.pathname === '/pay/sponsor' && req.method === 'POST')
				return await sponsor(req, env);
			if (url.pathname === '/pay/status' && req.method === 'GET')
				return json({ ok: true, stripe: !!env.STRIPE_SECRET_KEY, meter: !!env.METER });
			return json({ error: 'not found' }, 404);
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : 'internal' }, 502);
		}
	}
};

// ------------------------------------------------------------- config

function packs(env: Env): Pack[] {
	try {
		return JSON.parse(env.PAY_PACKAGES ?? '[]') as Pack[];
	} catch {
		return [];
	}
}
function subPlan(env: Env): SubPlan | null {
	try {
		return env.PAY_SUB ? (JSON.parse(env.PAY_SUB) as SubPlan) : null;
	} catch {
		return null;
	}
}
function origin(env: Env): string {
	return env.APP_ORIGIN ?? 'https://circle-engine-7ny.pages.dev';
}

// ------------------------------------------------------------- checkout

/**
 * POST /pay/checkout {accountId, kind:'pack'|'sub'|'room', packId?, room?}
 * → {url} — redirect the user to Stripe Checkout. Seconds land via webhook.
 * kind 'room' tops a room pool directly; 'pack'/'sub' fund the account wallet.
 */
async function checkout(req: Request, env: Env): Promise<Response> {
	if (!env.STRIPE_SECRET_KEY) return json({ error: 'payments unconfigured' }, 503);
	const { accountId, kind, packId, room, seconds } = (await req.json()) as {
		accountId?: string;
		kind?: string;
		packId?: string;
		room?: string;
		seconds?: number;
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);

	const base = origin(env);
	const p: Record<string, string> = {
		client_reference_id: accountId,
		'metadata[accountId]': accountId,
		success_url: `${base}/billing?checkout=ok&session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${base}/billing?checkout=canceled`,
		allow_promotion_codes: 'true'
	};

	if (kind === 'sub') {
		const sub = subPlan(env);
		if (!sub) return json({ error: 'no subscription plan configured' }, 503);
		p.mode = 'subscription';
		p['line_items[0][price]'] = sub.priceId;
		p['line_items[0][quantity]'] = '1';
		p['metadata[kind]'] = 'sub';
		p['subscription_data[metadata][accountId]'] = accountId;
	} else if (kind === 'pack' || kind === 'room') {
		const pack = packs(env).find((x) => x.id === packId);
		if (!pack) return json({ error: 'unknown pack' }, 400);
		if (kind === 'room' && (!room || !ROOM_RE.test(room)))
			return json({ error: 'room required' }, 400);
		p.mode = 'payment';
		p['line_items[0][price]'] = pack.priceId;
		p['line_items[0][quantity]'] = '1';
		p.customer_creation = 'always';
		p['metadata[kind]'] = kind;
		p['metadata[seconds]'] = String(Math.round(seconds ?? pack.seconds));
		if (room) p['metadata[room]'] = room;
		// refunds/disputes resolve back to the account via the PI's metadata
		p['payment_intent_data[metadata][accountId]'] = accountId;
		p['payment_intent_data[metadata][seconds]'] = p['metadata[seconds]'];
	} else {
		return json({ error: 'kind must be pack | sub | room' }, 400);
	}

	const res = await stripe(env, '/checkout/sessions', p);
	const body = (await res.json()) as { url?: string; error?: { message?: string } };
	if (!res.ok || !body.url) return json({ error: body.error?.message ?? 'checkout failed' }, 502);
	return json({ url: body.url });
}

// ------------------------------------------------------------- portal

/** POST /pay/portal {accountId} → Stripe Billing Portal session url */
async function portal(req: Request, env: Env): Promise<Response> {
	if (!env.STRIPE_SECRET_KEY) return json({ error: 'payments unconfigured' }, 503);
	const { accountId } = (await req.json()) as { accountId?: string };
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	const customer = await kvget(env, `acct:${accountId}`, 'customer');
	if (!customer) return json({ error: 'no billing customer for this account' }, 404);
	const res = await stripe(env, '/billing_portal/sessions', {
		customer: String(customer),
		return_url: `${origin(env)}/billing`
	});
	const body = (await res.json()) as { url?: string; error?: { message?: string } };
	if (!res.ok || !body.url) return json({ error: body.error?.message ?? 'portal failed' }, 502);
	return json({ url: body.url });
}

// ------------------------------------------------------------- wallet ops

/** POST /pay/convert {accountId, room, seconds} — move wallet seconds into a
 *  room pool. Atomic on the acct instance (conditional debit + credit staged
 *  in one DO turn); {status:'insufficient'} when the wallet can't cover it. */
async function convert(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const { accountId, room, seconds } = (await req.json()) as {
		accountId?: string;
		room?: string;
		seconds?: number;
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	if (!room || !ROOM_RE.test(room)) return json({ error: 'room required' }, 400);
	const amount = Math.round(seconds ?? 0);
	if (amount <= 0 || amount > 86_400_000) return json({ error: 'seconds out of range' }, 400);
	const res = await meter(env, `acct:${accountId}`, 'transfer', { to: room, amount });
	const body = (await res.json()) as {
		ok?: boolean;
		status?: string;
		available?: number;
		balanceSeconds?: number;
	};
	if (!body.ok) {
		return json(
			body.available === 0
				? { status: 'no_paid_funding' }
				: { status: 'insufficient', credits: amount, available: body.available ?? 0 },
			402
		);
	}
	return json({ status: 'purchased', seconds: amount, balance: body.balanceSeconds ?? 0 });
}

/** POST /pay/sponsor {room, accountId, on} — host covers the whole circle's
 *  paid lanes from their wallet. Only a funded account may sponsor. */
async function sponsor(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const { room, accountId, on } = (await req.json()) as {
		room?: string;
		accountId?: string;
		on?: boolean;
	};
	if (!room || !ROOM_RE.test(room)) return json({ error: 'room required' }, 400);
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	if (on) {
		const bal = await meter(env, `acct:${accountId}`, 'get', {});
		const b = (await bal.json()) as { balanceSeconds?: number };
		if (!b.balanceSeconds || b.balanceSeconds <= 0)
			return json({ error: 'no funded balance to sponsor with' }, 402);
	}
	await meter(env, room, 'sponsor', { account: on ? accountId : null });
	await kvput(env, `acct:${accountId}`, `sponsored:${room}`, on === true);
	return json({ ok: true, sponsoring: on === true });
}

/** GET /pay/account?account= → wallet + subscription + sponsored rooms */
async function accountInfo(url: URL, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const account = url.searchParams.get('account');
	if (!account || !ACCOUNT_RE.test(account)) return json({ error: 'account required' }, 400);
	const inst = `acct:${account}`;
	const bal = await meter(env, inst, 'get', {});
	const b = (await bal.json()) as { balanceSeconds?: number; spentSeconds?: number };
	const sub = await kvget(env, inst, 'sub');
	const customer = await kvget(env, inst, 'customer');
	const sponsored = (await kvlist(env, inst, 'sponsored:')) as Record<string, unknown>;
	return json({
		accountId: account,
		balanceSeconds: b.balanceSeconds ?? 0,
		spentSeconds: b.spentSeconds ?? 0,
		subscription: sub ?? null,
		customerId: customer ?? null,
		sponsoredRooms: Object.keys(sponsored)
			.filter((k) => sponsored[k] === true)
			.map((k) => k.slice('sponsored:'.length))
	});
}

// ------------------------------------------------------------- webhook

/**
 * POST /pay/webhook — Stripe event intake. Signature-verified, deduped on
 * event.id, and only then dispatched. Never credits on the client redirect —
 * settlement is exclusively webhook-driven.
 */
async function webhook(req: Request, env: Env): Promise<Response> {
	if (!env.STRIPE_WEBHOOK_SECRET || !env.METER)
		return json({ error: 'webhook unconfigured' }, 503);
	const raw = await req.text();
	const ok = await verifyStripeSignature(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
	if (!ok) return json({ error: 'bad signature' }, 400);
	const evt = JSON.parse(raw) as { id?: string; type?: string; data?: { object?: unknown } };
	if (!evt.id || !evt.type) return json({ error: 'bad event' }, 400);

	// replay guard — first claim wins, forever
	const claim = await meter(env, `evt:${evt.id}`, 'claim', { nonce: evt.id });
	if (!claim.ok) return json({ received: true, duplicate: true });

	await handleEvent(env, evt.type, (evt.data?.object ?? {}) as Record<string, unknown>);
	return json({ received: true });
}

export async function verifyStripeSignature(
	raw: string,
	header: string | null,
	secret: string,
	nowS = Math.floor(Date.now() / 1000)
): Promise<boolean> {
	if (!header || !secret) return false;
	let t = '';
	const v1s: string[] = [];
	for (const part of header.split(',')) {
		const [k, v] = part.split('=');
		if (k === 't') t = v;
		else if (k === 'v1') v1s.push(v);
	}
	if (!t || !v1s.length) return false;
	if (Math.abs(nowS - Number(t)) > SIG_TOLERANCE_S) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`));
	const expected = toHex(new Uint8Array(mac));
	return v1s.some((v1) => timingSafeEqual(expected, v1));
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function handleEvent(
	env: Env,
	type: string,
	obj: Record<string, unknown>
): Promise<void> {
	const meta = (obj.metadata ?? {}) as Record<string, string>;

	if (type === 'checkout.session.completed') {
		const accountId = meta.accountId ?? (obj.client_reference_id as string | undefined);
		if (accountId && obj.customer)
			await linkCustomer(env, accountId, String(obj.customer), String(obj.subscription ?? ''));
		if (obj.mode === 'subscription') return; // allotments credit on invoice.paid
		const seconds = Math.round(Number(meta.seconds ?? 0));
		if (!accountId || seconds <= 0) return;
		const target = meta.kind === 'room' && meta.room ? meta.room : `acct:${accountId}`;
		await meter(env, target, 'credit', { amount: seconds });
		await kvput(env, `acct:${accountId}`, 'lastPurchase', { seconds, at: Date.now() });
		return;
	}

	if (type === 'invoice.paid') {
		const sub = subPlan(env);
		const subscription = String(obj.subscription ?? '');
		if (!sub || !subscription) return;
		const reason = String(obj.billing_reason ?? '');
		if (reason !== 'subscription_create' && reason !== 'subscription_cycle') return;
		const accountId = meta.accountId ?? (await resolveAccount(env, String(obj.customer ?? '')));
		if (!accountId) return;
		// belt-and-suspenders on top of event.id dedupe: one credit per invoice
		const lastInvoice = await kvget(env, `acct:${accountId}`, 'lastInvoice');
		if (lastInvoice === obj.id) return;
		await kvput(env, `acct:${accountId}`, 'lastInvoice', obj.id);
		await meter(env, `acct:${accountId}`, 'credit', { amount: sub.seconds });
		return;
	}

	if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
		const accountId = meta.accountId ?? (await resolveAccount(env, String(obj.customer ?? '')));
		if (!accountId) return;
		const items = (obj.items as { data?: { price?: { id?: string } }[] } | undefined)?.data;
		await kvput(env, `acct:${accountId}`, 'sub', {
			id: obj.id,
			status: obj.status,
			priceId: items?.[0]?.price?.id ?? null,
			cancelAtPeriodEnd: obj.cancel_at_period_end === true,
			currentPeriodEnd: typeof obj.current_period_end === 'number' ? obj.current_period_end * 1000 : null,
			at: Date.now()
		});
		return;
	}

	if (type === 'charge.refunded' || type === 'charge.dispute.created') {
		// clamp-debit the previously credited seconds (MeterBus floors at 0)
		let m = meta;
		if (!m.accountId && obj.id && env.STRIPE_SECRET_KEY) {
			const res = await fetch(`https://api.stripe.com/v1/charges/${obj.id}`, {
				headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
			});
			const ch = (await res.json()) as { metadata?: Record<string, string> };
			m = ch.metadata ?? {};
		}
		const accountId = m.accountId;
		const seconds = Math.round(Number(m.seconds ?? 0));
		if (!accountId || seconds <= 0) return;
		await meter(env, `acct:${accountId}`, 'debit', { amount: seconds });
		await kvput(env, `acct:${accountId}`, 'lastChargeback', { seconds, type, at: Date.now() });
		return;
	}
}

async function linkCustomer(env: Env, accountId: string, customer: string, subscription: string): Promise<void> {
	await kvput(env, `cust:${customer}`, 'accountId', accountId);
	await kvput(env, `acct:${accountId}`, 'customer', customer);
	if (subscription) await kvput(env, `acct:${accountId}`, 'subscriptionId', subscription);
}

async function resolveAccount(env: Env, customer: string): Promise<string | null> {
	if (!customer) return null;
	const v = await kvget(env, `cust:${customer}`, 'accountId');
	return typeof v === 'string' ? v : null;
}

// ------------------------------------------------------------- plumbing

async function stripe(env: Env, path: string, params: Record<string, string>): Promise<Response> {
	return fetch(`https://api.stripe.com/v1${path}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams(params)
	});
}

function meter(env: Env, instance: string, op: string, body: object): Promise<Response> {
	const stub = env.METER!.get(env.METER!.idFromName(instance));
	return stub.fetch(`https://meter/${op}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function kvget(env: Env, instance: string, key: string): Promise<unknown> {
	const res = await meter(env, instance, 'kvget', { key });
	return ((await res.json()) as { value?: unknown }).value ?? null;
}
async function kvput(env: Env, instance: string, key: string, value: unknown): Promise<void> {
	await meter(env, instance, 'kvput', { key, value });
}
async function kvlist(env: Env, instance: string, prefix: string): Promise<Record<string, unknown>> {
	const res = await meter(env, instance, 'kvlist', { prefix });
	return ((await res.json()) as { items?: Record<string, unknown> }).items ?? {};
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'content-type': 'application/json' }
	});
}
