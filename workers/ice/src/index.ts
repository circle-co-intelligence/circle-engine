/**
 * /api/ice — short-lived TURN credential broker (Cloudflare Worker).
 *
 * Mints ephemeral Cloudflare Realtime TURN credentials so no long-lived TURN
 * secret ever ships in the client bundle. CF TURN only ever relays SFrame
 * ciphertext — content trust model is unchanged.
 *
 * Secrets (wrangler secret put / Pages env):
 *   TURN_KEY_ID    — CF Realtime TURN key id
 *   TURN_API_TOKEN — CF Realtime TURN API token
 * Optional env:
 *   TURN_TTL       — credential TTL seconds (default 86400, CF max)
 *
 * Response: { iceServers: RTCIceServer[] } matching the CF TURN API shape so
 * the client can append it verbatim to RTCConfiguration.iceServers.
 */

export interface Env {
	TURN_KEY_ID?: string;
	TURN_API_TOKEN?: string;
	TURN_TTL?: string;
}

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'access-control-max-age': '86400'
};

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
		if (req.method !== 'GET' && req.method !== 'HEAD')
			return json({ error: 'method not allowed' }, 405);

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

		const body = (await res.json()) as { iceServers?: RTCIceServer[] };
		return json({ iceServers: body.iceServers ?? [] });
	}
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...CORS }
	});
}
