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

import { z } from 'zod';
import { base64urlnopad } from '@scure/base';

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
const PAGES = ['setup', 'join', 'prejoin', 'room'] as const;
const EVENTS = [
	'visit_start', 'visit_end', 'activation', 'ack', 'success',
	'failure', 'dead', 'rage', 'step', 'coverage'
] as const;
const STEPS = [
	'setup_opened', 'room_created', 'prejoin_opened', 'join_succeeded',
	'tool_opened', 'tool_acknowledged', 'tool_succeeded'
] as const;
const TARGETS = [
	'create_room', 'join_room', 'microphone', 'camera', 'settings',
	'chat', 'recording', 'transcript', 'milo', 'share', 'layout', 'leave'
] as const;
const ROLES = ['host', 'participant', 'unknown'] as const;
const DEVICES = ['mobile', 'tablet', 'desktop'] as const;
const BROWSERS = ['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera', 'other'] as const;
const REPLAY_STATUS = ['completed', 'capped', 'failed'] as const;

const MAX_BODY = 64 * 1024;
const MAX_CHUNK_BODY = 300 * 1024;
const MAX_EVENTS_BATCH = 40;
const MAX_CHUNK_EVENTS = 64;
const MAX_CHUNKS = 64;
const TOKEN_TTL_S = 24 * 3600;
const KEY_PREFIX = 'ux-replay/';

// ------------------------------------------------------------------- utils
const b64url = (buf: ArrayBuffer | Uint8Array): string =>
	base64urlnopad.encode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
const unb64url = (s: string): Uint8Array => base64urlnopad.decode(s);

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
const EventSchema = z.object({
	v: z.literal(1),
	detector: z.literal(1),
	visitId: z.string().regex(/^[0-9a-f-]{36}$/i),
	eventId: z.string().max(80),
	seq: z.number().int().min(0).max(1e6),
	at: z.number().min(0).max(1e13),
	page: z.enum(PAGES),
	event: z.enum(EVENTS),
	release: z.string().regex(/^[\w.+-]{1,40}$/),
	device: z.enum(DEVICES),
	browser: z.enum(BROWSERS),
	browserMajor: z.number().min(0).max(999),
	role: z.enum(ROLES),
	target: z.enum(TARGETS).optional(),
	actionId: z.number().min(0).max(1e6).optional(),
	step: z.enum(STEPS).optional(),
	incomplete: z.boolean().optional(),
	dropped: z.number().min(0).max(1e6).optional()
});

function cleanEvent(e: unknown): Record<string, unknown> | null {
	const r = EventSchema.safeParse(e);
	if (!r.success) return null;
	const { v: _v, detector: _d, eventId: _e, ...out } = r.data;
	return out;
}

// ------------------------------------------------------------------ replay
const safeVisit = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

const ChunkBody = z.object({
	visitId: z.string().regex(/^[0-9a-f-]{36}$/i),
	chunkIndex: z.number().int().min(0).max(MAX_CHUNKS - 1),
	events: z
		.array(z.object({ type: z.number().int().min(0).max(4) }).passthrough())
		.nonempty()
		.max(MAX_CHUNK_EVENTS)
});
const CloseBody = z.object({
	visitId: z.string().regex(/^[0-9a-f-]{36}$/i),
	status: z.enum(REPLAY_STATUS)
});

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
	const parsed = ChunkBody.safeParse(body);
	const tok = await verifyToken(env.UX_HMAC!, String(body.token ?? ''));
	if (!tok || !parsed.success || parsed.data.visitId !== tok.visitId)
		return new Response(null, { status: 400 });
	const { visitId: visit, chunkIndex, events } = parsed.data;
	await env.UX_REPLAY.put(`${KEY_PREFIX}${visit}/chunk-${String(chunkIndex).padStart(4, '0')}`, JSON.stringify(events), {
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
	const parsed = CloseBody.safeParse(body);
	const tok = await verifyToken(env.UX_HMAC!, String(body.token ?? ''));
	if (!tok || !parsed.success || parsed.data.visitId !== tok.visitId)
		return new Response(null, { status: 400 });
	const { visitId: visit, status } = parsed.data;
	await env.UX_REPLAY.put(
		`${KEY_PREFIX}${visit}/_meta`,
		JSON.stringify({ status, closedAt: Date.now() }),
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
