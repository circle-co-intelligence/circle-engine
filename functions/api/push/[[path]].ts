/**
 * Pages Function: /api/push/* → cic-push worker (VAPID web-push broker).
 * Subscriptions are keyed by room code — the room secret never leaves the
 * URL fragment, so the broker only ever sees the public code.
 */
const UPSTREAM = 'https://cic-push.terexmaps.workers.dev';

interface Ctx {
	request: Request;
}

export async function onRequest({ request }: Ctx): Promise<Response> {
	const url = new URL(request.url);
	return fetch(`${UPSTREAM}${url.pathname.replace(/^\/api/, '')}${url.search}`, request);
}
