/**
 * Pages Function: /sig/* → cic-signaling worker (Durable-Object room bus).
 * Same-origin proxy so clients never touch workers.dev directly — and
 * WebSocket upgrades pass through untouched.
 */
const UPSTREAM = 'https://cic-signaling.regenleadership.workers.dev';

interface Ctx {
	request: Request;
}

export async function onRequest({ request }: Ctx): Promise<Response> {
	const url = new URL(request.url);
	return fetch(`${UPSTREAM}${url.pathname.replace(/^\/sig/, '')}${url.search}`, request);
}
