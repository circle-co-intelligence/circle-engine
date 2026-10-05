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
 *   AI_PROVIDER      — 'workers-ai' (default) | 'groq' | 'openrouter' | 'anthropic' | 'openai'
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
import { createRemoteJWKSet, jwtVerify } from 'jose';


export interface Env {
	AI?: Ai; // workers-ai binding
	AI_PROVIDER?: string;
	AI_API_KEY?: string;
	AI_CHAT_MODEL?: string;
	AI_STT_MODEL?: string;
	AI_TTS_MODEL?: string;
	AI_BASE_URL?: string;
	/** default reasoning intensity for reasoning models (low|medium|high) */
	AI_REASONING_EFFORT?: string;
	/** JSON array of models callers may select per-request, e.g.
	 *  '["gpt-5-mini","gpt-5"]' — unset = client model overrides ignored */
	AI_MODEL_ALLOWLIST?: string;
	METER?: DurableObjectNamespace<MeterBus>; // per-room metered pools
	AE?: AnalyticsEngineDataset; // opt-in anonymous quality telemetry
	TURNSTILE_SECRET?: string; // siteverify on paid lanes when set
	GRANT_PUBKEY?: string; // Ed25519 hex — verifies top-up grants
	GRANT_SECRET?: string; // Ed25519 hex seed — /admin/mint signs grants
	CF_ACCESS_TEAM?: string; // e.g. 'yourteam.cloudflareaccess.com'
	CF_ACCESS_AUD?: string; // Access application AUD tag
	METER_TOKEN?: string; // this worker's MeterBus capability token (spend role)
	METER_ACL?: string; // JSON {sha256hex(token): 'admin'|'spend'|'probe'} — hardening gate
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

/** JSON allowlist of caller-selectable models; null = overrides ignored */
function parseModelAllowlist(raw?: string): Set<string> | null {
	if (!raw) return null;
	try {
		const arr = JSON.parse(raw) as unknown;
		return Array.isArray(arr) ? new Set(arr.filter((m): m is string => typeof m === 'string')) : null;
	} catch {
		return null;
	}
}

const PROVIDER_URLS: Record<string, string> = {
	groq: 'https://api.groq.com/openai/v1',
	openrouter: 'https://openrouter.ai/api/v1',
	anthropic: 'https://api.anthropic.com/v1',
	openai: 'https://api.openai.com/v1'
};

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers':
		'content-type, x-cic-account, x-cic-pub, x-cic-ts, x-cic-nonce, x-cic-sig',
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
				return await entitlement(req, env);
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
					entitlements: !!env.METER,
					meterAcl: !!env.METER_ACL
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
	const { system, context, prompt, model, effort } = (await req.json()) as {
		system: string;
		context?: string[];
		prompt: string;
		/** per-call model override — honored only when the model is in
		 *  AI_MODEL_ALLOWLIST (unset = overrides ignored); keeps anonymous
		 *  callers from choosing arbitrary expensive models on our key */
		model?: string;
		/** reasoning intensity — validated against a fixed set */
		effort?: string;
	};
	const allowed = parseModelAllowlist(env.AI_MODEL_ALLOWLIST);
	const modelOverride = model && allowed?.has(model) ? model : undefined;
	const effortClean = effort && EFFORTS.has(effort) ? effort : undefined;
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

	// OpenAI-compatible (groq / openrouter / openai / custom base)
	const reasoning = effortClean ?? env.AI_REASONING_EFFORT;
	const res = await upstream(env, '/chat/completions', {
		model: modelOverride ?? env.AI_CHAT_MODEL ?? 'llama-3.1-8b-instant',
		max_tokens: 128,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user }
		],
		// only forwarded when configured — non-reasoning models reject it
		...(reasoning ? { reasoning_effort: reasoning } : {})
	});
	const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return json({ text: body.choices?.[0]?.message?.content ?? '' });
}

// ------------------------------------------------------------- stt / tts

async function stt(req: Request, env: Env): Promise<Response> {
	const { audio, sampleRate, language } = (await req.json()) as {
		audio: string;
		sampleRate: number;
		/** optional whisper language hint (ISO 639-1); unset = auto-detect —
		 *  whisper-large-v3-turbo covers ~99 languages incl. code-switching */
		language?: string;
	};
	if (!audio) return json({ text: '' });
	if (env.AI) {
		// Workers AI whisper-family wants raw PCM16/bytes
		const pcm = f32B64To16(audio);
		const res = await env.AI.run(env.AI_STT_MODEL ?? '@cf/openai/whisper-large-v3-turbo', {
			audio: [...new Uint8Array(pcm)],
			...(language ? { language } : {})
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

/** GET /ai/entitlement?room=&account= → {paid, balanceSeconds, spentSeconds, source}
 *  metered account: paid while a covering balance > 0 (streaming spend).
 *  Precedence — host sponsorship → the caller's own account wallet → the
 *  room pool (direct top-ups / signed grants). */
async function entitlement(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	const room = url.searchParams.get('room');
	if (!room) return json({ error: 'room required' }, 400);
	if (!env.METER) return json({ paid: false });
	// account lane only counts when the caller proves the key — a bare
	// accountId is a public identifier, not a credential
	const claimed = req.headers.get('x-cic-account');
	const verified = claimed ? await verifyAccountSig(env, req, '/ai/entitlement', '', claimed) : null;
	const pick = await pickPool(env, room, verified ? claimed : null);
	return json({ source: pick.source, ...pick.info });
}

/**
 * POST /ai/usage {room, seconds, calls?, account?} — the streaming-spend lane.
 * Clients heartbeat paid-resource seconds (SFU fanout, sensory, edge DSP)
 * and AI call counts; the covering MeterBus pool debits atomically (single-
 * threaded per instance — atomic by construction) and returns the balance —
 * at zero, paid lanes drop back to on-device. Each call = CALL_COST s.
 */
const CALL_COST = 5;
async function usage(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
	if (!env.METER) return json({ balanceSeconds: 0 });
	const raw = await req.text();
	const { room, seconds, calls, account } = JSON.parse(raw || '{}') as {
		room?: string;
		seconds?: number;
		calls?: number;
		account?: string;
	};
	if (!room) return json({ error: 'room required' }, 400);
	// account spend requires a valid signature — unsigned/invalid requests
	// degrade to the room pool, they can never touch a wallet
	const verified = account ? await verifyAccountSig(env, req, '/ai/usage', raw, account) : null;
	const debit = Math.max(0, Math.min(3600, Math.round(seconds ?? 0))) +
		Math.max(0, Math.min(1000, Math.round(calls ?? 0))) * CALL_COST;
	const pick = await pickPool(env, room, verified ? account : null);
	// Wallet debits carry the client's own signature through to the DO — the
	// ledger re-verifies it against the account's registered keys, so a
	// compromised worker here still can't move wallet funds. Auth is only
	// forwarded when it proves THIS wallet (sponsor lanes use the room record).
	const auth =
		verified && pick.pool === `acct:${account}`
			? {
					pub: req.headers.get('x-cic-pub') ?? undefined,
					ts: Number(req.headers.get('x-cic-ts')),
					nonce: req.headers.get('x-cic-nonce') ?? undefined,
					sig: req.headers.get('x-cic-sig') ?? undefined,
					method: 'POST',
					path: '/ai/usage',
					body: raw
				}
			: undefined;
	const res = await meter(env, pick.pool, 'debit', { amount: debit, room, auth });
	indexReport(env, ctx, pick.pool, res.clone());
	return res;
}

interface PoolInfo {
	paid?: boolean;
	balanceSeconds?: number;
	spentSeconds?: number;
	sponsor?: string | null;
}

/** which pool covers this room+caller — sponsor's wallet, then the caller's
 *  own wallet, then the room pool itself */
async function pickPool(
	env: Env,
	room: string,
	account?: string | null
): Promise<{ pool: string; source: 'sponsor' | 'account' | 'room'; info: PoolInfo }> {
	const roomInfo = (await (await meter(env, room, 'get', {})).json()) as PoolInfo;
	if (roomInfo.sponsor) {
		const sp = (await (await meter(env, `acct:${roomInfo.sponsor}`, 'get', {})).json()) as PoolInfo;
		if ((sp.balanceSeconds ?? 0) > 0)
			return { pool: `acct:${roomInfo.sponsor}`, source: 'sponsor', info: sp };
	}
	if (account) {
		const a = (await (await meter(env, `acct:${account}`, 'get', {})).json()) as PoolInfo;
		if ((a.balanceSeconds ?? 0) > 0) return { pool: `acct:${account}`, source: 'account', info: a };
	}
	return { pool: room, source: 'room', info: roomInfo };
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
// via jose (built-in kid lookup + aud/exp validation + key caching), and
// reject anything else. Pseudonymity is preserved — the console only ever
// sees room codes and resource numbers.

async function accessUser(req: Request, env: Env): Promise<string | null> {
	if (!env.CF_ACCESS_TEAM || !env.CF_ACCESS_AUD) return null;
	const jwt = req.headers.get('cf-access-jwt-assertion');
	if (!jwt) return null;
	try {
		const { payload } = await jwtVerify(
			jwt,
			createRemoteJWKSet(new URL(`https://${env.CF_ACCESS_TEAM}/cdn-cgi/access/certs`)),
			{ audience: env.CF_ACCESS_AUD }
		);
		return typeof payload.email === 'string' ? payload.email : 'access-user';
	} catch {
		return null;
	}
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

/**
 * verifyAccountSig — the shared account-key check (same scheme as cic-pay):
 * x-cic-pub/ts/nonce/sig headers; the signing key is the account's primary
 * (sha256(pub)==accountId) or a registered delegate (acct:<id>.key:<hash>).
 * Returns true only when the request proves key possession — callers must
 * treat unverified 'account' params as absent, never as credentials.
 */
async function verifyAccountSig(
	env: Env,
	req: Request,
	path: string,
	rawBody: string,
	claimed: string
): Promise<boolean> {
	try {
		const pubHex = req.headers.get('x-cic-pub');
		const ts = Number(req.headers.get('x-cic-ts'));
		const nonce = req.headers.get('x-cic-nonce');
		const sigHex = req.headers.get('x-cic-sig');
		if (!pubHex || !ts || !nonce || !sigHex) return false;
		if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
		const pub = hexToBytes(pubHex);
		const sig = hexToBytes(sigHex);
		const enc = new TextEncoder();
		const digest = async (d: Uint8Array | string) =>
			new Uint8Array(await crypto.subtle.digest('SHA-256', (typeof d === 'string' ? enc.encode(d) : d) as BufferSource));
		const toHexS = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
		const keyHash = toHexS(await digest(pub));
		if (keyHash !== claimed) {
			const reg = await meter(env, `acct:${claimed}`, 'kvget', { key: `key:${keyHash}` });
			if (!(((await reg.json()) as { value?: unknown }).value)) return false;
		}
		const key = await crypto.subtle.importKey(
			'spki',
			pub as BufferSource,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		const bodyHash = toHexS(await digest(rawBody));
		const payload = [claimed, req.method.toUpperCase(), path, bodyHash, String(ts), nonce, keyHash].join('\n');
		if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig as BufferSource, enc.encode(payload))))
			return false;
		const claim = await meter(env, `acct:${claimed}`, 'claim', { nonce: `req:${nonce}` });
		return claim.ok;
	} catch {
		return false;
	}
}

function meter(env: Env, room: string, op: string, body: object): Promise<Response> {
	const stub = env.METER!.get(env.METER!.idFromName(room));
	return stub.fetch(`https://meter/${op}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-meter-token': env.METER_TOKEN ?? ''
		},
		body: JSON.stringify({ ...body, inst: room })
	});
}

/**
 * MeterBus DO — one instance per room: {balance, spent} in storage.
 * Single-threaded per room → debits are atomic by construction, no D1
 * needed. The shared '__grants__' instance holds redeemed grant nonces.
 * Hibernates idle; storage is KV-backed (per-key, no schema).
 */
type MeterRole = 'admin' | 'spend' | 'probe' | 'settle';

/**
 * Ops each role may invoke when METER_ACL is configured.
 *   probe  — cic-sfu: balance reads + key lookup + nonce claims (its
 *            account-signature verifier needs them)
 *   spend  — cic-ai-gateway: usage debits, grant-redemption credits on
 *            non-acct pools, telemetry/index writes
 *   settle — cic-pay-hook: webhook settlement — wallet credits, bounded
 *            clawback debits, settlement-record kv writes. NO sponsor or
 *            transfer, and acct:* debits still need the DO-level spend
 *            rules (clawbackOf) — the settlement worker cannot drain.
 *   admin  — cic-pay: everything, incl. wallet credits, kv writes,
 *            sponsorship, transfers
 */
const ROLE_OPS: Record<MeterRole, Set<string>> = {
	probe: new Set(['/get', '/kvget', '/claim']),
	spend: new Set(['/get', '/kvget', '/kvlist', '/claim', '/debit', '/credit', '/report', '/list', '/audit']),
	settle: new Set(['/get', '/kvget', '/kvlist', '/kvput', '/claim', '/debit', '/credit', '/audit']),
	admin: new Set(['/get', '/kvget', '/kvlist', '/kvput', '/claim', '/debit', '/credit', '/report', '/list', '/audit', '/sponsor', '/transfer'])
};

/** per-call ceiling for unsigned sponsored-room debits on a wallet */
const SPONSORED_DEBIT_MAX_S = 7200;
/** default/ceiling for a sponsored room's cumulative wallet budget */
const DEFAULT_SPONSOR_BUDGET_S = 14_400; // 4h
const MAX_SPONSOR_BUDGET_S = 86_400; // 24h

export class MeterBus implements DurableObject {
	constructor(
		private ctx: DurableObjectState,
		private env: Env
	) {}

	/** sha256(token) lookup against METER_ACL — env stores hashes only, so a
	 *  leaked worker env can't yield usable tokens for sibling workers */
	private async role(req: Request): Promise<MeterRole | null> {
		try {
			const tok = req.headers.get('x-meter-token') ?? '';
			if (!tok) return null;
			const hash = await sha256hex(tok);
			const acl = JSON.parse(this.env.METER_ACL ?? '{}') as Record<string, MeterRole>;
			return acl[hash] ?? null;
		} catch {
			return null;
		}
	}

	/** proves the body's claimed instance name resolves to THIS object —
	 *  idFromName is deterministic, so a caller can't lie about which
	 *  pool/wallet it's mutating */
	private async isSelf(name: string): Promise<boolean> {
		try {
			const id = this.env.METER!.idFromName(name);
			const mine = this.ctx.id as unknown as { toString(): string };
			return typeof (id as { equals?: unknown }).equals === 'function'
				? (id as { equals(o: DurableObjectId): boolean }).equals(this.ctx.id)
				: String(id) === String(mine);
		} catch {
			return false;
		}
	}

	async fetch(req: Request): Promise<Response> {
		const op = new URL(req.url).pathname;
		const b = (await req.json().catch(() => ({}))) as {
			amount?: number;
			nonce?: string;
			key?: string;
			value?: unknown;
			prefix?: string;
			account?: string | null;
			to?: string;
			entry?: unknown;
			inst?: string;
			room?: string;
			creditId?: string;
			clawbackOf?: string;
			auth?: SignedAuth;
		};
		const s = this.ctx.storage;

		// Internal trust boundary. MeterBus has no public route — only sibling
		// workers holding the METER binding can call it — but a compromised
		// worker shouldn't be able to drain wallets, so in hardened mode
		// (METER_ACL set): the caller authenticates a role token, proves which
		// instance it's addressing, and money ops on acct:* additionally need
		// a client signature, a sponsorship record, or a matching credit.
		const hardened = !!this.env.METER_ACL;
		let role: MeterRole = 'admin';
		if (hardened) {
			const r = await this.role(req);
			if (!r) return json({ error: 'meter: unauthorized' }, 401);
			role = r;
			if (!b.inst || !(await this.isSelf(b.inst)))
				return json({ error: 'meter: instance mismatch' }, 400);
			if (!ROLE_OPS[role].has(op)) return json({ error: 'meter: forbidden' }, 403);
		}
		const acct = hardened && (b.inst ?? '').startsWith('acct:') ? b.inst!.slice(5) : null;

		if (op === '/get') {
			const balance = (await s.get<number>('balance')) ?? 0;
			const spent = (await s.get<number>('spent')) ?? 0;
			const sponsor = (await s.get<string>('sponsor')) ?? null;
			return json({ paid: balance > 0, balanceSeconds: balance, spentSeconds: spent, sponsor });
		}
		if (op === '/debit') {
			let amount = Math.max(0, Math.round(b.amount ?? 0));
			let via = 'pool';
			if (acct) {
				const gate = await authorizeSpend(s, acct, b);
				if (gate instanceof Response) return gate;
				via = gate.via;
				amount = gate.amount;
			}
			const capHit = await spendCapHit(s, amount);
			if (capHit) return json({ ok: false, status: 'cap', ...capHit }, 402);
			const balance = Math.max(0, ((await s.get<number>('balance')) ?? 0) - amount);
			const spent = ((await s.get<number>('spent')) ?? 0) + amount;
			await s.put({ balance, spent });
			if (acct) await auditLocal(this.env, s, { op: 'debit', amount, via, room: b.room });
			return json({ paid: balance > 0, balanceSeconds: balance, spentSeconds: spent, debitedSeconds: amount });
		}
		if (op === '/credit') {
			if (acct && role !== 'admin' && role !== 'settle')
				return json({ error: 'meter: forbidden' }, 403);
			const amount = Math.max(0, Math.round(b.amount ?? 0));
			const balance = ((await s.get<number>('balance')) ?? 0) + amount;
			await s.put('balance', balance);
			if (b.creditId) await s.put(`credit:${b.creditId}`, amount);
			if (acct) await auditLocal(this.env, s, { op: 'credit', amount, via: 'settlement', room: b.room });
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
		// --- billing KV records (cic-pay): cust:/sub:/evt: instances store
		// customer maps, subscription state and webhook dedupe via these ---
		if (op === '/kvget') {
			if (!b.key) return json({ error: 'key required' }, 400);
			return json({ value: (await s.get(b.key)) ?? null });
		}
		if (op === '/kvput') {
			if (!b.key) return json({ error: 'key required' }, 400);
			if (acct) {
				// wallet-instance writes are content-bound: privileged keys are
				// derived from the client's signed body (never the caller's
				// supplied value), settlement keys are settle/admin-only, and
				// internal counters are unreachable from outside the DO.
				const w = await authorizeKvput(s, acct, role, b);
				if (w instanceof Response) return w;
				await s.put(b.key, w);
				return json({ ok: true });
			}
			// cust:* first-binding is enforced here too — a compromised settle
			// worker can't re-map a victim's customer onto its own account
			if ((b.inst ?? '').startsWith('cust:') && b.key === 'accountId') {
				const cur = await s.get(b.key);
				if (cur && cur !== b.value) return json({ error: 'customer already bound' }, 409);
			}
			await s.put(b.key, b.value ?? null);
			return json({ ok: true });
		}
		if (op === '/kvlist') {
			const items: Record<string, unknown> = {};
			for await (const [k, v] of await s.list<unknown>({ prefix: b.prefix ?? '' }))
				items[k] = v;
			return json({ items });
		}
		if (op === '/sponsor') {
			// room instance: a funded account wallet pays for everyone here
			if (b.account) await s.put('sponsor', b.account);
			else await s.delete('sponsor');
			return json({ ok: true, sponsor: b.account ?? null });
		}
		if (op === '/transfer') {
			// acct:<id> instance → debit wallet only if it covers the amount,
			// then credit the target pool — one DO turn, no double-spend.
			// Hardened acct transfers take BOTH amount and destination from the
			// client's signed /pay/convert body — op args can't inflate/redirect.
			let to = b.to;
			let amount = Math.max(0, Math.round(b.amount ?? 0));
			let via = 'pool';
			if (acct) {
				const gate = await authorizeSpend(s, acct, b);
				if (gate instanceof Response) return gate;
				if (gate.auth?.path !== '/pay/convert')
					return json({ ok: false, status: 'bad_auth_path' }, 401);
				if (gate.auth?.room) to = gate.auth.room;
				amount = gate.amount;
				via = gate.via;
			}
			const balance = (await s.get<number>('balance')) ?? 0;
			if (!to || amount <= 0) return json({ ok: false, status: 'bad_request' }, 400);
			const capHit = await spendCapHit(s, amount);
			if (capHit) return json({ ok: false, status: 'cap', ...capHit });
			if (balance < amount)
				return json({ ok: false, status: 'insufficient', available: balance });
			const spent = ((await s.get<number>('spent')) ?? 0) + amount;
			await s.put({ balance: balance - amount, spent });
			const stub = this.env.METER!.get(this.env.METER!.idFromName(to));
			const res = await stub.fetch('https://meter/credit', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-meter-token': this.env.METER_TOKEN ?? ''
				},
				body: JSON.stringify({ amount, inst: to, creditId: b.creditId })
			});
			const credited = (await res.json()) as { balanceSeconds?: number };
			if (acct) await auditLocal(this.env, s, { op: 'transfer', amount, via, room: to });
			return json({ ok: true, balanceSeconds: credited.balanceSeconds ?? 0 });
		}
		if (op === '/audit') {
			// signed-ops trail — last 50 {op, device, at, detail} on this
			// instance, mirrored append-only to Analytics Engine
			const e = (b.entry ?? {}) as { op?: string; device?: string; detail?: string };
			const list = ((await s.get<unknown[]>('audit')) ?? []) as unknown[];
			list.unshift(e);
			await s.put('audit', list.slice(0, 50));
			try {
				this.env.AE?.writeDataPoint({
					blobs: [e.op ?? '', e.device ?? '', e.detail ?? ''],
					doubles: [0],
					indexes: ['meter']
				});
			} catch { /* best-effort */ }
			return json({ ok: true });
		}
		return json({ error: 'unknown op' }, 404);
	}
}

/**
 * Optional user-set daily spend cap (acct instances only) — 'limits' record
 * holds {maxSecondsPerDay}; spend accumulates under 'spendDay:<utc-date>'.
 * Unset = uncapped. Returns the breach detail or null.
 */
async function spendCapHit(
	s: DurableObjectStorage,
	amount: number
): Promise<{ dailySpent: number; cap: number } | null> {
	const limits = (await s.get<{ maxSecondsPerDay?: number }>('limits')) ?? null;
	const cap = limits?.maxSecondsPerDay;
	if (!cap || cap <= 0) return null;
	const day = new Date().toISOString().slice(0, 10);
	const key = `spendDay:${day}`;
	const spent = ((await s.get<number>(key)) ?? 0) + amount;
	if (spent > cap) return { dailySpent: spent - amount, cap };
	await s.put(key, spent);
	return null;
}

/**
 * SignedAuth — a client's signed request forwarded to the ledger so the DO
 * can re-verify it against the account's own registered keys. This is the
 * worker-compromise defense: a hijacked gateway/pay worker cannot debit an
 * acct:* wallet without a live device signature, because the DO — not the
 * worker — is the verifier of last resort for money movement.
 */
interface SignedAuth {
	pub?: string;
	ts?: number;
	nonce?: string;
	sig?: string;
	method?: string;
	path?: string;
	body?: string;
}

/** paths whose signed bodies may authorize a wallet debit */
const DEBIT_AUTH_PATHS = new Set(['/ai/usage', '/pay/convert']);

/**
 * verifyClientAuth — ECDSA-verify a forwarded signed request inside the DO
 * (same canonical payload as cic-pay's authorize). Enforces key registration
 * (primary sha256(pub)==acct, or key:<hash> record), ±300s freshness, and a
 * single-use dauth:<nonce>. Returns {keyHash, amount, room} where amount is
 * derived ONLY from the signed body — the worker's claimed amount is ignored.
 */
async function verifyClientAuth(
	s: DurableObjectStorage,
	acct: string,
	auth: SignedAuth
): Promise<{ keyHash: string; amount: number; path: string; room?: string } | null> {
	try {
		const { pub, ts, nonce, sig, method, path, body } = auth;
		if (!pub || !ts || !nonce || !sig || !method || !path) return null;
		if (!/^[0-9a-f]+$/i.test(pub) || !/^[0-9a-f]+$/i.test(sig)) return null;
		if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return null;
		const pubB = hexToBytes(pub);
		const keyHash = toHex(await sha256bytes(pubB));
		if (keyHash !== acct && !(await s.get(`key:${keyHash}`))) return null;
		const key = await crypto.subtle.importKey(
			'spki',
			pubB as BufferSource,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		const bodyHash = toHex(await sha256bytes(body ?? ''));
		const payload = [acct, method.toUpperCase(), path, bodyHash, String(ts), nonce, keyHash].join('\n');
		const ok = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			key,
			hexToBytes(sig) as BufferSource,
			new TextEncoder().encode(payload)
		);
		if (!ok) return null;
		if (await s.get(`dauth:${nonce}`)) return null; // single-use, independent of req:<nonce>
		await s.put(`dauth:${nonce}`, 1);
		const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
		const claimed = (parsed.accountId ?? parsed.account) as string | undefined;
		if (claimed && claimed !== acct) return null; // signed for a different wallet
		const amount =
			path === '/ai/usage'
				? Math.max(0, Math.min(3600, Math.round(Number(parsed.seconds ?? 0)))) +
					Math.max(0, Math.min(1000, Math.round(Number(parsed.calls ?? 0)))) * CALL_COST
				: Math.max(0, Math.min(86_400_000, Math.round(Number(parsed.seconds ?? parsed.amount ?? 0))));
		return { keyHash, amount, path, room: parsed.room as string | undefined };
	} catch {
		return null;
	}
}

/**
 * authorizeSpend — the three lawful ways a debit/transfer may touch an
 * acct:* wallet, checked by the DO itself:
 *   1. auth       — client-signed spend (usage heartbeat or convert)
 *   2. room       — the wallet's owner sponsors that room (sponsored:<room>)
 *   3. clawbackOf — bounded by a previously recorded credit:<id>
 * Anything else → 401; there is deliberately no role override.
 */
async function authorizeSpend(
	s: DurableObjectStorage,
	acct: string,
	b: { amount?: number; room?: string; clawbackOf?: string; auth?: SignedAuth }
): Promise<{ via: string; amount: number; auth?: { path: string; room?: string } } | Response> {
	if (b.auth) {
		const v = await verifyClientAuth(s, acct, b.auth);
		if (!v || !DEBIT_AUTH_PATHS.has(v.path)) return json({ error: 'spend auth failed' }, 401);
		return { via: `key:${v.keyHash.slice(0, 8)}`, amount: v.amount, auth: { path: v.path, room: v.room } };
	}
	if (b.room) {
		const raw = await s.get(`sponsored:${b.room}`);
		// legacy boolean records migrate to the default budget
		const rec = (
			raw === true ? { budget: DEFAULT_SPONSOR_BUDGET_S, spent: 0 } : raw
		) as { budget?: number; spent?: number; at?: number } | null;
		if (rec?.budget) {
			const remain = rec.budget - (rec.spent ?? 0);
			const amt = Math.min(Math.max(0, Math.round(b.amount ?? 0)), SPONSORED_DEBIT_MAX_S, Math.max(0, remain));
			if (amt <= 0) return json({ error: 'sponsor budget exhausted' }, 402);
			await s.put(`sponsored:${b.room}`, { ...rec, spent: (rec.spent ?? 0) + amt });
			return { via: `sponsored:${b.room}`, amount: amt };
		}
	}
	if (b.clawbackOf) {
		const credited = (await s.get<number>(`credit:${b.clawbackOf}`)) ?? 0;
		const clawed = (await s.get<number>(`clawed:${b.clawbackOf}`)) ?? 0;
		const remain = credited - clawed;
		if (remain <= 0) return json({ error: 'no matching credit' }, 403);
		const amt = Math.min(Math.max(0, Math.round(b.amount ?? 0)), remain);
		await s.put(`clawed:${b.clawbackOf}`, clawed + amt);
		return { via: `clawback:${b.clawbackOf}`, amount: amt };
	}
	return json({ error: 'wallet spend requires signature' }, 401);
}

/**
 * authorizeKvput — acct:* writes are content-bound in hardened mode.
 * Returns the value the DO itself decided to store (derived from the
 * signed body for privileged keys, never trusting the caller's `value`),
 * or a Response on rejection. A compromised admin/settle worker cannot
 * register an attacker device key, fake a sponsorship, or loosen a cap.
 */
async function authorizeKvput(
	s: DurableObjectStorage,
	acct: string,
	role: MeterRole,
	b: { key?: string; value?: unknown; auth?: SignedAuth }
): Promise<unknown | Response> {
	const k = b.key!;
	// ledger internals are unreachable via kvput for EVERY role —
	// balance/spent move only through their own ops, and credit:/nonce:/
	// dauth: records can't be forged to fake a clawback base or replay
	if (
		k === 'balance' || k === 'spent' || k === 'sponsor' || k === 'audit' ||
		/^(credit|clawed|nonce|dauth|spendDay):/.test(k)
	)
		return json({ error: 'key is internal' }, 403);

	// settlement records (written by cic-pay-hook during webhook handling or
	// cic-pay's challenge endpoint) — settle/admin only, no client signature
	if (
		k === 'customer' || k === 'subscriptionId' || k === 'sub' ||
		k === 'lastPurchase' || k === 'lastInvoice' || k === 'lastChargeback' ||
		k.startsWith('chal:')
	) {
		if (role !== 'admin' && role !== 'settle') return json({ error: 'meter: forbidden' }, 403);
		if (k === 'customer') {
			const cur = await s.get(k);
			if (cur && cur !== b.value) return json({ error: 'customer already bound' }, 409);
		}
		return b.value ?? null;
	}

	const priv = k.startsWith('key:') ? 'key'
		: k.startsWith('passkey:') ? 'passkey'
		: k.startsWith('sponsored:') ? 'sponsored'
		: k === 'limits' ? 'limits'
		: null;
	if (priv) {
		// worker-side signCount bump on an existing passkey — same pubkey,
		// same credId, monotonic count only; needs no fresh signature
		if (priv === 'passkey' && b.value && typeof b.value === 'object') {
			const cur = await s.get<{ pubSpki?: string; signCount?: number }>(k);
			const v = b.value as { pubSpki?: string; signCount?: number };
			if (cur?.pubSpki && v.pubSpki === cur.pubSpki && (v.signCount ?? 0) > (cur.signCount ?? 0))
				return v;
		}
		if (!b.auth) return json({ error: 'signed write required' }, 401);
		const v = await verifyClientAuth(s, acct, b.auth);
		if (!v) return json({ error: 'auth failed' }, 401);
		const body = JSON.parse(b.auth.body || '{}') as Record<string, unknown>;

		if (priv === 'key') {
			const kh = k.slice(4);
			if (b.value == null) {
				// device revocation — the signed body names the key hash
				if (v.path !== '/pay/revoke' || body.pubHash !== kh)
					return json({ error: 'bad_auth_path' }, 401);
				return null;
			}
			// device linking — DO derives the stored record so the key hash
			// provably matches the pubkey the signed body carries
			if (v.path !== '/pay/link-approve') return json({ error: 'bad_auth_path' }, 401);
			const pub = String(body.pub ?? '');
			if (!/^[0-9a-f]+$/i.test(pub) || (await sha256hex(hexToBytes(pub))) !== kh)
				return json({ error: 'key binding failed' }, 403);
			return { pub, at: Date.now(), via: 'link' };
		}
		if (priv === 'passkey') {
			if (v.path !== '/pay/passkey-register') return json({ error: 'bad_auth_path' }, 401);
			const p = body.passkey as { credId?: string; pubSpki?: string; name?: string } | undefined;
			if (!p || `passkey:${p.credId}` !== k || !p.pubSpki)
				return json({ error: 'passkey binding failed' }, 403);
			return { pubSpki: p.pubSpki, name: p.name, signCount: 0, at: Date.now() };
		}
		if (priv === 'sponsored') {
			if (v.path !== '/pay/sponsor') return json({ error: 'bad_auth_path' }, 401);
			if (body.room !== k.slice(10)) return json({ error: 'room binding failed' }, 403);
			if (body.on !== true) return null; // sponsor off
			const cur = (await s.get<{ spent?: number }>(k)) ?? null;
			const budget = Math.min(
				MAX_SPONSOR_BUDGET_S,
				Math.max(0, Math.round(Number(body.budgetSeconds ?? DEFAULT_SPONSOR_BUDGET_S)))
			);
			return { budget, spent: typeof cur === 'object' && cur ? cur.spent ?? 0 : 0, at: Date.now() };
		}
		// limits — value comes from the signed body
		if (v.path !== '/pay/limits') return json({ error: 'bad_auth_path' }, 401);
		const cap = body.maxSecondsPerDay == null ? null : Math.max(0, Math.round(Number(body.maxSecondsPerDay)));
		return cap ? { maxSecondsPerDay: cap } : null;
	}

	// anything else on a wallet instance is admin-only
	if (role !== 'admin') return json({ error: 'meter: forbidden' }, 403);
	return b.value ?? null;
}

/** append to the instance's 50-entry signed-ops ring + mirror to AE (the
 *  mirror is append-only — an attacker can stop writing but can't erase) */
async function auditLocal(
	env: Env,
	s: DurableObjectStorage,
	entry: { op: string; amount?: number; via?: string; room?: string }
): Promise<void> {
	const list = ((await s.get<unknown[]>('audit')) ?? []) as unknown[];
	list.unshift({ ...entry, at: Date.now() });
	await s.put('audit', list.slice(0, 50));
	try {
		env.AE?.writeDataPoint({
			blobs: [entry.op, entry.via ?? '', entry.room ?? ''],
			doubles: [entry.amount ?? 0],
			indexes: ['meter']
		});
	} catch { /* telemetry is best-effort */ }
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256bytes(d: Uint8Array | string): Promise<Uint8Array> {
	const data = typeof d === 'string' ? new TextEncoder().encode(d) : d;
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

async function sha256hex(d: Uint8Array | string): Promise<string> {
	return toHex(await sha256bytes(d));
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
// keep in sync with models/manifest.json — keys are manifest pack ids;
// 'asr'/'tts'/'asr-en'/'tts-en' aliases all resolve to the English packs
const PACK_URLS: Record<string, string> = {
	vad: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-wasm-simd-v1.13.8-vad.tar.bz2',
	asr: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer.tar.bz2',
	'asr-en': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer.tar.bz2',
	'asr-zh-en': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-zh-en-asr-zipformer.tar.bz2',
	'asr-zh-yue-en': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-zh-cantonese-en-asr-paraformer.tar.bz2',
	tts: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-wasm-simd-1.13.8-vits-piper-en_US-libritts_r-medium.tar.bz2',
	'tts-en': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-wasm-simd-1.13.8-vits-piper-en_US-libritts_r-medium.tar.bz2',
	'tts-multi': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-wasm-simd-1.13.8-kokoro-multi-lang-v1_0.tar.bz2',
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
