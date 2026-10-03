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
}

const UPSTREAM = 'https://rtc.live.cloudflare.com/v1/apps';

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'access-control-allow-headers': 'content-type'
};

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
		if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET)
			return json({ error: 'sfu-unconfigured' }, 503);
		const path = new URL(req.url).pathname.replace(/^\/+/, '');
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

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...cors }
	});
}
