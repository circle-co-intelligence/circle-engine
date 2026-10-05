/**
 * Pages Function: /api/pay/* → cic-pay worker (Stripe billing bridge).
 * Same-origin so the client needs no cross-origin CSP exception and the
 * worker URL stays an internal detail.
 */
const UPSTREAM = 'https://cic-pay.regenleadership.workers.dev';

interface Ctx {
	request: Request;
}

export async function onRequest({ request }: Ctx): Promise<Response> {
	const url = new URL(request.url);
	return fetch(`${UPSTREAM}${url.pathname.replace(/^\/api/, '')}${url.search}`, request);
}
