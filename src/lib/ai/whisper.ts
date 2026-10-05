/**
 * whisper.ts — zero-egress multilingual ASR via transformers.js + ONNX
 * Runtime Web. Runs onnx-community/whisper-* (multilingual, ~99 languages)
 * fully in-browser — no audio leaves the device.
 *
 * transformers.js does NOT implement whisper's language detection (their
 * TODO — omitting `language` silently forces English). We do it the way
 * whisper.cpp does: generate with an empty (SOT-only) prompt — the first
 * sampled token is the model's own language prediction, read back through
 * lang_to_id. One cheap extra encoder pass per utterance.
 *
 * Segmentation: rolling 16kHz buffer with an RMS/adaptive-floor VAD
 * (borrowed from DspBus) — partials every ~3s while speaking, a final on
 * ~0.9s of trailing silence, forced final at 24s.
 *
 * Model files come through the ai-gateway /ai/hf proxy (HF's CDN lacks
 * CORP headers our require-corp document needs), cached in CacheStorage
 * by transformers.js itself (useBrowserCache).
 *
 * Select with VITE_CIC_ASR_PACK=whisper; model/dtype/device overridable:
 *   VITE_CIC_WHISPER_MODEL  (default onnx-community/whisper-base)
 *   VITE_CIC_WHISPER_DTYPE  (default q8 — good WASM speed/size)
 *   VITE_CIC_WHISPER_DEVICE (webgpu|wasm|auto — default auto)
 *   VITE_CIC_ASR_LANG       (fixed language; unset = auto-detect per utterance)
 */
import { pipeline, env as hfEnv } from '@huggingface/transformers';
import type { SpeechSegment } from './speech';
import { emitModel } from './modelStatus';

const ENV = import.meta.env as Record<string, string | undefined>;
const MODEL = ENV.VITE_CIC_WHISPER_MODEL ?? 'onnx-community/whisper-base';
const DTYPE = (ENV.VITE_CIC_WHISPER_DTYPE ?? 'q8') as 'q8';
const FIXED_LANG = ENV.VITE_CIC_ASR_LANG;
const DEVICE_PREF = ENV.VITE_CIC_WHISPER_DEVICE ?? 'auto';

// route model files through our origin — under COEP require-corp a direct
// huggingface.co fetch is blocked (their CDN doesn't send CORP headers).
const aiBase = ENV.VITE_CIC_AI_ENDPOINT;
const edgeBase = aiBase?.replace(/\/ai\/?$/, '') ?? '';
if (aiBase) hfEnv.remoteHost = `${edgeBase}/ai/hf/`;

/** point onnxruntime-web's wasm loader at our /ai/ort proxy — the bundled
 *  26MB asset is stripped at deploy (Pages 25MiB limit); jsdelivr is the
 *  upstream either way. Set inside getAsr(): env.backends.onnx is only
 *  populated once the onnx backend module loads. */
function wireOrtProxy() {
	if (!edgeBase) return;
	const onnx = hfEnv.backends?.onnx as
		| { wasm?: { wasmPaths?: unknown } }
		| undefined;
	if (onnx?.wasm) {
		onnx.wasm.wasmPaths = {
			mjs: `${edgeBase}/ai/ort/ort-wasm-simd-threaded.asyncify.mjs`,
			wasm: `${edgeBase}/ai/ort/ort-wasm-simd-threaded.asyncify.wasm`
		};
	}
}

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string }>;
// pipeline() returns a callable object that also exposes .model/.processor —
// the LID pass needs both (feature extraction + a raw generate call)
type Asr = Transcriber & {
	model: {
		generation_config: Record<string, unknown> & { lang_to_id?: Record<string, number> };
		generate(opts: Record<string, unknown>): Promise<unknown>;
	};
	processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
};

let asrPromise: Promise<Asr | null> | null = null;
function getAsr(): Promise<Asr | null> {
	if (!asrPromise) {
		asrPromise = (async () => {
			emitModel('asr', 'loading');
			wireOrtProxy();
			// 'gpu' in navigator lies in headless/disabled-GPU browsers — the API
			// exists but requestAdapter() returns null. Probe the adapter so the
			// device order doesn't burn a failed webgpu attempt before wasm.
			const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
			const hasGpu = !!gpu && !!(await gpu.requestAdapter().catch(() => null));
			const order =
				DEVICE_PREF === 'auto'
					? hasGpu
						? (['webgpu', 'wasm'] as const)
						: (['wasm'] as const)
					: ([DEVICE_PREF] as const);
			for (const device of order) {
				try {
					const t = (await pipeline('automatic-speech-recognition', MODEL, {
						dtype: DTYPE,
						device: device as 'wasm' | 'webgpu'
					})) as unknown as Asr;
					emitModel('asr', 'ready');
					return t;
				} catch (e) {
					console.warn(`[whisper] ${device} load failed`, e);
				}
			}
			emitModel('asr', 'error');
			return null;
		})();
		// a failed load must not brick the lane for the page's lifetime
		void asrPromise.then((m) => {
			if (m === null) asrPromise = null;
		});
	}
	return asrPromise;
}

const PARTIAL_MS = 3000; // emit a partial every 3s of accumulated speech
const END_MS = 900; // trailing silence that closes an utterance
const MAX_UTTER_MS = 24_000; // force a final before whisper's 30s window
const LID_MAX_MS = 8_000; // language-id only needs the first few seconds

/** VAD-segmented multilingual whisper captions — same interface as the
 *  sherpa CaptionPipeline (init/push/onSegment/dispose). */
export class WhisperCaptionPipeline {
	private asr: Asr | null = null;
	private chunks: Float32Array[] = [];
	private buffered = 0; // samples in the current utterance
	private silence = 0; // trailing low-energy samples
	private speaking = false;
	private sincePartial = 0;
	private decoding = false;
	private pendingDecode: 'partial' | 'final' | null = null;
	private lang: string | null = null; // detected for this utterance
	private noiseFloor = 0.004;
	private disposed = false;
	onSegment: (seg: SpeechSegment) => void = () => {};

	async init(): Promise<boolean> {
		this.asr = await getAsr();
		return this.asr !== null;
	}

	push(samples: Float32Array) {
		if (!this.asr || this.disposed) return;
		let sum = 0;
		for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
		const rms = Math.sqrt(sum / samples.length);
		// adaptive floor: track the quiet end; gate at 1.4× floor
		if (rms < this.noiseFloor * 1.5) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
		const voiced = rms > this.noiseFloor * 1.4;

		if (voiced) {
			this.speaking = true;
			this.silence = 0;
		} else if (this.speaking) {
			this.silence += (samples.length / 16000) * 1000;
		}
		if (!this.speaking) return; // drop silence before speech starts

		this.chunks.push(samples.slice());
		this.buffered += samples.length;
		this.sincePartial += (samples.length / 16000) * 1000;
		const utterMs = (this.buffered / 16000) * 1000;

		if (this.silence > END_MS || utterMs >= MAX_UTTER_MS) {
			void this.decode('final');
		} else if (this.sincePartial >= PARTIAL_MS) {
			this.sincePartial = 0;
			void this.decode('partial');
		}
	}

	private takeBuffer(): Float32Array {
		const out = new Float32Array(this.buffered);
		let off = 0;
		for (const c of this.chunks) {
			out.set(c, off);
			off += c.length;
		}
		this.chunks = [];
		this.buffered = 0;
		this.sincePartial = 0;
		return out;
	}

	/** serialized decodes — one generate at a time, latest-wins for stragglers */
	private async decode(kind: 'partial' | 'final') {
		if (this.decoding) {
			if (kind === 'final') this.pendingDecode = 'final';
			return;
		}
		this.decoding = true;
		try {
			do {
				this.pendingDecode = null;
				const audio = this.takeBuffer();
				if (audio.length < 4800) break; // <0.3s — nothing to say
				const isFinal = kind === 'final' || this.silence > END_MS;
				const text = await this.transcribe(audio);
				if (text) this.onSegment({ text, final: isFinal, lang: this.lang ?? undefined });
				if (isFinal) this.endUtter();
				kind = this.pendingDecode ?? 'final';
			} while (this.pendingDecode !== null);
		} finally {
			this.decoding = false;
		}
	}

	/** utterance closed — reset state but NOT the buffer: push() kept
	 *  appending during the async decode, so anything now in chunks is the
	 *  start of the next utterance and must survive. */
	private endUtter() {
		this.silence = 0;
		this.sincePartial = 0;
		this.lang = null;
		// speaking stays as-is — if the caller never paused (forced final at
		// 24s), the buffer keeps growing into the next utterance
		if (!this.speaking) this.speaking = this.buffered > 0;
	}

	private reset() {
		this.chunks = [];
		this.buffered = 0;
		this.silence = 0;
		this.speaking = false;
		this.sincePartial = 0;
		this.lang = null;
	}

	private async transcribe(audio: Float32Array): Promise<string> {
		const tr = this.asr;
		if (!tr) return '';
		try {
			if (!this.lang) this.lang = FIXED_LANG ?? (await this.detectLang(audio));
			const out = await tr(audio, {
				language: this.lang,
				task: 'transcribe'
			});
			return (out?.text ?? '').trim();
		} catch (e) {
			console.warn('[whisper] transcribe failed', e);
			return '';
		}
	}

	/** whisper's own LID: SOT-only prompt → first generated token is the
	 *  predicted language token. transformers.js has no detect_language
	 *  (it defaults to 'en'), so we drive generate directly. */
	private async detectLang(audio: Float32Array): Promise<string> {
		const tr = this.asr;
		if (!tr) return 'en';
		try {
			const gc = tr.model.generation_config;
			const feats = await tr.processor(audio.subarray(0, (LID_MAX_MS / 1000) * 16000));
			const out = (await tr.model.generate({
				inputs: feats.input_features,
				max_new_tokens: 1,
				generation_config: {
					...gc,
					// SOT-only prompt: no lang/task forcing, no notimestamps
					is_multilingual: false,
					language: undefined,
					task: undefined,
					no_timestamps_token_id: null,
					return_timestamps: false
				}
			})) as { sequences?: { data?: ArrayLike<number> } | ArrayLike<number>[] };
			const seqs = (out as { sequences?: unknown }).sequences ?? out;
			const row: ArrayLike<unknown> | undefined = Array.isArray(seqs)
				? (seqs as ArrayLike<unknown>[])[0]
				: (seqs as { data?: ArrayLike<unknown> })?.data;
			if (row && gc.lang_to_id) {
				const predicted = Number(row[row.length - 1]);
				for (const [tok, id] of Object.entries(gc.lang_to_id)) {
					if (id === predicted) return tok.replace(/<\||\|>/g, '');
				}
			}
		} catch (e) {
			console.warn('[whisper] lang detect failed, using en', e);
		}
		return 'en';
	}

	dispose() {
		this.disposed = true;
		this.reset(); // model stays cached page-wide — pipes churn per socket
	}
}
