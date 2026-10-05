/**
 * cic-pay — billing bridge (Cloudflare Worker). Holds NO Stripe credential.
 *
 * Accounts are self-certifying: accountId = sha256(device pubkey); every
 * wallet-touching op requires an ECDSA signature MeterBus re-verifies.
 * Checkout is Stripe Payment-Link URL assembly (client_reference_id binds
 * the settlement target: `<accountId>` or `<accountId>:<room>`); portal and
 * webhook are forwarded verbatim to cic-pay-hook — the only worker holding
 * Stripe secrets (read-only rk_ + whsec_).
 *
 * MeterBus pools:
 *   acct:<accountId>   — the user's wallet ({balance,spent} + 'customer',
 *                        'sub', 'sponsored:<room>', 'key:*', 'passkey:*',
 *                        'limits', 'audit' KV records)
 *   <room>             — room pool + 'sponsor'
 *   cust:<customerId>  — stripe customer → accountId (first binding wins,
 *                        enforced inside the DO)
 *   evt:<eventId>      — webhook dedupe via the /claim op
 *
 * Endpoints:
 *   GET  /pay/config                       → public package/plan catalog
 *   POST /pay/checkout {accountId,kind,…}  → Payment Link url
 *   POST /pay/webhook                      → forwarded to cic-pay-hook
 *   GET  /pay/account                      → signed; wallet + devices + audit
 *   POST /pay/portal   {accountId}         → forwarded to cic-pay-hook
 *   POST /pay/convert  {accountId,room,seconds} → signed acct→room move
 *   POST /pay/sponsor  {room,accountId,on,budgetSeconds?} → signed host cover
 */

export interface Env {
	METER?: DurableObjectNamespace;
	APP_ORIGIN?: string;
	PAY_PACKAGES?: string;
	PAY_SUB?: string;
	PAY_HOOK?: Fetcher; // service binding → cic-pay-hook (portal + webhook)
	PAY_HOOK_URL?: string; // fallback for self-hosts without the binding
	METER_TOKEN?: string; // admin-role capability token for MeterBus ops
	// No Stripe credential here by design: checkout uses pre-signed Payment
	// Links and portal/webhook are forwarded to cic-pay-hook, which holds the
	// read-only rk_ + whsec_. A compromised cic-pay cannot charge cards,
	// mint checkout sessions, or forge settlements.
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
	paymentLink?: string; // https://buy.stripe.com/… — pre-signed checkout
	amountCents?: number;
	currency?: string;
}
interface SubPlan {
	priceId: string;
	paymentLink?: string;
	seconds: number;
	label: string;
	amountCents?: number;
	currency?: string;
}

const ACCOUNT_RE = /^[0-9a-f]{16,128}$/i;
const ROOM_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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
					// by design this worker holds NO Stripe credential —
					// checkout is Payment-Link assembly; portal + webhook are
					// forwarded to cic-pay-hook (the only worker with rk_/whsec_)
					stripe: 'none',
					hook: !!(env.PAY_HOOK ?? env.PAY_HOOK_URL),
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
 * → {url} — the Stripe *Payment Link* URL with the settlement target bound
 * into client_reference_id (`<accountId>` or `<accountId>:<room>`).
 *
 * No Stripe API call happens here — Payment Links are pre-signed hosted
 * URLs minted once in the dashboard. cic-pay therefore holds NO Stripe
 * credential: a compromise of this worker can mislabel a URL but cannot
 * create a checkout session, a portal session, or a charge. Seconds land
 * via cic-pay-hook's webhook (price → seconds from PAY_PACKAGES/PAY_SUB).
 */
async function checkout(req: Request, env: Env): Promise<Response> {
	const { accountId, kind, packId, room } = (await req.json()) as {
		accountId?: string;
		kind?: string;
		packId?: string;
		room?: string;
	};
	if (!accountId || !ACCOUNT_RE.test(accountId)) return json({ error: 'accountId required' }, 400);

	let link: string | undefined;
	if (kind === 'sub') {
		link = subPlan(env)?.paymentLink;
		if (!link) return json({ error: 'no subscription payment link configured' }, 503);
	} else if (kind === 'pack' || kind === 'room') {
		const pack = packs(env).find((x) => x.id === packId);
		if (!pack) return json({ error: 'unknown pack' }, 400);
		if (kind === 'room' && (!room || !ROOM_RE.test(room)))
			return json({ error: 'room required' }, 400);
		link = pack.paymentLink;
		if (!link) return json({ error: 'no payment link configured for this pack' }, 503);
	} else {
		return json({ error: 'kind must be pack | sub | room' }, 400);
	}

	const u = new URL(link);
	u.searchParams.set(
		'client_reference_id',
		kind === 'room' ? `${accountId}:${room}` : accountId
	);
	return json({ url: u.toString() });
}

// ------------------------------------------------------------- portal

/** POST /pay/portal {accountId, webauthn?} → Stripe Billing Portal url.
 *  This worker holds no Stripe credential — the signed request is
 *  forwarded verbatim to cic-pay-hook, which verifies the signature
 *  itself (same canonical path) and creates the portal session with its
 *  restricted read+portal key. */
async function portal(req: Request, env: Env): Promise<Response> {
	const res = await hookFetch(env, '/pay-hook/portal', req);
	if (!res) return json({ error: 'portal unconfigured' }, 503);
	return new Response(res.body, { status: res.status, headers: { ...cors, 'content-type': 'application/json' } });
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

/** POST /pay/sponsor {room, accountId, on, budgetSeconds?} — host covers
 *  the circle's paid lanes from their wallet, bounded by a cumulative
 *  per-room budget (default 4h, max 24h) enforced inside MeterBus — a
 *  compromised gateway can only burn what the host already committed. */
async function sponsor(req: Request, env: Env): Promise<Response> {
	if (!env.METER) return json({ error: 'ledger unconfigured' }, 503);
	const raw = await req.text();
	const { room, accountId, on, budgetSeconds } = JSON.parse(raw || '{}') as {
		room?: string;
		accountId?: string;
		on?: boolean;
		budgetSeconds?: number;
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
	// the DO derives {budget,spent} from the signed body — b.value is ignored
	await kvput(env, `acct:${accountId}`, `sponsored:${room}`, on === true, auth);
	await audit(env, accountId, auth.keyHash, 'sponsor', `${on ? 'on' : 'off'} ${room}${budgetSeconds ? ` budget=${budgetSeconds}s` : ''}`);
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
			.filter((k) => !!sponsored[k])
			.map((k) => k.slice('sponsored:'.length)),
		sponsored: Object.fromEntries(
			Object.entries(sponsored).map(([k, v]) => [k.slice('sponsored:'.length), v])
		),
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
	}, auth);
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
	// pub is a public key — exposing it lets the approver bind the parked
	// device into its signed body so MeterBus can verify the write end-to-end
	return json({ accountId: pending.claimedBy ?? null, pub: pending.pub });
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
	// defense in depth: the signed body carries `pub` too, and MeterBus only
	// stores the record when sha256(body.pub) == the key name — this worker
	// can't substitute a different device even while compromised
	const bodyPub = (JSON.parse(raw) as { pub?: string }).pub;
	if (bodyPub !== pending.pub) return json({ error: 'pub mismatch' }, 400);
	await kvput(env, `acct:${accountId}`, `key:${keyHash}`, { pub: pending.pub, at: Date.now(), via: 'link' }, auth);
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
	await kvput(env, `acct:${accountId}`, `key:${pubHash}`, null, auth);
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
	await kvput(env, `acct:${accountId}`, 'limits', cap ? { maxSecondsPerDay: cap } : null, auth);
	await audit(env, accountId, auth.keyHash, 'limits', cap ? `${cap}s/day` : 'cleared');
	return json({ ok: true, maxSecondsPerDay: cap });
}

// ------------------------------------------------------------- webhook

/**
 * POST /pay/webhook — Stripe event intake is forwarded verbatim to
 * cic-pay-hook, which verifies the signature (whsec_), re-fetches the
 * event with its read-only key, and settles into MeterBus as the `settle`
 * role. Keeping this shim lets the Stripe endpoint stay pointed at
 * cic-pay while the secrets live only on the isolated worker.
 */
async function webhook(req: Request, env: Env): Promise<Response> {
	const res = await hookFetch(env, '/pay-hook/webhook', req);
	if (!res) return json({ error: 'webhook unconfigured' }, 503);
	return new Response(res.body, { status: res.status, headers: { ...cors, 'content-type': 'application/json' } });
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

/** headers to carry across the cic-pay → cic-pay-hook forward — the
 *  signature block + stripe-signature only; forwarding req.headers whole
 *  leaks our Host header and Cloudflare routes the fetch back to us */
/** forward a request to cic-pay-hook — service binding preferred (same-
 * account workers.dev fetches are refused with error 1042), URL fallback
 * for self-hosts. Only signature/stripe headers cross the boundary. */
async function hookFetch(env: Env, path: string, req: Request): Promise<Response | null> {
	const init = { method: 'POST', headers: fwdHeaders(req), body: await req.text() };
	if (env.PAY_HOOK) return env.PAY_HOOK.fetch(`https://pay-hook${path}`, init);
	if (env.PAY_HOOK_URL) return fetch(`${env.PAY_HOOK_URL}${path}`, init);
	return null;
}

function fwdHeaders(req: Request): Headers {
	const h = new Headers();
	for (const k of [
		'content-type', 'stripe-signature',
		'x-cic-account', 'x-cic-pub', 'x-cic-ts', 'x-cic-nonce', 'x-cic-sig'
	]) {
		const v = req.headers.get(k);
		if (v) h.set(k, v);
	}
	return h;
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
async function kvput(
	env: Env,
	instance: string,
	key: string,
	value: unknown,
	auth?: AuthResult
): Promise<void> {
	await meter(env, instance, 'kvput', { key, value, auth: auth?.forward });
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
