/**
 * Pages Function: /api/sfu/* → cic-sfu worker (Cloudflare Realtime proxy).
 * Same-origin so the client needs no cross-origin CSP exception; the
 * funding gate (sessions/new requires a covering pool) lives in the worker
 * so both the web and native entry paths share it.
 */
const UPSTREAM = 'https://cic-sfu.regenleadership.workers.dev';

interface Ctx {
	request: Request;
	params: { path?: string[] };
}

export async function onRequest({ request, params }: Ctx): Promise<Response> {
	const path = (params.path ?? []).join('/');
	const url = new URL(request.url);
	return fetch(`${UPSTREAM}/${path}${url.search}`, request);
}
