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
	METER_TOKEN?: string; // admin-role capability token for MeterBus ops
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
				return await accountInfo(req, env);
			if (url.pathname === '/pay/portal' && req.method === 'POST')
				return await portal(req, env);
			if (url.pathname === '/pay/convert' && req.method === 'POST')
				return await convert(req, env);
			if (url.pathname === '/pay/sponsor' && req.method === 'POST')
				return await sponsor(req, env);
			if (url.pathname === '/pay/challenge' && req.method === 'POST')
				return await challenge(req, env);
			if (url.pathname === '/pay/passkey-register' && req.method === 'POST')
				return await passkeyRegister(req, env);
			if (url.pathname === '/pay/link-begin' && req.method === 'POST')
				return await linkBegin(req, env);
			if (url.pathname === '/pay/link-status' && req.method === 'GET')
				return await linkStatus(url, env);
			if (url.pathname === '/pay/link-approve' && req.method === 'POST')
				return await linkApprove(req, env);
			if (url.pathname === '/pay/revoke' && req.method === 'POST')
				return await revoke(req, env);
			if (url.pathname === '/pay/limits' && req.method === 'POST')
				return await limits(req, env);
			if (url.pathname === '/pay/status' && req.method === 'GET')
				return json({
					ok: true,
					stripe: !!env.STRIPE_SECRET_KEY,
					// rk_* restricted keys can't charge saved cards — full sk_*
					// keys work but widen the leak blast radius; see DEPLOYMENT.md
					keyType: env.STRIPE_SECRET_KEY
						? env.STRIPE_SECRET_KEY.startsWith('rk_')
							? 'restricted'
							: 'full'
						: 'none',
					meter: !!env.METER,
					meterToken: !!env.METER_TOKEN
				});
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

/** POST /pay/portal {accountId, webauthn?} → Stripe Billing Portal session url.
 *  Signed; passkey-asserted when the account has one enrolled. */
async function portal(req: Request, env: Env): Promise<Response> {
	if (!env.STRIPE_SECRET_KEY) return json({ error: 'payments unconfigured' }, 503);
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
	const res = await stripe(env, '/billing_portal/sessions', {
		customer: String(customer),
		return_url: `${origin(env)}/billing`
	});
	const body = (await res.json()) as { url?: string; error?: { message?: string } };
	if (!res.ok || !body.url) return json({ error: body.error?.message ?? 'portal failed' }, 502);
	await audit(env, accountId, auth.keyHash, 'portal');
	return json({ url: body.url });
}

// ------------------------------------------------------------- wallet ops

/** POST /pay/convert {accountId, room, seconds} — move wallet seconds into a
 *  room pool. Atomic on the acct instance (conditional debit + credit staged
 *  in one DO turn); {status:'insufficient'} when the wallet can't cover it. */
async function convert(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const raw = await req.text();
	const { accountId, room, seconds, webauthn } = JSON.parse(raw || '{}') as {
		accountId?: string;
		room?: string;
		seconds?: number;
		webauthn?: Parameters<typeof verifyPasskey>[2];
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	if (!room || !ROOM_RE.test(room)) return json({ error: 'room required' }, 400);
	const amount = Math.round(seconds ?? 0);
	if (amount <= 0 || amount > 86_400_000) return json({ error: 'seconds out of range' }, 400);
	const auth = await authorize(env, req, '/pay/convert', raw, accountId);
	if (auth instanceof Response) return auth;
	const step = await needStepUp(env, accountId, 'convert', webauthn, amount);
	if (step) return step;
	const res = await meter(env, `acct:${accountId}`, 'transfer', {
		to: room,
		amount,
		auth: auth.forward
	});
	const body = (await res.json()) as {
		ok?: boolean;
		status?: string;
		available?: number;
		balanceSeconds?: number;
	};
	if (!body.ok) {
		if (body.status === 'cap')
			return json({ status: 'insufficient', credits: amount, available: 0 }, 402);
		return json(
			body.available === 0
				? { status: 'no_paid_funding' }
				: { status: 'insufficient', credits: amount, available: body.available ?? 0 },
			402
		);
	}
	await audit(env, accountId, auth.keyHash, 'convert', `${amount}s → ${room}`);
	return json({ status: 'purchased', seconds: amount, balance: body.balanceSeconds ?? 0 });
}

/** POST /pay/sponsor {room, accountId, on} — host covers the whole circle's
 *  paid lanes from their wallet. Only a funded account may sponsor. */
async function sponsor(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const raw = await req.text();
	const { room, accountId, on } = JSON.parse(raw || '{}') as {
		room?: string;
		accountId?: string;
		on?: boolean;
	};
	if (!room || !ROOM_RE.test(room)) return json({ error: 'room required' }, 400);
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	const auth = await authorize(env, req, '/pay/sponsor', raw, accountId);
	if (auth instanceof Response) return auth;
	if (on) {
		const bal = await meter(env, `acct:${accountId}`, 'get', {});
		const b = (await bal.json()) as { balanceSeconds?: number };
		if (!b.balanceSeconds || b.balanceSeconds <= 0)
			return json({ error: 'no funded balance to sponsor with' }, 402);
	}
	await meter(env, room, 'sponsor', { account: on ? accountId : null });
	await kvput(env, `acct:${accountId}`, `sponsored:${room}`, on === true);
	await audit(env, accountId, auth.keyHash, 'sponsor', `${on ? 'on' : 'off'} ${room}`);
	return json({ ok: true, sponsoring: on === true });
}

/** GET /pay/account — signed (x-cic-* headers + x-cic-account); returns wallet,
 *  subscription, devices, passkeys, limits and the signed-ops audit trail. */
async function accountInfo(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const account = req.headers.get('x-cic-account') ?? '';
	if (!ACCOUNT_RE.test(account)) return json({ error: 'account required' }, 400);
	const auth = await authorize(env, req, '/pay/account', '', account);
	if (auth instanceof Response) return auth;
	const inst = `acct:${account}`;
	const bal = await meter(env, inst, 'get', {});
	const b = (await bal.json()) as { balanceSeconds?: number; spentSeconds?: number };
	const [sub, customer, sponsored, keys, passkeys, limitRec, auditRec] = await Promise.all([
		kvget(env, inst, 'sub'),
		kvget(env, inst, 'customer'),
		kvlist(env, inst, 'sponsored:'),
		kvlist(env, inst, 'key:'),
		kvlist(env, inst, 'passkey:'),
		kvget(env, inst, 'limits'),
		kvget(env, inst, 'audit')
	]);
	return json({
		accountId: account,
		balanceSeconds: b.balanceSeconds ?? 0,
		spentSeconds: b.spentSeconds ?? 0,
		subscription: sub ?? null,
		customerId: customer ?? null,
		sponsoredRooms: Object.keys(sponsored)
			.filter((k) => sponsored[k] === true)
			.map((k) => k.slice('sponsored:'.length)),
		devices: [
			{ keyHash: account, primary: true },
			...Object.entries(keys)
				.filter(([, v]) => v)
				.map(([k, v]) => ({ keyHash: k.slice(4), ...(v as object) }))
		],
		passkeys: Object.entries(passkeys)
			.filter(([, v]) => v)
			.map(([k, v]) => ({ credId: k.slice(8), name: (v as { name?: string }).name })),
		limits: limitRec ?? null,
		activity: (auditRec as unknown[]) ?? []
	});
}

// ------------------------------------------------- device link + passkeys

/** POST /pay/challenge {accountId} → one-time WebAuthn challenge + enrolled credIds */
async function challenge(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const { accountId } = (await req.json()) as { accountId?: string };
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	const ch = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	await kvput(env, `acct:${accountId}`, `chal:${ch}`, Date.now());
	const credIds = Object.keys(await passkeyList(env, accountId)).map((k) => k.slice(8));
	return json({ challenge: ch, credIds });
}

/** POST /pay/passkey-register {accountId, passkey:{credId,pubSpki,name}} — signed */
async function passkeyRegister(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const raw = await req.text();
	const { accountId, passkey } = JSON.parse(raw || '{}') as {
		accountId?: string;
		passkey?: { credId?: string; pubSpki?: string; name?: string };
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	if (!passkey?.credId || !passkey.pubSpki) return json({ error: 'passkey required' }, 400);
	const auth = await authorize(env, req, '/pay/passkey-register', raw, accountId);
	if (auth instanceof Response) return auth;
	await kvput(env, `acct:${accountId}`, `passkey:${passkey.credId}`, {
		pubSpki: passkey.pubSpki,
		name: passkey.name,
		signCount: 0,
		at: Date.now()
	});
	await audit(env, accountId, auth.keyHash, 'passkey-register', passkey.name);
	return json({ ok: true });
}

const LINK_CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no lookalikes
const LINK_TTL_MS = 10 * 60_000;

/** POST /pay/link-begin {pub} — park a new device's pubkey behind a short
 *  code. Unsigned: it only exposes data the new device itself generated. */
async function linkBegin(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const { pub } = (await req.json()) as { pub?: string };
	if (!pub || !hexBytes(pub)) return json({ error: 'pub required' }, 400);
	let code = '';
	for (let i = 0; i < 8; i++)
		code += LINK_CODE_CHARS[crypto.getRandomValues(new Uint8Array(1))[0] % LINK_CODE_CHARS.length];
	await kvput(env, '__links__', `pending:${code}`, { pub, expiresAt: Date.now() + LINK_TTL_MS });
	return json({ code, expiresInMs: LINK_TTL_MS });
}

/** GET /pay/link-status?code= → the new device learns its accountId once approved */
async function linkStatus(url: URL, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const code = url.searchParams.get('code') ?? '';
	const pending = (await kvget(env, '__links__', `pending:${code}`)) as
		| { pub: string; expiresAt: number; claimedBy?: string }
		| null;
	if (!pending || Date.now() > pending.expiresAt) return json({ error: 'expired' }, 404);
	return json({ accountId: pending.claimedBy ?? null });
}

/** POST /pay/link-approve {accountId, code, webauthn?} — signed + step-up:
 *  an existing device authorizes the parked key as a delegate. */
async function linkApprove(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const raw = await req.text();
	const { accountId, code, webauthn } = JSON.parse(raw || '{}') as {
		accountId?: string;
		code?: string;
		webauthn?: Parameters<typeof verifyPasskey>[2];
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	if (!code) return json({ error: 'code required' }, 400);
	const auth = await authorize(env, req, '/pay/link-approve', raw, accountId);
	if (auth instanceof Response) return auth;
	const step = await needStepUp(env, accountId, 'link-approve', webauthn);
	if (step) return step;
	const pending = (await kvget(env, '__links__', `pending:${code}`)) as
		| { pub: string; expiresAt: number; claimedBy?: string }
		| null;
	if (!pending || Date.now() > pending.expiresAt) return json({ error: 'expired code' }, 404);
	if (pending.claimedBy && pending.claimedBy !== accountId)
		return json({ error: 'already claimed' }, 409);
	const keyHash = await sha256hex(hexBytes(pending.pub)!);
	await kvput(env, `acct:${accountId}`, `key:${keyHash}`, { at: Date.now(), via: 'link' });
	await kvput(env, '__links__', `pending:${code}`, { ...pending, claimedBy: accountId });
	await audit(env, accountId, auth.keyHash, 'link-approve', keyHash.slice(0, 8));
	return json({ ok: true, accountId, keyHash });
}

/** POST /pay/revoke {accountId, pubHash, webauthn?} — signed + step-up */
async function revoke(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const raw = await req.text();
	const { accountId, pubHash, webauthn } = JSON.parse(raw || '{}') as {
		accountId?: string;
		pubHash?: string;
		webauthn?: Parameters<typeof verifyPasskey>[2];
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	if (!pubHash || !ACCOUNT_RE.test(pubHash)) return json({ error: 'pubHash required' }, 400);
	if (pubHash === accountId) return json({ error: 'cannot revoke the primary key' }, 400);
	const auth = await authorize(env, req, '/pay/revoke', raw, accountId);
	if (auth instanceof Response) return auth;
	const step = await needStepUp(env, accountId, 'revoke', webauthn);
	if (step) return step;
	await kvput(env, `acct:${accountId}`, `key:${pubHash}`, null);
	await audit(env, accountId, auth.keyHash, 'revoke', pubHash.slice(0, 8));
	return json({ ok: true });
}

/** POST /pay/limits {accountId, maxSecondsPerDay|null} — signed + step-up */
async function limits(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const raw = await req.text();
	const { accountId, maxSecondsPerDay, webauthn } = JSON.parse(raw || '{}') as {
		accountId?: string;
		maxSecondsPerDay?: number | null;
		webauthn?: Parameters<typeof verifyPasskey>[2];
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);
	const auth = await authorize(env, req, '/pay/limits', raw, accountId);
	if (auth instanceof Response) return auth;
	const step = await needStepUp(env, accountId, 'limits', webauthn);
	if (step) return step;
	const cap = maxSecondsPerDay == null ? null : Math.max(0, Math.round(maxSecondsPerDay));
	await kvput(env, `acct:${accountId}`, 'limits', cap ? { maxSecondsPerDay: cap } : null);
	await audit(env, accountId, auth.keyHash, 'limits', cap ? `${cap}s/day` : 'cleared');
	return json({ ok: true, maxSecondsPerDay: cap });
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
	const evt = JSON.parse(raw) as { id?: string; type?: string; data?: { object?: { id?: string } } };
	if (!evt.id || !evt.type) return json({ error: 'bad event' }, 400);

	// Anti-forgery: a leaked webhook secret alone must not mint credits, so
	// re-fetch the event from Stripe — fabricated ids 404, tampered payloads
	// mismatch data.object.id. Done BEFORE the dedupe claim so a forgery
	// can't burn a real event's slot.
	if (env.STRIPE_SECRET_KEY) {
		const chk = await fetch(`https://api.stripe.com/v1/events/${encodeURIComponent(evt.id)}`, {
			headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
		});
		if (!chk.ok) return json({ error: 'event not verifiable' }, 400);
		const real = (await chk.json()) as {
			id?: string;
			type?: string;
			data?: { object?: { id?: string } };
		};
		if (real.id !== evt.id || real.type !== evt.type || real.data?.object?.id !== evt.data?.object?.id)
			return json({ error: 'event mismatch' }, 400);
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

export async function handleEvent(
	env: Env,
	type: string,
	obj: Record<string, unknown>,
	evtId?: string
): Promise<void> {
	const meta = (obj.metadata ?? {}) as Record<string, string>;
	// a linkable id for the credit record — clawback debits must name a
	// credit they unwind, so a compromised worker can't drain wallets
	const creditId = obj.payment_intent
		? `pi:${obj.payment_intent}`
		: `tx:${evtId ?? String(obj.id ?? '')}`;

	if (type === 'checkout.session.completed') {
		const accountId = meta.accountId ?? (obj.client_reference_id as string | undefined);
		if (accountId && obj.customer)
			await linkCustomer(env, accountId, String(obj.customer), String(obj.subscription ?? ''));
		if (obj.mode === 'subscription') return; // allotments credit on invoice.paid
		const seconds = Math.round(Number(meta.seconds ?? 0));
		if (!accountId || seconds <= 0) return;
		const target = meta.kind === 'room' && meta.room ? meta.room : `acct:${accountId}`;
		await meter(env, target, 'credit', { amount: seconds, creditId, room: meta.room });
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
		await meter(env, `acct:${accountId}`, 'credit', { amount: sub.seconds, creditId });
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
		// the DO only unwinds up to the recorded credit:<id> — a clawback
		// can't drain below what that purchase originally added
		const clawbackOf = obj.payment_intent ? `pi:${obj.payment_intent}` : `tx:${evtId ?? String(obj.id)}`;
		await meter(env, `acct:${accountId}`, 'debit', { amount: seconds, clawbackOf });
		await kvput(env, `acct:${accountId}`, 'lastChargeback', { seconds, type, at: Date.now() });
		return;
	}
}

async function linkCustomer(env: Env, accountId: string, customer: string, subscription: string): Promise<void> {
	// first binding wins — a stranger's checkout can't rebind the account's
	// Stripe customer (and thereby its portal destination)
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

// ------------------------------------------------------------- auth
//
// Self-certifying accounts: accountId = sha256(spki). Signed requests carry
// x-cic-pub/ts/nonce/sig; a delegate key (multi-device link) is authorized
// when acct:<id> holds key:<sha256(pub)>. The bare accountId proves nothing.

const SIG_WINDOW_S = 300;
const STEP_UP_OPS = new Set(['portal', 'revoke', 'link-approve', 'limits']);
const CONVERT_STEP_UP_S = 3600; // converts above an hour also need the passkey

interface AuthResult {
	keyHash: string;
	/** the verified request, re-packaged for MeterBus's own re-verification —
	 *  the ledger trusts the client signature, not this worker's say-so */
	forward: {
		pub: string;
		ts: number;
		nonce: string;
		sig: string;
		method: string;
		path: string;
		body: string;
	};
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

/**
 * authorize — verify an x-cic-* signed request for `claimed`.
 * Returns {keyHash} on success, Response (401/409) on failure.
 */
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
	return {
		keyHash,
		forward: { pub: pubHex, ts, nonce, sig: sigHex, method: req.method, path, body: rawBody }
	};
}

// ------------------------------------------------------------- passkeys

/** enrolled passkeys for the account — [] when none (step-up then optional) */
async function passkeyList(env: Env, accountId: string): Promise<Record<string, unknown>> {
	return kvlist(env, `acct:${accountId}`, 'passkey:');
}

/** WebAuthn signatures arrive ASN.1-DER; WebCrypto wants raw P1363 r||s */
function derToP1363(der: Uint8Array): Uint8Array | null {
	if (der[0] !== 0x30) return null;
	let i = 2; // SEQUENCE header (short-form length — DER sigs are <128B)
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

/**
 * Verify a WebAuthn assertion against an enrolled credential.
 * The challenge was issued via /pay/challenge (single-use on the account
 * instance); the assertion signature covers authenticatorData||sha256(clientData).
 */
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
	// flags: bit0 user-present required; rpIdHash must be our origin or localhost
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
	// the challenge must be one we issued and it must be single-use
	const issued = await kvget(env, `acct:${accountId}`, `chal:${parsed.challenge}`);
	if (!issued) return false;
	await kvput(env, `acct:${accountId}`, `chal:${parsed.challenge}`, null);
	// ECDSA over authenticatorData || sha256(clientDataJSON)
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
	// signCount monotonicity catches cloned authenticators (0 = not supported)
	const count = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
	if (count > 0) {
		if (count <= (cred.signCount ?? 0)) return false;
		await kvput(env, `acct:${accountId}`, `passkey:${assertion.credId}`, { ...cred, signCount: count });
	}
	return true;
}

/** require an assertion iff the account has passkeys enrolled and the op is sensitive */
async function needStepUp(
	env: Env,
	accountId: string,
	op: string,
	webauthn: unknown,
	convertSeconds?: number
): Promise<Response | null> {
	const enrolled = Object.keys(await passkeyList(env, accountId)).length > 0;
	if (!enrolled) return null;
	const gated = STEP_UP_OPS.has(op) || (op === 'convert' && (convertSeconds ?? 0) > CONVERT_STEP_UP_S);
	if (!gated) return null;
	const ok = await verifyPasskey(env, accountId, webauthn as Parameters<typeof verifyPasskey>[2]);
	return ok ? null : json({ error: 'passkey assertion required' }, 428);
}

async function audit(env: Env, accountId: string, keyHash: string, op: string, detail?: string) {
	await meter(env, `acct:${accountId}`, 'audit', {
		entry: { op, device: keyHash.slice(0, 8), at: Date.now(), detail }
	}).catch(() => {});
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

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'content-type': 'application/json' }
	});
}
