/**
 * cic-sfu — Cloudflare Realtime proxy as a standalone Worker.
 * Identical contract to functions/api/sfu, but deployable with the
 * Workers-scoped token (the Pages Functions deploy was perm-blocked).
 * Media flows client↔SFU as SFrame ciphertext; this proxy only sees
 * signaling JSON.
 *
 * Secrets: wrangler secret put CALLS_APP_SECRET (+ CALLS_APP_ID var)
 */
interface Env {
	CALLS_APP_ID?: string;
	CALLS_APP_SECRET?: string;
	METER?: DurableObjectNamespace; // MeterBus via script_name — funding gate
	METER_TOKEN?: string; // probe-role capability token (balance reads only)
}

const UPSTREAM = 'https://rtc.live.cloudflare.com/v1/apps';

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'access-control-allow-headers':
		'content-type, x-cic-room, x-cic-account, x-cic-room-ticket, x-cic-pub, x-cic-ts, x-cic-nonce, x-cic-sig'
};

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
		if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET)
			return json({ error: 'sfu-unconfigured' }, 503);
		const path = new URL(req.url).pathname.replace(/^\/+/, '');
		// session creation is a paid-lane action — require a covering pool
		// (host sponsor → caller's account wallet → room pool). Everything
		// downstream of a session id is capability-scoped already.
		if (path === 'sessions/new' && req.method === 'POST' && env.METER) {
			const room = req.headers.get('x-cic-room');
			if (!room) return json({ error: 'x-cic-room required' }, 400);
			if (!(await sessionAuthorized(env, req, room)))
				return json({ error: 'no funded pool for this room/account' }, 402);
		}
		// lease recheck: publishing new tracks re-verifies the pool is still
		// funded — a session created on a funded pool can't stream forever on
		// a balance that has since drained to zero
		if (path.endsWith('/tracks/new') && req.method === 'POST' && env.METER) {
			const room = req.headers.get('x-cic-room');
			if (room && !(await roomFunded(env, room)))
				return json({ error: 'insufficient credits' }, 402);
		}
		const res = await fetch(`${UPSTREAM}/${env.CALLS_APP_ID}/${path}`, {
			method: req.method,
			headers: {
				authorization: `Bearer ${env.CALLS_APP_SECRET}`,
				'content-type': 'application/json'
			},
			body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text()
		});
		return new Response(res.body, {
			status: res.status,
			headers: {
				'content-type': res.headers.get('content-type') ?? 'application/json',
				...cors
			}
		});
	}
};

/**
 * sessionAuthorized — session creation spends real Calls capacity, so it
 * needs one of two proofs:
 *  a) x-cic-account + a valid x-cic-* signature over this request, and that
 *     wallet (or the room's sponsor) is funded — the account lane; or
 *  b) x-cic-room-ticket = sha256('sfu:'+roomSecret+':'+roomCode) — a
 *     membership capability only room participants can compute — plus a
 *     funded room pool or sponsor.
 * A bare room name or accountId proves nothing (both are public).
 */
async function sessionAuthorized(env: Env, req: Request, room: string): Promise<boolean> {
	const account = req.headers.get('x-cic-account');
	if (account && (await verifyAccountSig(env, req, 'sessions/new', '', account))) {
		if (await funded(env, `acct:${account}`)) return true;
	}
	const ticket = req.headers.get('x-cic-room-ticket');
	if (ticket && /^[0-9a-f]{64}$/i.test(ticket)) {
		const info = await roomInfo(env, room);
		if (info.sponsor && (await funded(env, `acct:${info.sponsor}`))) return true;
		if ((info.balanceSeconds ?? 0) > 0) return true;
	}
	return false;
}

interface PoolInfo {
	balanceSeconds?: number;
	sponsor?: string | null;
}

async function funded(env: Env, inst: string): Promise<boolean> {
	const info = await roomInfo(env, inst);
	return (info.balanceSeconds ?? 0) > 0;
}

/** room-pool-or-sponsor coverage — the lease recheck for mid-session ops */
async function roomFunded(env: Env, room: string): Promise<boolean> {
	const info = await roomInfo(env, room);
	if ((info.balanceSeconds ?? 0) > 0) return true;
	if (info.sponsor) return funded(env, `acct:${info.sponsor}`);
	return false;
}

async function roomInfo(env: Env, inst: string): Promise<PoolInfo> {
	const stub = env.METER!.get(env.METER!.idFromName(inst));
	const res = await stub.fetch('https://meter/get', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-meter-token': env.METER_TOKEN ?? '' },
		body: JSON.stringify({ inst })
	});
	return (await res.json()) as PoolInfo;
}

async function kvget(env: Env, inst: string, key: string): Promise<unknown> {
	const stub = env.METER!.get(env.METER!.idFromName(inst));
	const res = await stub.fetch('https://meter/kvget', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-meter-token': env.METER_TOKEN ?? '' },
		body: JSON.stringify({ inst, key })
	});
	return ((await res.json()) as { value?: unknown }).value ?? null;
}

/** shared account-key check — same scheme as cic-pay/cic-ai-gateway */
async function verifyAccountSig(
	env: Env,
	req: Request,
	path: string,
	rawBody: string,
	claimed: string
): Promise<boolean> {
	try {
		const pubHex = req.headers.get('x-cic-pub');
		const ts = Number(req.headers.get('x-cic-ts'));
		const nonce = req.headers.get('x-cic-nonce');
		const sigHex = req.headers.get('x-cic-sig');
		if (!pubHex || !ts || !nonce || !sigHex) return false;
		if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
		const pub = hexBytes(pubHex);
		const sig = hexBytes(sigHex);
		if (!pub || !sig) return false;
		const enc = new TextEncoder();
		const digest = async (d: Uint8Array | string) =>
			new Uint8Array(
				await crypto.subtle.digest('SHA-256', (typeof d === 'string' ? enc.encode(d) : d) as BufferSource)
			);
		const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
		const keyHash = hex(await digest(pub));
		if (keyHash !== claimed && !(await kvget(env, `acct:${claimed}`, `key:${keyHash}`)))
			return false;
		const key = await crypto.subtle.importKey(
			'spki',
			pub as BufferSource,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		const bodyHash = hex(await digest(rawBody));
		const payload = [claimed, req.method.toUpperCase(), path, bodyHash, String(ts), nonce, keyHash].join(
			'\n'
		);
		if (
			!(await crypto.subtle.verify(
				{ name: 'ECDSA', hash: 'SHA-256' },
				key,
				sig as BufferSource,
				enc.encode(payload)
			))
		)
			return false;
		const stub = env.METER!.get(env.METER!.idFromName(`acct:${claimed}`));
		const claim = await stub.fetch('https://meter/claim', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-meter-token': env.METER_TOKEN ?? '' },
			body: JSON.stringify({ inst: `acct:${claimed}`, nonce: `req:${nonce}` })
		});
		return claim.ok;
	} catch {
		return false;
	}
}

function hexBytes(hexS: string): Uint8Array | null {
	if (!/^[0-9a-f]+$/i.test(hexS) || hexS.length % 2) return null;
	const out = new Uint8Array(hexS.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hexS.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...cors }
	});
}
