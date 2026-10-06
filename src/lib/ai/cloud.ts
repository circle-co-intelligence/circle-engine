/**
 * Cloud AI — zero-retention gateway client. When VITE_CIC_AI_ENDPOINT is set
 * (a same-origin Pages Function on CF deploys, or a Worker URL), Milo/STT/TTS
 * route through workers/ai-gateway instead of the on-device models. The
 * gateway never persists prompts, audio, or transcripts (no KV/DO/logs) —
 * it decrypts nothing because nothing is encrypted beyond TLS; the room's
 * consent boundary (heartMode / transcriptScope=off) is enforced *before*
 * content is handed here, in RoomSession.
 *
 * Failure contract: every call throws → callers fall back to local paths.
 */
import { base64 } from '@scure/base';
import { miloSystem, type MiloAskOpts } from './milo';
import { localAccount } from '../bridge/account';
import { signRequest } from '../crypto/accountKey';


export function aiEndpoint(): string | null {
	return (import.meta.env as Record<string, string | undefined>).VITE_CIC_AI_ENDPOINT ?? null;
}

/** the room pool is empty — caller falls back to the on-device lane and
 *  surfaces a top-up prompt; not a transient failure */
export class CreditsError extends Error {
	constructor(public status: number = 402) {
		super('ai credits exhausted');
	}
}

/** operator-picked model + reasoning intensity for cloud Milo
 *  (VITE_CIC_MILO_MODEL / VITE_CIC_MILO_EFFORT; unset = gateway defaults) */
function miloOpts(): { model?: string; effort?: string } {
	const e = import.meta.env as Record<string, string | undefined>;
	return {
		...(e.VITE_CIC_MILO_MODEL ? { model: e.VITE_CIC_MILO_MODEL } : {}),
		...(e.VITE_CIC_MILO_EFFORT ? { effort: e.VITE_CIC_MILO_EFFORT } : {})
	};
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
	const base = aiEndpoint();
	if (!base) throw new Error('ai endpoint unconfigured');
	// the gateway debits the room/sponsor pool before invoking the provider;
	// a retry carries the same callId so it can never double-bill. When the
	// caller has a linked account it's signed for — the DO verifies the
	// signature and derives the debit amount from this exact body.
	const acc = localAccount()?.accountId;
	const wire = JSON.stringify({ ...body, ...(acc ? { account: acc } : {}) });
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (acc) Object.assign(headers, await signRequest('POST', path, wire, acc));
	const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: wire });
	if (res.status === 402) throw new CreditsError();
	if (!res.ok) throw new Error(`ai ${path} → ${res.status}`);
	return (await res.json()) as T;
}

/** drop-in for the local Milo class — same state machine + onSay contract.
 *  `room` is the metered pool the gateway charges before serving. */
export class CloudMilo {
	state: 'off' | 'standby' | 'listening' | 'speaking' = 'standby';
	onSay: (text: string) => void = () => {};
	/** callId of the most recent ask — the meter reports it for reconcile */
	lastCallId = '';
	private generation = 0;
	constructor(private room = '') {}

	async init(_cfg?: unknown): Promise<boolean> {
		if (!aiEndpoint()) {
			this.state = 'off';
			return false;
		}
		this.state = 'standby';
		return true;
	}

	async ask(prompt: string, transcriptWindow: string[], opts?: MiloAskOpts): Promise<string> {
		if (this.state === 'off') return '';
		const gen = this.generation;
		this.state = 'listening';
		this.lastCallId = crypto.randomUUID();
		const { text } = await post<{ text: string }>('/ai/chat', {
			room: this.room,
			callId: this.lastCallId,
			system: miloSystem(opts),
			context: transcriptWindow.slice(-40),
			prompt,
			// operator-picked model/reasoning intensity → per-call override on
			// OpenAI-compatible providers (unset = gateway default)
			...(miloOpts() as Record<string, string>)
		});
		if (gen !== this.generation) return '';
		this.state = 'speaking';
		this.onSay(text);
		this.state = 'standby';
		return text;
	}

	interrupt() {
		this.generation++;
		this.state = 'standby';
	}
	stop() {
		this.interrupt();
	}
}

/** streaming-adjacent STT: a buffered chunk → text (caller owns chunking).
 *  `room` identifies the pool the gateway debits before serving. */
export async function cloudStt(pcm: Float32Array, sampleRate: number, room = ''): Promise<string> {
	const { text } = await post<{ text: string }>('/ai/stt', {
		room,
		callId: crypto.randomUUID(),
		audio: f32ToB64(pcm),
		sampleRate
	});
	return text;
}

/** cloud TTS → PCM the same shape LocalTts returns */
export async function cloudTts(
	text: string,
	voice?: string,
	room = ''
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
	const res = await post<{ audio?: string; sampleRate?: number }>('/ai/tts', {
		room,
		callId: crypto.randomUUID(),
		text,
		voice
	});
	if (!res.audio) return null;
	return { samples: b64ToF32(res.audio), sampleRate: res.sampleRate ?? 22050 };
}

const f32ToB64 = (f: Float32Array) =>
	base64.encode(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
const b64ToF32 = (b64: string) => {
	const u8 = base64.decode(b64);
	return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2);
};
