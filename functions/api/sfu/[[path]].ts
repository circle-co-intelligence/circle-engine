/**
 * Pages Function: /api/sfu/* — authenticated proxy to Cloudflare Realtime
 * (Calls). The client never holds the app secret; this function injects it.
 * Media itself flows client↔SFU as SFrame ciphertext — this proxy only ever
 * sees signaling JSON (SDP + track metadata).
 *
 * Env bindings (Pages project → Functions → secrets):
 *   CALLS_APP_ID, CALLS_APP_SECRET
 */
interface Env {
	CALLS_APP_ID?: string;
	CALLS_APP_SECRET?: string;
}

interface Ctx {
	request: Request;
	env: Env;
	params: { path?: string[] };
}

const UPSTREAM = 'https://rtc.live.cloudflare.com/v1/apps';

export async function onRequest({ request, env, params }: Ctx): Promise<Response> {
	if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET)
		return json({ error: 'sfu-unconfigured' }, 503);
	const path = (params.path ?? []).join('/');
	const url = `${UPSTREAM}/${env.CALLS_APP_ID}/${path}`;
	const res = await fetch(url, {
		method: request.method,
		headers: {
			authorization: `Bearer ${env.CALLS_APP_SECRET}`,
			'content-type': 'application/json'
		},
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
	});
	return new Response(res.body, {
		status: res.status,
		headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }
	});
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
