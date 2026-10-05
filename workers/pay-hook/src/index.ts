/**
 * cic-pay-hook — the isolated Stripe-touching worker (Cloudflare Worker).
 *
 * This is the ONLY worker holding Stripe secrets, and the only one that
 * needs them:
 *   STRIPE_READ_KEY       — rk_… restricted key scoped to READ-ONLY
 *                           (Events:read, Checkout Sessions:read,
 *                           Charges:read). It cannot charge cards, create
 *                           checkout or portal sessions, refund, or touch
 *                           payouts — the capability physically does not
 *                           exist on this key.
 *   STRIPE_WEBHOOK_SECRET — whsec_… for /pay-hook/webhook intake.
 *   PAY_PORTAL_LINK       — Stripe's hosted portal login URL
 *                           (https://billing.stripe.com/p/login/…);
 *                           customers authenticate by email OTP, so no
 *                           portal-session API capability is needed.
 *   METER_TOKEN           — 'settle' role: credits + bounded clawback
 *                           debits + settlement-record writes. No sponsor,
 *                           no transfer, no unsigned wallet spend.
 *
 * Blast radius if THIS worker is compromised: it can fabricate wallet
 * credits (free service credit — MeterBus debits still require device
 * signatures, sponsorship, or a bounded clawback) and nothing else. No
 * card data, no charges, no sessions, no payout path.
 *
 * cic-pay keeps /pay/webhook and /pay/portal as forwarders so the Stripe
 * dashboard endpoint and client contract don't change.
 *
 * Endpoints:
 *   POST /pay-hook/webhook → Stripe event intake (signed + re-verified)
 *   POST /pay-hook/portal  → Stripe Billing Portal url (signed + step-up)
 *   GET  /pay-hook/status  → configured? (keyType visibility for ops)
 */

export interface Env {
	METER?: DurableObjectNamespace;
	STRIPE_READ_KEY?: string; // rk_… — read-only scopes only
	STRIPE_WEBHOOK_SECRET?: string;
	PAY_PORTAL_LINK?: string; // hosted billing-portal login URL (email OTP)
	APP_ORIGIN?: string;
	PAY_PACKAGES?: string;
	PAY_SUB?: string;
	METER_TOKEN?: string; // settle-role capability token for MeterBus
}

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers':
		'content-type, x-cic-account, x-cic-pub, x-cic-ts, x-cic-nonce, x-cic-sig',
	'cache-control': 'no-store'
};

interface Pack {
	id: string;
	priceId: string;
	seconds: number;
}
interface SubPlan {
	priceId: string;
	seconds: number;
}

const ACCOUNT_RE = /^[0-9a-f]{16,128}$/i;
const SIG_TOLERANCE_S = 300;
const SIG_WINDOW_S = 300;
const STEP_UP_OPS = new Set(['portal']);

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
		const url = new URL(req.url);
		try {
			if (url.pathname === '/pay-hook/webhook' && req.method === 'POST')
				return await webhook(req, env);
			if (url.pathname === '/pay-hook/portal' && req.method === 'POST')
				return await portal(req, env);
			if (url.pathname === '/pay-hook/status' && req.method === 'GET')
				return json({
					ok: true,
					readKey: env.STRIPE_READ_KEY?.startsWith('rk_') ? 'restricted' : env.STRIPE_READ_KEY ? 'UNSAFE-FULL' : 'none',
					webhook: !!env.STRIPE_WEBHOOK_SECRET,
					portal: !!env.PAY_PORTAL_LINK,
					meter: !!env.METER,
					meterToken: !!env.METER_TOKEN
				});
			return json({ error: 'not found' }, 404);
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : 'internal' }, 502);
		}
	}
};

// ------------------------------------------------------------- webhook

/**
 * POST /pay-hook/webhook — Stripe event intake. Signature-verified, the
 * event is re-fetched from the API (a leaked whsec_ alone mints nothing),
 * deduped on event.id, then settled into MeterBus via the settle role.
 */
async function webhook(req: Request, env: Env): Promise<Response> {
	if (!env.STRIPE_WEBHOOK_SECRET || !env.METER)
		return json({ error: 'webhook unconfigured' }, 503);
	const raw = await req.text();
	const ok = await verifyStripeSignature(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
	if (!ok) return json({ error: 'bad signature' }, 400);
	const evt = JSON.parse(raw) as { id?: string; type?: string; data?: { object?: { id?: string } } };
	if (!evt.id || !evt.type) return json({ error: 'bad event' }, 400);

	// Anti-forgery: re-fetch the event from Stripe with the read-only key —
	// fabricated ids 404, tampered payloads mismatch data.object.id. Done
	// BEFORE the dedupe claim so a forgery can't burn a real event's slot.
	if (env.STRIPE_READ_KEY) {
		const real = (await stripeGet(env, `/events/${encodeURIComponent(evt.id)}`)) as {
			id?: string;
			type?: string;
			data?: { object?: { id?: string } };
		} | null;
		if (!real || real.id !== evt.id || real.type !== evt.type || real.data?.object?.id !== evt.data?.object?.id)
			return json({ error: 'event not verifiable' }, 400);
	}

	// replay guard — first claim wins, forever
	const claim = await meter(env, `evt:${evt.id}`, 'claim', { nonce: evt.id });
	if (!claim.ok) return json({ received: true, duplicate: true });

	await handleEvent(env, evt.type, (evt.data?.object ?? {}) as Record<string, unknown>, evt.id);
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

/** price id → seconds, resolved against PAY_PACKAGES/PAY_SUB config */
function secondsForPrice(env: Env, priceId: string | undefined): number {
	if (!priceId) return 0;
	try {
		const sub = env.PAY_SUB ? (JSON.parse(env.PAY_SUB) as SubPlan) : null;
		if (sub?.priceId === priceId) return sub.seconds;
	} catch { /* ignore */ }
	try {
		const p = (JSON.parse(env.PAY_PACKAGES ?? '[]') as Pack[]).find((x) => x.priceId === priceId);
		if (p) return p.seconds;
	} catch { /* ignore */ }
	return 0;
}

/** the checkout session's first line-item price (Payment-Link purchases
 *  carry no per-session metadata — the bought price is the source of
 *  truth for how many seconds the event settles) */
async function sessionPriceId(env: Env, sessionId: string): Promise<string | undefined> {
	const li = (await stripeGet(env, `/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=1`)) as {
		data?: { price?: { id?: string } }[];
	} | null;
	return li?.data?.[0]?.price?.id;
}

export async function handleEvent(
	env: Env,
	type: string,
	obj: Record<string, unknown>,
	evtId?: string
): Promise<void> {
	const meta = (obj.metadata ?? {}) as Record<string, string>;
	// linkable id for the credit record — clawback debits must name a
	// credit they unwind, so a forged settlement can't drain wallets
	const creditId = obj.payment_intent
		? `pi:${obj.payment_intent}`
		: `tx:${evtId ?? String(obj.id ?? '')}`;

	if (type === 'checkout.session.completed') {
		// client_reference_id carries the settlement target from the Payment
		// Link URL: '<accountId>' (wallet/pack) or '<accountId>:<room>'
		const ref = String(obj.client_reference_id ?? '');
		const [accountId, room] = ref.split(':');
		const metaAcct = meta.accountId;
		const acct = metaAcct || (ACCOUNT_RE.test(accountId) ? accountId : '');
		if (acct && obj.customer)
			await linkCustomer(env, acct, String(obj.customer), String(obj.subscription ?? ''));
		if (obj.mode === 'subscription') return; // allotments credit on invoice.paid
		const seconds =
			Math.round(Number(meta.seconds ?? 0)) ||
			(await secondsForPrice(env, await sessionPriceId(env, String(obj.id ?? ''))));
		if (!acct || seconds <= 0) return;
		const target = room ? room : `acct:${acct}`;
		await meter(env, target, 'credit', { amount: seconds, creditId, room });
		await kvput(env, `acct:${acct}`, 'lastPurchase', { seconds, at: Date.now() });
		return;
	}

	if (type === 'invoice.paid') {
		const reason = String(obj.billing_reason ?? '');
		if (reason !== 'subscription_create' && reason !== 'subscription_cycle') return;
		const accountId = meta.accountId ?? (await resolveAccount(env, String(obj.customer ?? '')));
		if (!accountId) return;
		const lines = (obj.lines as { data?: { price?: { id?: string } }[] } | undefined)?.data;
		const seconds = secondsForPrice(env, lines?.[0]?.price?.id) ||
			(() => { try { return (JSON.parse(env.PAY_SUB ?? '{}') as SubPlan).seconds ?? 0; } catch { return 0; } })();
		if (seconds <= 0) return;
		// belt-and-suspenders on top of event.id dedupe: one credit per invoice
		const lastInvoice = await kvget(env, `acct:${accountId}`, 'lastInvoice');
		if (lastInvoice === obj.id) return;
		await kvput(env, `acct:${accountId}`, 'lastInvoice', obj.id);
		await meter(env, `acct:${accountId}`, 'credit', { amount: seconds, creditId });
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
		// bounded clawback: resolve the account via the charge's customer,
		// debit at most what the recorded credit:<pi> added — the DO enforces
		// the bound even if this worker lies about the amount
		let accountId = meta.accountId;
		let pi = obj.payment_intent as string | undefined;
		if ((!accountId || !pi) && obj.id && env.STRIPE_READ_KEY) {
			const ch = (await stripeGet(env, `/charges/${obj.id}`)) as {
				metadata?: Record<string, string>;
				customer?: string;
				payment_intent?: string;
			} | null;
			accountId = accountId ?? ch?.metadata?.accountId;
			pi = pi ?? ch?.payment_intent;
			if (!accountId && ch?.customer) accountId = (await resolveAccount(env, ch.customer)) ?? undefined;
		}
		if (!accountId) return;
		const clawbackOf = pi ? `pi:${pi}` : `tx:${evtId ?? String(obj.id)}`;
		// amount is bounded by the DO to the recorded credit — ask for the
		// max and let MeterBus clamp; kvget first so the audit trail is exact
		const credited = ((await kvget(env, `acct:${accountId}`, `credit:${clawbackOf}`)) as number) ?? 0;
		const clawed = ((await kvget(env, `acct:${accountId}`, `clawed:${clawbackOf}`)) as number) ?? 0;
		const remaining = credited - clawed;
		if (remaining <= 0) return;
		await meter(env, `acct:${accountId}`, 'debit', { amount: remaining, clawbackOf });
		await kvput(env, `acct:${accountId}`, 'lastChargeback', { seconds: remaining, type, at: Date.now() });
		return;
	}
}

async function linkCustomer(env: Env, accountId: string, customer: string, subscription: string): Promise<void> {
	// first binding wins — enforced inside MeterBus on both cust:* and
	// acct:* 'customer' records, so a compromised settle worker can't re-map
	const existing = await kvget(env, `acct:${accountId}`, 'customer');
	if (existing && existing !== customer) return;
	await kvput(env, `cust:${customer}`, 'accountId', accountId);
	await kvput(env, `acct:${accountId}`, 'customer', customer);
	if (subscription) await kvput(env, `acct:${accountId}`, 'subscriptionId', subscription);
}

async function resolveAccount(env: Env, customer: string): Promise<string | null> {
	if (!customer) return null;
	const v = await kvget(env, `cust:${customer}`, 'accountId');
	return typeof v === 'string' ? v : null;
}

// ------------------------------------------------------------- portal

/**
 * POST /pay-hook/portal — forwarded verbatim from cic-pay's /pay/portal
 * (the client signed the canonical path '/pay/portal'). Verified here —
 * this worker trusts the signature, not the forwarding worker. Returns
 * Stripe's hosted portal login link: the customer authenticates with an
 * email OTP on Stripe's domain, so no portal-session API capability is
 * needed anywhere in our infrastructure.
 */
async function portal(req: Request, env: Env): Promise<Response> {
	if (!env.PAY_PORTAL_LINK) return json({ error: 'portal unconfigured' }, 503);
	const raw = await req.text();
	const { accountId, webauthn } = JSON.parse(raw || '{}') as {
		accountId?: string;
		webauthn?: Parameters<typeof verifyPasskey>[2];
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	const auth = await authorize(env, req, '/pay/portal', raw, accountId);
	if (auth instanceof Response) return auth;
	const step = await needStepUp(env, accountId, 'portal', webauthn);
	if (step) return step;
	const customer = await kvget(env, `acct:${accountId}`, 'customer');
	if (!customer) return json({ error: 'no billing customer for this account' }, 404);
	await meter(env, `acct:${accountId}`, 'audit', {
		entry: { op: 'portal', device: auth.keyHash.slice(0, 8), at: Date.now() }
	});
	return json({ url: env.PAY_PORTAL_LINK });
}

// ------------------------------------------------------------- auth
// (same canonical signed-request verification as cic-pay — duplicated so
//  this worker never trusts a forwarder's verification)

interface AuthResult {
	keyHash: string;
}

function hexBytes(hex: string): Uint8Array | null {
	if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

async function sha256hex(buf: Uint8Array | string): Promise<string> {
	const data = typeof buf === 'string' ? new TextEncoder().encode(buf) : buf;
	return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}

export async function authorize(
	env: Env,
	req: Request,
	path: string,
	rawBody: string,
	claimed: string
): Promise<AuthResult | Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const pubHex = req.headers.get('x-cic-pub');
	const ts = Number(req.headers.get('x-cic-ts'));
	const nonce = req.headers.get('x-cic-nonce');
	const sigHex = req.headers.get('x-cic-sig');
	if (!pubHex || !ts || !nonce || !sigHex) return json({ error: 'signature required' }, 401);
	if (Math.abs(Math.floor(Date.now() / 1000) - ts) > SIG_WINDOW_S)
		return json({ error: 'stale signature' }, 401);
	const pub = hexBytes(pubHex);
	const sig = hexBytes(sigHex);
	if (!pub || !sig) return json({ error: 'bad signature headers' }, 401);

	const keyHash = await sha256hex(pub);
	// primary key self-certifies; delegates need a registered key record
	if (keyHash !== claimed) {
		const reg = await kvget(env, `acct:${claimed}`, `key:${keyHash}`);
		if (!reg) return json({ error: 'key not authorized for account' }, 401);
	}
	const key = await crypto.subtle.importKey(
		'spki',
		pub as BufferSource,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['verify']
	).catch(() => null);
	if (!key) return json({ error: 'bad key' }, 401);
	const bodyHash = await sha256hex(rawBody);
	const payload = [claimed, req.method.toUpperCase(), path, bodyHash, String(ts), nonce, keyHash].join('\n');
	const ok = await crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		sig as BufferSource,
		new TextEncoder().encode(payload)
	);
	if (!ok) return json({ error: 'bad signature' }, 401);
	// replay guard — nonce claims once on the account instance
	const claim = await meter(env, `acct:${claimed}`, 'claim', { nonce: `req:${nonce}` });
	if (!claim.ok) return json({ error: 'replayed nonce' }, 409);
	return { keyHash };
}

// ------------------------------------------------------------- passkeys

async function passkeyList(env: Env, accountId: string): Promise<Record<string, unknown>> {
	return kvlist(env, `acct:${accountId}`, 'passkey:');
}

function derToP1363(der: Uint8Array): Uint8Array | null {
	if (der[0] !== 0x30) return null;
	let i = 2;
	if (der[1] & 0x80) i += der[1] & 0x7f;
	const readInt = () => {
		if (der[i] !== 0x02) return null;
		const len = der[i + 1];
		const v = der.slice(i + 2, i + 2 + len);
		i += 2 + len;
		return v.length > 33 ? null : v;
	};
	const r = readInt();
	const s = readInt();
	if (!r || !s) return null;
	const out = new Uint8Array(64);
	out.set(r.length > 32 ? r.slice(r.length - 32) : r, 32 - Math.min(32, r.length));
	out.set(s.length > 32 ? s.slice(s.length - 32) : s, 64 - Math.min(32, s.length));
	return out;
}

export async function verifyPasskey(
	env: Env,
	accountId: string,
	assertion: {
		credId?: string;
		authenticatorData?: string;
		clientDataJSON?: string;
		signature?: string;
	} | undefined
): Promise<boolean> {
	if (!assertion?.credId || !assertion.authenticatorData || !assertion.clientDataJSON || !assertion.signature)
		return false;
	const cred = (await kvget(env, `acct:${accountId}`, `passkey:${assertion.credId}`)) as
		| { pubSpki?: string; signCount?: number }
		| null;
	if (!cred?.pubSpki) return false;
	const b64 = (s: string) =>
		Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
	const authData = b64(assertion.authenticatorData);
	const clientData = b64(assertion.clientDataJSON);
	const sig = derToP1363(b64(assertion.signature));
	if (!sig || authData.length < 37) return false;
	const flags = authData[32];
	if (!(flags & 0x01)) return false;
	const rpOk = await Promise.all(
		[new URL(origin(env)).hostname, 'localhost'].map(
			async (rp) => (await sha256hex(rp)) === toHex(authData.slice(0, 32))
		)
	);
	if (!rpOk.some(Boolean)) return false;
	const parsed = JSON.parse(new TextDecoder().decode(clientData)) as {
		type?: string;
		challenge?: string;
	};
	if (parsed.type !== 'webauthn.get' || !parsed.challenge) return false;
	const issued = await kvget(env, `acct:${accountId}`, `chal:${parsed.challenge}`);
	if (!issued) return false;
	await kvput(env, `acct:${accountId}`, `chal:${parsed.challenge}`, null);
	const pub = hexBytes(String(cred.pubSpki));
	if (!pub) return false;
	const key = await crypto.subtle.importKey(
		'spki',
		pub as BufferSource,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['verify']
	);
	const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData as BufferSource));
	const signed = new Uint8Array(authData.length + cdHash.length);
	signed.set(authData);
	signed.set(cdHash, authData.length);
	const ok = await crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		sig as BufferSource,
		signed
	);
	if (!ok) return false;
	const count = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
	if (count > 0) {
		if (count <= (cred.signCount ?? 0)) return false;
		await kvput(env, `acct:${accountId}`, `passkey:${assertion.credId}`, { ...cred, signCount: count });
	}
	return true;
}

async function needStepUp(
	env: Env,
	accountId: string,
	op: string,
	webauthn: unknown
): Promise<Response | null> {
	const enrolled = Object.keys(await passkeyList(env, accountId)).length > 0;
	if (!enrolled || !STEP_UP_OPS.has(op)) return null;
	const ok = await verifyPasskey(env, accountId, webauthn as Parameters<typeof verifyPasskey>[2]);
	return ok ? null : json({ error: 'passkey assertion required' }, 428);
}

// ------------------------------------------------------------- plumbing

async function stripeGet(env: Env, path: string): Promise<unknown | null> {
	const res = await fetch(`https://api.stripe.com/v1${path}`, {
		headers: { authorization: `Bearer ${env.STRIPE_READ_KEY}` }
	});
	if (!res.ok) return null;
	return res.json();
}

function meter(env: Env, instance: string, op: string, body: object): Promise<Response> {
	const stub = env.METER!.get(env.METER!.idFromName(instance));
	return stub.fetch(`https://meter/${op}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-meter-token': env.METER_TOKEN ?? ''
		},
		body: JSON.stringify({ ...body, inst: instance })
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

function origin(env: Env): string {
	return env.APP_ORIGIN ?? 'https://circle-engine-7ny.pages.dev';
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
