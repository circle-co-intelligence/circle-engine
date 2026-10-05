/**
 * /api/feedback — exit-screen session feedback.
 *
 * The vendored app's post-call screen posts {sessionId, roomCode, permit,
 * rating, text} when the user explicitly submits "How valuable was your
 * session?". This is user-authored content sent deliberately — not
 * telemetry — so it stores verbatim (bounded) rather than enum-scrubbing:
 *
 *   POST → R2 cic-ux-replay under feedback/{room}/{session}/{permit8}-{ts}
 *          validated: sessionId token-shape, roomCode 6 digits, permit
 *          credential-shape, rating int 1-5, text <= 1200 chars
 *   GET  → admin-only (UX_ADMIN bearer): list recent feedback, optional
 *          ?room= filter. Never public.
 *
 * The permit is the attendee's welcome sessionToken — a presence
 * credential, not a secret we can verify server-side (tokens are minted
 * in-browser by the bridge). It proves the submitter code path ran inside
 * a real session; abuse ceiling is bounded free-text blobs in a private
 * bucket, rate-limited at the edge if ever needed.
 */

import { z } from 'zod';

interface Env {
	UX_REPLAY?: R2Bucket;
	UX_ADMIN?: string;
}

const KEY_PREFIX = 'feedback/';
const MAX_TEXT = 1200;
const MAX_BODY = 8 * 1024;

const FeedbackBody = z.object({
	sessionId: z.string().regex(/^[\w-]{3,80}$/),
	roomCode: z.string().regex(/^\d{6}$/),
	permit: z.string().regex(/^[0-9a-f-]{8,64}$/i),
	rating: z.number().int().min(1).max(5),
	text: z.string().max(100_000) // raw bound; truncated to MAX_TEXT below
});

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
	if (!env.UX_REPLAY) return new Response(null, { status: 204 });
	const len = Number(request.headers.get('content-length') ?? 0);
	if (len > MAX_BODY) return new Response(null, { status: 413 });
	let body: { sessionId?: string; roomCode?: string; permit?: string; rating?: number; text?: string };
	try {
		body = await request.json();
	} catch {
		return new Response(null, { status: 400 });
	}
	const parsed = FeedbackBody.safeParse(body);
	if (!parsed.success) return new Response(null, { status: 400 });
	const { sessionId, roomCode, permit, rating, text } = parsed.data;
	await env.UX_REPLAY.put(
		`${KEY_PREFIX}${roomCode}/${sessionId}/${permit.slice(0, 8)}-${Date.now()}`,
		JSON.stringify({ roomCode, sessionId, rating, text: text.slice(0, MAX_TEXT), at: Date.now() }),
		{ httpMetadata: { contentType: 'application/json' } }
	);
	return json({ ok: true });
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
	if (!env.UX_ADMIN || request.headers.get('authorization') !== `Bearer ${env.UX_ADMIN}`)
		return json({ error: 'forbidden' }, 403);
	if (!env.UX_REPLAY) return json({ error: 'feedback not configured' }, 503);
	const url = new URL(request.url);
	const room = url.searchParams.get('room');
	if (room !== null && !/^\d{6}$/.test(room)) return json({ error: 'bad room' }, 400);
	const l = await env.UX_REPLAY.list({
		prefix: `${KEY_PREFIX}${room ?? ''}`,
		limit: 100,
		cursor: url.searchParams.get('cursor') ?? undefined
	});
	const items: unknown[] = [];
	for (const o of l.objects.slice(0, 50)) {
		const obj = await env.UX_REPLAY.get(o.key);
		if (obj) items.push({ key: o.key, ...(await obj.json() as Record<string, unknown>) });
	}
	return json({ items, cursor: l.truncated ? l.cursor : null });
};
