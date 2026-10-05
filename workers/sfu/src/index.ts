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
}

const UPSTREAM = 'https://rtc.live.cloudflare.com/v1/apps';

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'access-control-allow-headers': 'content-type, x-cic-room, x-cic-account'
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
			const funded = await coveringBalance(env, room, req.headers.get('x-cic-account'));
			if (!funded) return json({ error: 'no funded pool for this room/account' }, 402);
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
 * coveringBalance — same precedence as the gateway's pickPool: a room's
 * sponsor wallet first, then the caller's own account wallet, then the
 * room pool. Returns true when any covers.
 */
async function coveringBalance(env: Env, room: string, account: string | null): Promise<boolean> {
	const get = async (inst: string) => {
		const stub = env.METER!.get(env.METER!.idFromName(inst));
		const res = await stub.fetch('https://meter/get', { method: 'POST', body: '{}' });
		return (await res.json()) as { balanceSeconds?: number; sponsor?: string | null };
	};
	const roomInfo = await get(room);
	if (roomInfo.sponsor) {
		const sp = await get(`acct:${roomInfo.sponsor}`);
		if ((sp.balanceSeconds ?? 0) > 0) return true;
	}
	if (account) {
		const a = await get(`acct:${account}`);
		if ((a.balanceSeconds ?? 0) > 0) return true;
	}
	return (roomInfo.balanceSeconds ?? 0) > 0;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...cors }
	});
}
