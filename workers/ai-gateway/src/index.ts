/**
 * cic-ai-gateway — zero-retention AI proxy (Cloudflare Worker).
 *
 * Routes /ai/chat, /ai/stt, /ai/tts to a pluggable provider selected by
 * AI_PROVIDER. Nothing is persisted: no KV, no DO, no request logging beyond
 * platform telemetry — bodies are streamed through and dropped. When pointed
 * at an upstream provider, ZDR/no-training is enforced by the provider config
 * (Groq/OpenRouter ZDR routes, Anthropic enterprise ZDR) — pick one whose
 * terms satisfy the privacy posture; Cloudflare Workers AI (default) keeps
 * inference inside the same trust boundary.
 *
 * Env/secrets:
 *   AI_PROVIDER      — 'workers-ai' (default) | 'groq' | 'openrouter' | 'anthropic'
 *   AI_API_KEY       — upstream key for non-CF providers (wrangler secret put)
 *   AI_CHAT_MODEL    — default '@cf/meta/llama-3.2-3b-instruct' (CF) or provider model
 *   AI_STT_MODEL     — default '@cf/openai/whisper-large-v3-turbo'
 *   AI_TTS_MODEL     — default '@cf/deepgram/aura-1'
 *   AI_BASE_URL      — override upstream base (OpenRouter/compatible endpoints)
 *
 * Client contract (src/lib/ai/cloud.ts):
 *   POST /ai/chat {system, context[], prompt} → {text}
 *   POST /ai/stt  {audio: b64-f32, sampleRate} → {text}
 *   POST /ai/tts  {text, voice?} → {audio: b64-f32, sampleRate}
 */

export interface Env {
	AI?: Ai; // workers-ai binding
	AI_PROVIDER?: string;
	AI_API_KEY?: string;
	AI_CHAT_MODEL?: string;
	AI_STT_MODEL?: string;
	AI_TTS_MODEL?: string;
	AI_BASE_URL?: string;
	METER?: DurableObjectNamespace<MeterBus>; // per-room metered pools
	AE?: AnalyticsEngineDataset; // opt-in anonymous quality telemetry
	TURNSTILE_SECRET?: string; // siteverify on paid lanes when set
	GRANT_PUBKEY?: string; // Ed25519 hex — verifies top-up grants
	GRANT_SECRET?: string; // Ed25519 hex seed — /admin/mint signs grants
	CF_ACCESS_TEAM?: string; // e.g. 'yourteam.cloudflareaccess.com'
	CF_ACCESS_AUD?: string; // Access application AUD tag
}

const PROVIDER_URLS: Record<string, string> = {
	groq: 'https://api.groq.com/openai/v1',
	openrouter: 'https://openrouter.ai/api/v1',
	anthropic: 'https://api.anthropic.com/v1'
};

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'cache-control': 'no-store'
};

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
		const url = new URL(req.url);
		try {
			if (url.pathname === '/ai/chat' && req.method === 'POST')
				return await chat(req, env);
			if (url.pathname === '/ai/stt' && req.method === 'POST')
				return await stt(req, env);
			if (url.pathname === '/ai/tts' && req.method === 'POST')
				return await tts(req, env);
			if (url.pathname === '/ai/entitlement' && req.method === 'GET')
				return await entitlement(url, env);
			if (url.pathname === '/ai/usage' && req.method === 'POST')
				return await usage(req, env, ctx);
			if (url.pathname === '/ai/topup' && req.method === 'POST')
				return await topup(req, env, ctx);
			if (url.pathname === '/admin/overview' && req.method === 'GET')
				return await adminOverview(req, env);
			if (url.pathname === '/admin/mint' && req.method === 'POST')
				return await adminMint(req, env);
			if (url.pathname.startsWith('/ai/pack/') && req.method === 'GET')
				return await pack(url.pathname.slice(9));
			if (url.pathname === '/ai/telemetry' && req.method === 'POST')
				return await telemetry(req, env);
			if (url.pathname === '/ai/status' && req.method === 'GET')
				return json({
					ok: true,
					provider: env.AI_PROVIDER ?? 'workers-ai',
					models: { chat: env.AI_CHAT_MODEL, stt: env.AI_STT_MODEL, tts: env.AI_TTS_MODEL },
					entitlements: !!env.METER
				});
			return json({ error: 'not found' }, 404);
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : 'upstream' }, 502);
		}
	}
};

// ------------------------------------------------------------- chat (Milo)

async function chat(req: Request, env: Env): Promise<Response> {
	if (!(await humanOk(env, req.headers.get('cf-turnstile'), req.headers.get('cf-connecting-ip'))))
		return json({ error: 'turnstile' }, 403);
	const { system, context, prompt } = (await req.json()) as {
		system: string;
		context?: string[];
		prompt: string;
	};
	const user = `Transcript window:\n${(context ?? []).join('\n')}\n\nQuestion: ${prompt}`;
	const provider = env.AI_PROVIDER ?? 'workers-ai';

	if (provider === 'workers-ai') {
		if (!env.AI) return json({ error: 'workers-ai binding missing' }, 503);
		const res = await env.AI.run(env.AI_CHAT_MODEL ?? '@cf/meta/llama-3.2-3b-instruct', {
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user }
			],
			max_tokens: 128
		});
		return json({ text: (res as { response?: string }).response ?? '' });
	}

	if (provider === 'anthropic') {
		const res = await upstream(env, '/messages', {
			model: env.AI_CHAT_MODEL ?? 'claude-haiku-4-5',
			max_tokens: 128,
			system,
			messages: [{ role: 'user', content: user }]
		});
		const body = (await res.json()) as { content?: { text?: string }[] };
		return json({ text: body.content?.[0]?.text ?? '' });
	}

	// OpenAI-compatible (groq / openrouter / custom base)
	const res = await upstream(env, '/chat/completions', {
		model: env.AI_CHAT_MODEL ?? 'llama-3.1-8b-instant',
		max_tokens: 128,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user }
		]
	});
	const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return json({ text: body.choices?.[0]?.message?.content ?? '' });
}

// ------------------------------------------------------------- stt / tts

async function stt(req: Request, env: Env): Promise<Response> {
	const { audio, sampleRate } = (await req.json()) as { audio: string; sampleRate: number };
	if (!audio) return json({ text: '' });
	if (env.AI) {
		// Workers AI whisper-family wants raw PCM16/bytes
		const pcm = f32B64To16(audio);
		const res = await env.AI.run(env.AI_STT_MODEL ?? '@cf/openai/whisper-large-v3-turbo', {
			audio: [...new Uint8Array(pcm)]
		});
		return json({ text: (res as { text?: string }).text ?? '' });
	}
	return json({ error: 'stt provider unconfigured' }, 503);
}

async function tts(req: Request, env: Env): Promise<Response> {
	const { text, voice } = (await req.json()) as { text: string; voice?: string };
	if (!text) return json({ audio: '', sampleRate: 22050 });
	if (env.AI) {
		const res = (await env.AI.run(env.AI_TTS_MODEL ?? '@cf/deepgram/aura-1', {
			text,
			...(voice ? { speaker: voice } : {})
		})) as { audio?: string; sample_rate?: number };
		if (res.audio) {
			// aura returns base64 mp3/pcm depending on model — pass through; the
			// client's cloudTts already tolerates provider shapes
			return json({ audio: res.audio, sampleRate: res.sample_rate ?? 22050 });
		}
	}
	return json({ error: 'tts provider unconfigured' }, 503);
}

// ------------------------------------------------------------- entitlement + telemetry

/** GET /ai/entitlement?room= → {paid, balanceSeconds, spentSeconds}
 *  metered account: paid while balance > 0 (streaming spend) */
async function entitlement(url: URL, env: Env): Promise<Response> {
	const room = url.searchParams.get('room');
	if (!room) return json({ error: 'room required' }, 400);
	if (!env.METER) return json({ paid: false });
	return meter(env, room, 'get', {});
}

/**
 * POST /ai/usage {room, seconds, calls?} — the streaming-spend lane.
 * Clients heartbeat paid-resource seconds (SFU fanout, sensory, edge DSP)
 * and AI call counts; the room's MeterBus DO debits atomically (single-
 * threaded per room — atomic by construction) and returns the balance —
 * at zero, paid lanes drop back to on-device. Each call = CALL_COST s.
 */
const CALL_COST = 5;
async function usage(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
	if (!env.METER) return json({ balanceSeconds: 0 });
	const { room, seconds, calls } = (await req.json()) as {
		room?: string;
		seconds?: number;
		calls?: number;
	};
	if (!room) return json({ error: 'room required' }, 400);
	const debit = Math.max(0, Math.min(3600, Math.round(seconds ?? 0))) +
		Math.max(0, Math.min(1000, Math.round(calls ?? 0))) * CALL_COST;
	const res = await meter(env, room, 'debit', { amount: debit });
	indexReport(env, ctx, room, res.clone());
	return res;
}

/**
 * POST /ai/topup {room, grant} — credit the pool. Grant = base64url JSON
 * {seconds, nonce, sig}; sig = Ed25519("room.seconds.nonce") by the
 * operator key (GRANT_PUBKEY env, hex). Whatever payment rail the operator
 * wires (checkout, crypto, invoice) mints grants after settlement —
 * streaming payments land as sequential top-ups. Signature + nonce replay
 * check happen in the global MeterBus (nonce store shared across rooms).
 */
async function topup(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
	if (!env.METER || !env.GRANT_PUBKEY) return json({ error: 'topup unconfigured' }, 503);
	const { room, grant } = (await req.json()) as { room?: string; grant?: string };
	if (!room || !grant) return json({ error: 'room + grant required' }, 400);
	let seconds: number;
	try {
		const g = JSON.parse(atob(grant.replace(/-/g, '+').replace(/_/g, '/'))) as {
			seconds?: number;
			nonce?: string;
			sig?: string;
		};
		if (!g.seconds || !g.nonce || !g.sig) throw new Error('bad grant');
		const key = await crypto.subtle.importKey(
			'raw', hexToBytes(env.GRANT_PUBKEY), 'Ed25519', false, ['verify']
		);
		const ok = await crypto.subtle.verify(
			'Ed25519', key, hexToBytes(g.sig),
			new TextEncoder().encode(`${room}.${g.seconds}.${g.nonce}`)
		);
		if (!ok) throw new Error('bad signature');
		seconds = g.seconds;
		const claim = await meter(env, '__grants__', 'claim', { nonce: g.nonce });
		if (!claim.ok) throw new Error('grant already redeemed');
	} catch (e) {
		return json({ error: `invalid grant: ${e instanceof Error ? e.message : 'x'}` }, 403);
	}
	const credited = await meter(env, room, 'credit', { amount: seconds });
	indexReport(env, ctx, room, credited.clone());
	return json({ ok: true, creditedSeconds: seconds });
}

/** feed the shared '__index__' MeterBus with each room's latest numbers */
function indexReport(env: Env, ctx: ExecutionContext | undefined, room: string, res: Response): void {
	if (!env.METER) return;
	const work = res
		.json()
		.then((b) =>
			meter(env, '__index__', 'report', {
				room,
				...(b as Record<string, unknown>)
			})
		)
		.catch(() => {});
	if (ctx) ctx.waitUntil(work);
	else void work;
}

// ------------------------------------------------------------- enterprise console
//
// Cloudflare Access fronts /admin/* — the JWT arrives as the
// Cf-Access-Jwt-Assertion header; we verify RS256 against the team JWKS
// (cached), check aud + exp, and reject anything else. Zero-dependency:
// WebCrypto does RS256 verification natively. Pseudonymity is preserved —
// the console only ever sees room codes and resource numbers.

let jwksCache: { keys: JsonWebKey[]; at: number } | null = null;

async function accessUser(req: Request, env: Env): Promise<string | null> {
	if (!env.CF_ACCESS_TEAM || !env.CF_ACCESS_AUD) return null;
	const jwt = req.headers.get('cf-access-jwt-assertion');
	if (!jwt) return null;
	const [h, p, sig] = jwt.split('.');
	if (!h || !p || !sig) return null;
	const header = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/'))) as { kid?: string };
	const payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))) as {
		aud?: string | string[];
		exp?: number;
		email?: string;
	};
	if (payload.exp && payload.exp * 1000 < Date.now()) return null;
	const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!auds.includes(env.CF_ACCESS_AUD)) return null;
	if (!jwksCache || Date.now() - jwksCache.at > 300_000) {
		const r = await fetch(`https://${env.CF_ACCESS_TEAM}/cdn-cgi/access/certs`);
		if (!r.ok) return null;
		jwksCache = { keys: ((await r.json()) as { keys: JsonWebKey[] }).keys, at: Date.now() };
	}
	const jwk = jwksCache.keys.find((k) => (k as { kid?: string }).kid === header.kid);
	if (!jwk) return null;
	const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
	const ok = await crypto.subtle.verify(
		'RSASSA-PKCS1-v1_5',
		key,
		Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
		new TextEncoder().encode(`${h}.${p}`)
	);
	return ok ? (payload.email ?? 'access-user') : null;
}

/** GET /admin/overview — room spend table for the console UI */
async function adminOverview(req: Request, env: Env): Promise<Response> {
	if (!env.CF_ACCESS_TEAM) return json({ error: 'console unconfigured' }, 503);
	const user = await accessUser(req, env);
	if (!user) return json({ error: 'forbidden' }, 403);
	if (!env.METER) return json({ user, rooms: [] });
	const res = await meter(env, '__index__', 'list', {});
	const body = (await res.json()) as { rooms?: unknown };
	return json({ user, rooms: body.rooms ?? {} });
}

/** POST /admin/mint {room, seconds} — server-signed top-up grant */
async function adminMint(req: Request, env: Env): Promise<Response> {
	if (!env.CF_ACCESS_TEAM) return json({ error: 'console unconfigured' }, 503);
	if (!(await accessUser(req, env))) return json({ error: 'forbidden' }, 403);
	if (!env.GRANT_SECRET) return json({ error: 'mint unconfigured' }, 503);
	const { room, seconds } = (await req.json()) as { room?: string; seconds?: number };
	if (!room || !seconds || seconds <= 0 || seconds > 86_400)
		return json({ error: 'room + seconds (1..86400) required' }, 400);
	// PKCS8-wrap the 32B Ed25519 seed → WebCrypto sign key
	const seed = hexToBytes(env.GRANT_SECRET);
	const pkcs8 = new Uint8Array([...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], ...seed]);
	const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
	const nonce = crypto.randomUUID();
	const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(`${room}.${seconds}.${nonce}`));
	const grant = btoa(JSON.stringify({ seconds, nonce, sig: btoa(String.fromCharCode(...new Uint8Array(sig))) }))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return json({ ok: true, room, grant });
}

function meter(env: Env, room: string, op: string, body: object): Promise<Response> {
	const stub = env.METER!.get(env.METER!.idFromName(room));
	return stub.fetch(`https://meter/${op}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

/**
 * MeterBus DO — one instance per room: {balance, spent} in storage.
 * Single-threaded per room → debits are atomic by construction, no D1
 * needed. The shared '__grants__' instance holds redeemed grant nonces.
 * Hibernates idle; storage is KV-backed (per-key, no schema).
 */
export class MeterBus implements DurableObject {
	constructor(private ctx: DurableObjectState) {}

	async fetch(req: Request): Promise<Response> {
		const op = new URL(req.url).pathname;
		const b = (await req.json().catch(() => ({}))) as {
			amount?: number;
			nonce?: string;
		};
		const s = this.ctx.storage;
		if (op === '/get') {
			const balance = (await s.get<number>('balance')) ?? 0;
			const spent = (await s.get<number>('spent')) ?? 0;
			return json({ paid: balance > 0, balanceSeconds: balance, spentSeconds: spent });
		}
		if (op === '/debit') {
			const amount = b.amount ?? 0;
			const balance = Math.max(0, ((await s.get<number>('balance')) ?? 0) - amount);
			const spent = ((await s.get<number>('spent')) ?? 0) + amount;
			await s.put({ balance, spent });
			return json({ paid: balance > 0, balanceSeconds: balance, spentSeconds: spent });
		}
		if (op === '/credit') {
			const balance = ((await s.get<number>('balance')) ?? 0) + (b.amount ?? 0);
			await s.put('balance', balance);
			return json({ ok: true, balanceSeconds: balance });
		}
		if (op === '/claim') {
			// nonce replay guard — first claim wins, forever
			if (!b.nonce) return json({ ok: false }, 400);
			if (await s.get(`nonce:${b.nonce}`)) return json({ ok: false }, 409);
			await s.put(`nonce:${b.nonce}`, 1);
			return json({ ok: true });
		}
		if (op === '/report') {
			// '__index__' instance only: record a room's latest meter state —
			// what /admin/overview reads. Pseudonymous: room code + numbers.
			const room = (b as { room?: string }).room;
			if (!room) return json({ ok: false }, 400);
			await s.put(`room:${room}`, {
				balanceSeconds: (b as { balanceSeconds?: number }).balanceSeconds ?? null,
				spentSeconds: (b as { spentSeconds?: number }).spentSeconds ?? null,
				lastSeen: Date.now()
			});
			return json({ ok: true });
		}
		if (op === '/list') {
			const rooms: Record<string, unknown> = {};
			for await (const [k, v] of await s.list<unknown>({ prefix: 'room:' }))
				rooms[k.slice(5)] = v;
			return json({ rooms });
		}
		return json({ error: 'unknown op' }, 404);
	}
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/**
 * GET /ai/pack/<kind> — stream the on-device model pack through our origin.
 * The manifest's upstream tarballs (github release assets) carry no CORS
 * headers, so browsers on the deployed site can't fetch them directly —
 * this proxies a fixed allowlist, streams the body, and sets ACAO:* +
 * long cache. Free-tier speech works on the public site via this lane.
 */
const PACK_URLS: Record<string, string> = {
	vad: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-wasm-simd-v1.13.8-vad.tar.bz2',
	asr: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer.tar.bz2',
	tts: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-wasm-simd-1.13.8-vits-piper-en_US-libritts_r-medium.tar.bz2',
	// keep in sync with models/manifest.json packs.llm — the on-device
	// LLM (Milo + translation) rides the same CORS-safe lane; HF's
	// resolve CDN can't be relied on for the CORP header our COEP
	// document requires
	llm: 'https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf'
};
async function pack(kind: string): Promise<Response> {
	const url = PACK_URLS[kind];
	if (!url) return json({ error: 'unknown pack' }, 404);
	// cacheEverything at the edge — these are large immutable release
	// assets; repeat joins shouldn't re-pull upstream each time
	const up = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 2592000 } });
	if (!up.ok || !up.body) return json({ error: `upstream ${up.status}` }, 502);
	return new Response(up.body, {
		headers: {
			...cors,
			'content-type': kind === 'llm' ? 'application/octet-stream' : 'application/x-bzip2',
			'cache-control': 'public, max-age=2592000, immutable'
		}
	});
}

/** POST /ai/telemetry — opt-in anonymous quality points → Analytics Engine */
async function telemetry(req: Request, env: Env): Promise<Response> {
	if (!env.AE) return json({ ok: true }); // dataset unbound → accept+drop
	const { level, room } = (await req.json()) as { level?: number; room?: string };
	env.AE.writeDataPoint({
		blobs: [room ? room.slice(0, 8) : 'anon'], // room hash prefix only
		doubles: [level ?? 0],
		indexes: ['quality']
	});
	return json({ ok: true });
}

/** Turnstile siteverify — call on paid lanes when TURNSTILE_SECRET is set */
async function humanOk(env: Env, token: string | null, ip: string | null): Promise<boolean> {
	if (!env.TURNSTILE_SECRET) return true; // unset = gate off (self-host default)
	if (!token) return false;
	const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: `secret=${env.TURNSTILE_SECRET}&response=${token}${ip ? `&remoteip=${ip}` : ''}`
	});
	const body = (await res.json()) as { success?: boolean };
	return body.success === true;
}

// ------------------------------------------------------------- helpers

async function upstream(env: Env, path: string, body: unknown): Promise<Response> {
	const base = env.AI_BASE_URL ?? PROVIDER_URLS[env.AI_PROVIDER ?? ''] ?? '';
	if (!base || !env.AI_API_KEY) throw new Error('provider unconfigured');
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		authorization: `Bearer ${env.AI_API_KEY}`
	};
	if (env.AI_PROVIDER === 'anthropic') headers['anthropic-version'] = '2023-06-01';
	const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`upstream ${res.status}`);
	return res;
}

function f32B64To16(b64: string): ArrayBuffer {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const f32 = new Float32Array(bytes.buffer);
	const i16 = new Int16Array(f32.length);
	for (let i = 0; i < f32.length; i++)
		i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
	return i16.buffer;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...cors }
	});
}
