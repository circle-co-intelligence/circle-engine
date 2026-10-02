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
 *   AI_CHAT_MODEL    — default '@cf/meta/llama-3.1-8b-instruct' (CF) or provider model
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
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
		const url = new URL(req.url);
		try {
			if (url.pathname === '/ai/chat' && req.method === 'POST')
				return await chat(req, env);
			if (url.pathname === '/ai/stt' && req.method === 'POST')
				return await stt(req, env);
			if (url.pathname === '/ai/tts' && req.method === 'POST')
				return await tts(req, env);
			return json({ error: 'not found' }, 404);
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : 'upstream' }, 502);
		}
	}
};

// ------------------------------------------------------------- chat (Milo)

async function chat(req: Request, env: Env): Promise<Response> {
	const { system, context, prompt } = (await req.json()) as {
		system: string;
		context?: string[];
		prompt: string;
	};
	const user = `Transcript window:\n${(context ?? []).join('\n')}\n\nQuestion: ${prompt}`;
	const provider = env.AI_PROVIDER ?? 'workers-ai';

	if (provider === 'workers-ai') {
		if (!env.AI) return json({ error: 'workers-ai binding missing' }, 503);
		const res = await env.AI.run(env.AI_CHAT_MODEL ?? '@cf/meta/llama-3.1-8b-instruct', {
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
