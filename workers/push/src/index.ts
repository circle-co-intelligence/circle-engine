/**
 * cic-push — VAPID web-push for "ring a friend into the circle".
 *
 * Subscriptions live in a Durable Object keyed by room code (not the secret —
 * the URL fragment never leaves the browser). A ring sends an empty-payload
 * push; the client's service worker shows "A circle is waiting" and opens
 * /join?code=… — entry still goes through the normal lobby/secret flow.
 *
 * No npm deps: VAPID is a self-signed ES256 JWT (RFC 8292). Empty-payload
 * pushes need no RFC 8291 body encryption — nothing sensitive is pushed.
 *
 * Env/secrets:
 *   VAPID_PUBLIC  — base64url uncompressed P-256 public key
 *   VAPID_PRIVATE — JWK JSON of the P-256 private key  (wrangler secret put)
 *   VAPID_SUB     — mailto: contact for push services
 *
 * Generate keys: `npx web-push generate-vapid-keys` or any P-256 pair.
 */

export interface Env {
	PUSH: DurableObjectNamespace;
	VAPID_PUBLIC: string;
	VAPID_PRIVATE: string;
	VAPID_SUB?: string;
}

interface Subscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	code: string;
}

const b64u = (buf: ArrayBuffer | Uint8Array | string) => {
	const bytes =
		typeof buf === 'string' ? new TextEncoder().encode(buf) : buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function vapidJwt(endpoint: string, env: Env): Promise<string> {
	const aud = new URL(endpoint).origin;
	const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
	const body = b64u(
		JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUB ?? 'mailto:admin@localhost' })
	);
	const key = await crypto.subtle.importKey(
		'jwk',
		JSON.parse(env.VAPID_PRIVATE) as JsonWebKey,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		new TextEncoder().encode(`${header}.${body}`)
	);
	// WebCrypto emits DER on some runtimes — push needs raw r||s
	return `${header}.${body}.${b64u(sig)}`;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === '/push/vapid')
			return Response.json({ publicKey: env.VAPID_PUBLIC });
		if (url.pathname === '/push/sub' && req.method === 'POST') {
			const sub = (await req.json()) as Subscription;
			if (!sub.endpoint || !sub.code) return new Response('bad sub', { status: 400 });
			const stub = env.PUSH.get(env.PUSH.idFromName(sub.code));
			return stub.fetch(new Request('https://do/sub', { method: 'POST', body: JSON.stringify(sub) }));
		}
		if (url.pathname === '/push/ring' && req.method === 'POST') {
			const { code } = (await req.json()) as { code?: string };
			if (!code) return new Response('bad code', { status: 400 });
			const stub = env.PUSH.get(env.PUSH.idFromName(code));
			const subs = (await (await stub.fetch('https://do/list')).json()) as Subscription[];
			const dead: string[] = [];
			await Promise.all(
				subs.map(async (s) => {
					try {
						const jwt = await vapidJwt(s.endpoint, env);
						const res = await fetch(s.endpoint, {
							method: 'POST',
							headers: {
								authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
								ttl: '300'
							}
						});
						if (res.status === 404 || res.status === 410) dead.push(s.endpoint);
					} catch {
						/* transient push-service failure — keep sub */
					}
				})
			);
			for (const endpoint of dead)
				await stub.fetch(
					new Request('https://do/del', { method: 'POST', body: JSON.stringify({ endpoint }) })
				);
			return Response.json({ rung: subs.length - dead.length, pruned: dead.length });
		}
		return new Response('not found', { status: 404 });
	}
};

export class PushSubs implements DurableObject {
	constructor(private readonly ctx: DurableObjectState) {}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === '/sub') {
			const sub = (await req.json()) as Subscription;
			await this.ctx.storage.put(`sub:${sub.endpoint}`, sub);
			return Response.json({ ok: true });
		}
		if (url.pathname === '/list') {
			const all = await this.ctx.storage.list<Subscription>({ prefix: 'sub:' });
			return Response.json([...all.values()]);
		}
		if (url.pathname === '/del') {
			const { endpoint } = (await req.json()) as { endpoint: string };
			await this.ctx.storage.delete(`sub:${endpoint}`);
			return Response.json({ ok: true });
		}
		return new Response('not found', { status: 404 });
	}
}
