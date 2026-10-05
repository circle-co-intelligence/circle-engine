/**
 * /api/ux/* — privacy-preserving product telemetry.
 *
 *   POST /api/ux/session        mint a per-load visit token (HMAC, no PII)
 *   POST /api/ux/events         funnel events → Analytics Engine (UX_EVENTS)
 *   POST /api/ux/replay/chunks  masked rrweb chunk → R2 (UX_REPLAY)
 *   POST /api/ux/replay/close   finalize a replay session (meta marker)
 *   POST /api/ux/revoke         delete all replay objects for the visit
 *   GET  /api/ux/admin/replay/sessions?cursor=
 *   GET  /api/ux/admin/replay/meta?visit=
 *   GET  /api/ux/admin/replay/chunk?visit=&index=
 *
 * Privacy invariants (docs/SECURITY.md "UX telemetry"):
 *  - consent is opt-in; Sec-GPC/DNT headers refuse collection server-side
 *  - tokens carry {visitId, exp} only — no IP, room code, account, name
 *  - event fields are enum-validated; unknown fields are dropped, not stored
 *  - no IP persistence — country comes from request.cf.coarse geography
 *  - replay objects are admin-gated, never public; revoke deletes them
 *  - Analytics Engine datapoints are immutable for their retention window,
 *    so nothing written may identify a person (visitId is a per-load UUID)
 */

interface Env {
	UX_EVENTS?: AnalyticsEngineDataset;
	UX_REPLAY?: R2Bucket;
	UX_HMAC?: string;
	UX_ADMIN?: string;
	/** set to '1' to disable all collection (kill switch) */
	UX_DISABLED?: string;
}

const enc = new TextEncoder();

// ------------------------------------------------------------ vendored enums
const PAGES = new Set(['setup', 'join', 'prejoin', 'room']);
const EVENTS = new Set([
	'visit_start', 'visit_end', 'activation', 'ack', 'success',
	'failure', 'dead', 'rage', 'step', 'coverage'
]);
const STEPS = new Set([
	'setup_opened', 'room_created', 'prejoin_opened', 'join_succeeded',
	'tool_opened', 'tool_acknowledged', 'tool_succeeded'
]);
const TARGETS = new Set([
	'create_room', 'join_room', 'microphone', 'camera', 'settings',
	'chat', 'recording', 'transcript', 'milo', 'share', 'layout', 'leave'
]);
const ROLES = new Set(['host', 'participant', 'unknown']);
const DEVICES = new Set(['mobile', 'tablet', 'desktop']);
const BROWSERS = new Set(['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera', 'other']);
const REPLAY_STATUS = new Set(['completed', 'capped', 'failed']);

const MAX_BODY = 64 * 1024;
const MAX_CHUNK_BODY = 300 * 1024;
const MAX_EVENTS_BATCH = 40;
const MAX_CHUNK_EVENTS = 64;
const MAX_CHUNKS = 64;
const TOKEN_TTL_S = 24 * 3600;
const KEY_PREFIX = 'ux-replay/';

// ------------------------------------------------------------------- utils
const b64url = (buf: ArrayBuffer | Uint8Array): string => {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string): Uint8Array => {
	const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
	const out = new Uint8Array(b.length);
	for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
	return out;
};

const privacySignal = (req: Request): boolean =>
	req.headers.get('sec-gpc') === '1' || req.headers.get('dnt') === '1';

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
}

interface TokenPayload {
	visitId: string;
	exp: number;
}

async function mintToken(secret: string): Promise<{ token: string; visitId: string; exp: number }> {
	const visitId = crypto.randomUUID();
	const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
	const payload = b64url(enc.encode(JSON.stringify({ visitId, exp } satisfies TokenPayload)));
	const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`v1.${payload}`)));
	return { token: `v1.${payload}.${sig}`, visitId, exp };
}

async function verifyToken(secret: string, token: string): Promise<TokenPayload | null> {
	if (typeof token !== 'string' || token.length > 512) return null;
	const m = token.match(/^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
	if (!m) return null;
	const ok = await crypto.subtle.verify(
		'HMAC',
		await hmacKey(secret),
		unb64url(m[2]),
		enc.encode(`v1.${m[1]}`)
	);
	if (!ok) return null;
	try {
		const p = JSON.parse(new TextDecoder().decode(unb64url(m[1]))) as TokenPayload;
		if (typeof p.visitId !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.visitId)) return null;
		if (typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return null;
		return p;
	} catch {
		return null;
	}
}

// ------------------------------------------------------------ event schema
function cleanEvent(e: unknown): Record<string, unknown> | null {
	if (typeof e !== 'object' || e === null) return null;
	const o = e as Record<string, unknown>;
	if (o.v !== 1 || o.detector !== 1) return null;
	if (typeof o.visitId !== 'string' || !/^[0-9a-f-]{36}$/i.test(o.visitId)) return null;
	if (typeof o.eventId !== 'string' || o.eventId.length > 80) return null;
	if (typeof o.seq !== 'number' || !Number.isInteger(o.seq) || o.seq < 0 || o.seq > 1e6) return null;
	if (typeof o.at !== 'number' || o.at < 0 || o.at > 1e13) return null;
	if (!PAGES.has(o.page as string) || !EVENTS.has(o.event as string)) return null;
	if (typeof o.release !== 'string' || !/^[\w.+-]{1,40}$/.test(o.release)) return null;
	if (!DEVICES.has(o.device as string) || !BROWSERS.has(o.browser as string)) return null;
	if (typeof o.browserMajor !== 'number' || o.browserMajor < 0 || o.browserMajor > 999) return null;
	if (!ROLES.has(o.role as string)) return null;
	const out: Record<string, unknown> = {
		visitId: o.visitId,
		seq: o.seq,
		at: o.at,
		page: o.page,
		event: o.event,
		release: o.release,
		device: o.device,
		browser: o.browser,
		browserMajor: o.browserMajor,
		role: o.role
	};
	if (o.target !== undefined) {
		if (!TARGETS.has(o.target as string)) return null;
		out.target = o.target;
	}
	if (o.actionId !== undefined) {
		if (typeof o.actionId !== 'number' || o.actionId < 0 || o.actionId > 1e6) return null;
		out.actionId = o.actionId;
	}
	if (o.step !== undefined) {
		if (!STEPS.has(o.step as string)) return null;
		out.step = o.step;
	}
	if (o.incomplete !== undefined) {
		if (typeof o.incomplete !== 'boolean') return null;
		out.incomplete = o.incomplete;
	}
	if (o.dropped !== undefined) {
		if (typeof o.dropped !== 'number' || o.dropped < 0 || o.dropped > 1e6) return null;
		out.dropped = o.dropped;
	}
	return out;
}

// ------------------------------------------------------------------ replay
const safeVisit = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

async function deleteVisit(bucket: R2Bucket, visitId: string): Promise<number> {
	let n = 0;
	let cursor: string | undefined;
	do {
		const l = await bucket.list({ prefix: `${KEY_PREFIX}${visitId}/`, cursor, limit: 1000 });
		for (const k of l.objects.map((o) => o.key)) await bucket.delete(k);
		n += l.objects.length;
		cursor = l.truncated ? l.cursor : undefined;
	} while (cursor);
	return n;
}

// ------------------------------------------------------------------ router
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
	const url = new URL(request.url);
	const path = url.pathname.replace(/^\/api\/ux\/?/, '').replace(/\/$/, '');

	if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
	if (env.UX_DISABLED === '1') return new Response(null, { status: 204 });
	if (privacySignal(request)) return new Response(null, { status: 204 });
	if (!env.UX_HMAC) return json({ error: 'telemetry not configured' }, 503);

	const admin =
		path.startsWith('admin/') &&
		env.UX_ADMIN !== undefined &&
		request.headers.get('authorization') === `Bearer ${env.UX_ADMIN}`;

	if (path.startsWith('admin/')) {
		if (!admin) return json({ error: 'forbidden' }, 403);
		return adminRoute(url, path, env);
	}
	if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

	switch (path) {
		case 'session':
			return sessionRoute(env);
		case 'events':
			return eventsRoute(request, env);
		case 'replay/chunks':
			return chunksRoute(request, env);
		case 'replay/close':
			return closeRoute(request, env);
		case 'revoke':
			return revokeRoute(request, env);
		default:
			return json({ error: 'not found' }, 404);
	}
};

// ------------------------------------------------------------------ routes
async function sessionRoute(env: Env): Promise<Response> {
	const { token, visitId, exp } = await mintToken(env.UX_HMAC!);
	return json({ token, visitId, exp });
}

async function eventsRoute(req: Request, env: Env): Promise<Response> {
	const len = Number(req.headers.get('content-length') ?? 0);
	if (len > MAX_BODY) return new Response(null, { status: 413 });
	let body: { token?: string; events?: unknown[] };
	try {
		body = await req.json();
	} catch {
		return new Response(null, { status: 400 });
	}
	const tok = await verifyToken(env.UX_HMAC!, String(body.token ?? ''));
	if (!tok || !Array.isArray(body.events) || body.events.length > MAX_EVENTS_BATCH)
		return new Response(null, { status: 400 });
	const cf = (req as unknown as { cf?: { country?: string } }).cf;
	const country = typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : 'ZZ';
	let n = 0;
	for (const raw of body.events) {
		const e = cleanEvent(raw);
		if (!e || e.visitId !== tok.visitId) continue;
		env.UX_EVENTS?.writeDataPoint({
			blobs: [
				String(e.event), String(e.page), String(e.role), String(e.target ?? ''),
				String(e.step ?? ''), String(e.browser), String(e.device),
				String(e.release), country, String(e.visitId)
			],
			doubles: [Number(e.seq), Number(e.actionId ?? 0), Number(e.browserMajor), Number(e.dropped ?? 0)],
			indexes: [String(e.event)]
		});
		n++;
	}
	return json({ ok: true, accepted: n });
}

async function chunksRoute(req: Request, env: Env): Promise<Response> {
	if (!env.UX_REPLAY) return new Response(null, { status: 204 });
	const len = Number(req.headers.get('content-length') ?? 0);
	if (len > MAX_CHUNK_BODY) return new Response(null, { status: 413 });
	let body: { token?: string; visitId?: string; chunkIndex?: number; events?: unknown[] };
	try {
		body = await req.json();
	} catch {
		return new Response(null, { status: 400 });
	}
	const tok = await verifyToken(env.UX_HMAC!, String(body.token ?? ''));
	const visit = String(body.visitId ?? '');
	if (
		!tok || visit !== tok.visitId || !safeVisit(visit) ||
		typeof body.chunkIndex !== 'number' || !Number.isInteger(body.chunkIndex) ||
		body.chunkIndex < 0 || body.chunkIndex >= MAX_CHUNKS ||
		!Array.isArray(body.events) || !body.events.length || body.events.length > MAX_CHUNK_EVENTS ||
		!body.events.every((e) => {
			const t = (e as { type?: unknown })?.type;
			return typeof e === 'object' && e !== null && typeof t === 'number' && t >= 0 && t <= 4;
		})
	)
		return new Response(null, { status: 400 });
	await env.UX_REPLAY.put(`${KEY_PREFIX}${visit}/chunk-${String(body.chunkIndex).padStart(4, '0')}`, JSON.stringify(body.events), {
		httpMetadata: { contentType: 'application/json' }
	});
	return json({ ok: true });
}

async function closeRoute(req: Request, env: Env): Promise<Response> {
	if (!env.UX_REPLAY) return new Response(null, { status: 204 });
	let body: { token?: string; visitId?: string; status?: string };
	try {
		body = await req.json();
	} catch {
		return new Response(null, { status: 400 });
	}
	const tok = await verifyToken(env.UX_HMAC!, String(body.token ?? ''));
	const visit = String(body.visitId ?? '');
	if (!tok || visit !== tok.visitId || !safeVisit(visit) || !REPLAY_STATUS.has(String(body.status)))
		return new Response(null, { status: 400 });
	await env.UX_REPLAY.put(
		`${KEY_PREFIX}${visit}/_meta`,
		JSON.stringify({ status: body.status, closedAt: Date.now() }),
		{ httpMetadata: { contentType: 'application/json' } }
	);
	return json({ ok: true });
}

async function revokeRoute(req: Request, env: Env): Promise<Response> {
	let body: { token?: string };
	try {
		body = await req.json();
	} catch {
		return new Response(null, { status: 204 }); // indistinguishable — no oracle
	}
	const tok = await verifyToken(env.UX_HMAC!, String(body.token ?? ''));
	if (tok && env.UX_REPLAY) await deleteVisit(env.UX_REPLAY, tok.visitId);
	return new Response(null, { status: 204 });
}

// ------------------------------------------------------------------- admin
async function adminRoute(url: URL, path: string, env: Env): Promise<Response> {
	if (!env.UX_REPLAY) return json({ error: 'replay not configured' }, 503);
	switch (path) {
		case 'admin/replay/sessions': {
			const out: { visit: string; status?: string; closedAt?: number }[] = [];
			let cursor = url.searchParams.get('cursor') ?? undefined;
			const l = await env.UX_REPLAY.list({ prefix: KEY_PREFIX, delimiter: '/', cursor, limit: 200 });
			for (const p of l.delimitedPrefixes ?? []) {
				const visit = p.slice(KEY_PREFIX.length, -1);
				const meta = await env.UX_REPLAY.get(`${p}_meta`);
				const m = meta ? ((await meta.json()) as { status?: string; closedAt?: number }) : {};
				out.push({ visit, ...m });
			}
			return json({ sessions: out, cursor: l.truncated ? l.cursor : null });
		}
		case 'admin/replay/meta': {
			const visit = url.searchParams.get('visit') ?? '';
			if (!safeVisit(visit)) return json({ error: 'bad visit' }, 400);
			const meta = await env.UX_REPLAY.get(`${KEY_PREFIX}${visit}/_meta`);
			return meta ? json(await meta.json()) : json({ error: 'not found' }, 404);
		}
		case 'admin/replay/chunk': {
			const visit = url.searchParams.get('visit') ?? '';
			const idx = Number(url.searchParams.get('index'));
			if (!safeVisit(visit) || !Number.isInteger(idx) || idx < 0 || idx >= MAX_CHUNKS)
				return json({ error: 'bad request' }, 400);
			const obj = await env.UX_REPLAY.get(`${KEY_PREFIX}${visit}/chunk-${String(idx).padStart(4, '0')}`);
			return obj ? new Response(obj.body, { headers: { 'content-type': 'application/json' } }) : json({ error: 'not found' }, 404);
		}
		default:
			return json({ error: 'not found' }, 404);
	}
}
