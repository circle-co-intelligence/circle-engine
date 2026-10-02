/**
 * Pages Function: GET /api/ice — short-lived Cloudflare TURN credentials.
 * Same contract as workers/ice; this version deploys with the Pages site so
 * the client hits a same-origin endpoint (no CORS needed).
 *
 * Env bindings (Pages project settings → Functions → secrets):
 *   TURN_KEY_ID, TURN_API_TOKEN, optional TURN_TTL
 */
interface Env {
	TURN_KEY_ID?: string;
	TURN_API_TOKEN?: string;
	TURN_TTL?: string;
}

interface Ctx {
	env: Env;
}

export async function onRequestGet({ env }: Ctx): Promise<Response> {
	if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN)
		return json({ iceServers: [], reason: 'turn-unconfigured' });

	const ttl = Math.min(Math.max(Number(env.TURN_TTL ?? 86400) || 86400, 60), 86400);
	const res = await fetch(
		`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.TURN_API_TOKEN}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ ttl })
		}
	);
	if (!res.ok) return json({ iceServers: [], reason: `upstream-${res.status}` }, 502);
	const body = (await res.json()) as { iceServers?: unknown[] };
	return json({ iceServers: body.iceServers ?? [] });
}

export async function onRequestOptions(): Promise<Response> {
	return new Response(null, {
		headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' }
	});
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
	});
}
