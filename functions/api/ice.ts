/**
 * Pages Function: GET /api/ice — ICE server config.
 * STUN is always free. Cloudflare TURN credentials are a paid lane: the
 * caller's room pool or sponsor wallet must cover the session — unfunded
 * callers get STUN-only + a machine-readable `topup` reason (direct P2P
 * still works for most NATs). `?room=<code>` identifies the pool.
 * Same contract as workers/ice; this version deploys with the Pages site so
 * the client hits a same-origin endpoint (no CORS needed).
 *
 * Env bindings (Pages project settings → Functions → secrets):
 *   TURN_KEY_ID, TURN_API_TOKEN, optional TURN_TTL, METER_TOKEN
 * Durable Object binding: METER (MeterBus via cic-ai-gateway, wrangler.toml)
 */
interface Env {
	TURN_KEY_ID?: string;
	TURN_API_TOKEN?: string;
	TURN_TTL?: string;
	METER?: DurableObjectNamespace;
	METER_TOKEN?: string;
}

interface Ctx {
	env: Env;
	request: Request;
}

/** pool covers the room when its own balance or its sponsor wallet is funded */
async function roomFunded(env: Env, room: string): Promise<boolean> {
	if (!env.METER) return true; // unbound = self-host, no metering
	const get = async (inst: string) => {
		const stub = env.METER!.get(env.METER!.idFromName(inst));
		const res = await stub.fetch('https://meter/get', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-meter-token': env.METER_TOKEN ?? '' },
			body: JSON.stringify({ inst })
		}).catch(() => null);
		return res?.ok ? ((await res.json()) as { balanceSeconds?: number; sponsor?: string | null }) : null;
	};
	const info = await get(room);
	if (!info) return false;
	if ((info.balanceSeconds ?? 0) > 0) return true;
	if (info.sponsor) {
		const sp = await get(`acct:${info.sponsor}`);
		return (sp?.balanceSeconds ?? 0) > 0;
	}
	return false;
}

export async function onRequestGet({ env, request }: Ctx): Promise<Response> {
	const room = new URL(request.url).searchParams.get('room') ?? '';
	const funded = room ? await roomFunded(env, room) : false;
	if (!funded && env.METER)
		// unpaid → the free floor: public STUN only. The client proceeds on
		// direct P2P; relayed media is what the top-up buys back
		return json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], reason: 'topup' });

	if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN)
		return json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], reason: 'turn-unconfigured' });

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
	if (!res.ok) return json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], reason: `upstream-${res.status}` }, 502);
	const body = (await res.json()) as { iceServers?: unknown[] };
	return json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...(body.iceServers ?? [])] });
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
