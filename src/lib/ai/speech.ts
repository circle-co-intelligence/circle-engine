/**
 * Speech pipeline — sherpa-onnx WASM (single runtime for VAD, ASR, TTS).
 *
 * The npm `sherpa-onnx` package is the Node.js build; in the browser we load
 * the sherpa-onnx wasm-simd release packs served from /models/* (fetched by
 * scripts/fetch-models.sh, see models/manifest.json). Each pack ships its own
 * Emscripten loader (sherpa-onnx-wasm-main-*.js) + CJS API layer
 * (sherpa-onnx-*.js) + a .data bundle with the model weights baked into the
 * emscripten virtual FS.
 *
 * Everything degrades gracefully when a pack isn't deployed locally.
 */

export interface SpeechSegment {
	text: string;
	final: boolean;
	lang?: string;
	speaker?: number;
}

import { base } from '$app/paths';
import manifest from '../../../models/manifest.json';

const PACKS = {
	vad: { dir: `${base}/models/vad/sherpa-onnx-wasm-simd-v1.13.8-vad`, remote: '' },
	asr: {
		dir: `${base}/models/asr-en/sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer`,
		remote: ''
	},
	tts: {
		dir: `${base}/models/tts-en/sherpa-onnx-wasm-simd-1.13.8-vits-piper-en_US-libritts_r-medium`,
		remote: ''
	}
} as const;

// upstream tarballs (models/manifest.json) — used when the extracted pack
// isn't served locally (e.g. GitHub Pages deploys, where 400MB of weights
// can't be committed)
const REMOTE_KEYS = { vad: 'vad', asr: 'asr-en', tts: 'tts-en' } as const;
for (const [kind, mkey] of Object.entries(REMOTE_KEYS)) {
	const remote = (manifest.packs as Record<string, { url?: string }>)[mkey]?.url;
	if (remote) (PACKS as Record<string, { remote: string }>)[kind].remote = remote;
}

type PackKind = keyof typeof PACKS;

type SherpaModule = Record<string, unknown> & {
	locateFile?: (path: string, dir?: string) => string;
	onRuntimeInitialized?: () => void;
};

type VadApi = {
	acceptWaveform(samples: Float32Array): void;
	isEmpty(): boolean;
	isDetected(): boolean;
	front(): unknown;
	pop(): void;
	flush(): void;
	config: { sileroVad: { windowSize: number } };
};

type AsrStream = { acceptWaveform(sampleRate: number, samples: Float32Array): void; free?(): void };
type AsrApi = {
	createStream(): AsrStream;
	isReady(s: AsrStream): boolean;
	decode(s: AsrStream): void;
	isEndpoint(s: AsrStream): boolean;
	getResult(s: AsrStream): { text: string };
	reset(s: AsrStream): void;
	free?(): void;
};

const loaded = new Map<PackKind, Promise<SherpaModule | null>>();
// every pack shares the global `window.Module` name — concurrent loads across
// kinds clobber each other's emscripten config mid-init and corrupt the wasm
// heap, so ALL pack loads serialize through this one chain
let loadChain: Promise<unknown> = Promise.resolve();

function injectScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const el = document.createElement('script');
		el.src = src;
		el.onload = () => resolve();
		el.onerror = () => reject(new Error(`load failed: ${src}`));
		document.head.appendChild(el);
	});
}

declare global {
	interface Window {
		Module?: SherpaModule;
		createVad?: (Module: SherpaModule, config: unknown) => VadApi;
		createOnlineRecognizer?: (Module: SherpaModule, config?: unknown) => AsrApi;
	}
}

/**
 * Load a sherpa pack: inject the API script, set the global `Module` the
 * emscripten runtime expects, inject the wasm loader, await initialization.
 * Loads are serialized — all packs share the global `Module` name.
 */
/**
 * Fetch an upstream pack tarball (manifest URL) and extract it in-browser —
 * libarchive handles tar.bz2. Extracted entries become blob: URLs keyed by
 * basename so the same injectScript/locateFile flow works unchanged. The raw
 * tarball is persisted in CacheStorage so the ~100-200MB download happens once.
 */
async function fetchRemotePack(url: string): Promise<Record<string, string>> {
	const cache = await caches.open('cic-model-packs');
	const hit = await cache.match(url);
	const res = hit ?? (await fetch(url));
	if (!res.ok) throw new Error(`pack fetch ${res.status}`);
	if (!hit) void cache.put(url, res.clone());
	const blob = await res.blob();
	const { Archive } = await import('libarchive.js');
	Archive.init({ workerUrl: `${base}/libarchive/worker-bundle.js` });
	const extracted = await (
		await Archive.open(new File([blob], 'pack.tar.bz2'))
	).getFilesArray();
	const map: Record<string, string> = {};
	for (const f of extracted) {
		const file =
			f.file instanceof File
				? f.file
				: await (f.file as { extract(): Promise<File>; name: string }).extract();
		map[file.name] = URL.createObjectURL(file);
	}
	return map;
}

async function loadPack(kind: PackKind): Promise<SherpaModule | null> {
	const packCfg = PACKS[kind];
	const apiScript = { vad: 'sherpa-onnx-vad.js', asr: 'sherpa-onnx-asr.js', tts: 'sherpa-onnx-tts.js' }[kind];
	const mainScript = `sherpa-onnx-wasm-main-${kind}.js`;
	try {
		await injectScript(`${packCfg.dir}/${apiScript}`);
		const Module: SherpaModule = {};
		Module.locateFile = (path) => `${packCfg.dir}/${path}`;
		const ready = new Promise<void>((res) => (Module.onRuntimeInitialized = res));
		window.Module = Module;
		await injectScript(`${packCfg.dir}/${mainScript}`);
		await ready;
		return Module;
	} catch {
		if (!packCfg.remote) return null; // pack not deployed — caller degrades visibly
	}
	try {
		const files = await fetchRemotePack(packCfg.remote);
		await injectScript(files[apiScript]);
		const Module: SherpaModule = {};
		Module.locateFile = (path) => files[path.split('/').pop() ?? path] ?? path;
		const ready = new Promise<void>((res) => (Module.onRuntimeInitialized = res));
		window.Module = Module;
		await injectScript(files[mainScript]);
		await ready;
		return Module;
	} catch (e) {
		console.warn(`[speech] remote pack ${kind} failed`, e);
		return null;
	}
}

function pack(kind: PackKind): Promise<SherpaModule | null> {
	if (!loaded.has(kind)) {
		const p = loadChain.then(() => loadPack(kind));
		loadChain = p.catch(() => {});
		loaded.set(kind, p);
		// a failed load (fetch hiccup, wasm OOM) must not brick the pack for the
		// page's whole lifetime — let the next request retry
		void p.then((m) => { if (m === null) loaded.delete(kind); });
	}
	return loaded.get(kind)!;
}

/** Local streaming zipformer ASR → caption segments */
export class CaptionPipeline {
	private recognizer: AsrApi | null = null;
	private stream: AsrStream | null = null;
	onSegment: (seg: SpeechSegment) => void = () => {};

	async init(): Promise<boolean> {
		const asrMod = await pack('asr');
		if (asrMod && window.createOnlineRecognizer) {
			try {
				this.recognizer = window.createOnlineRecognizer(asrMod);
				this.stream = this.recognizer.createStream();
			} catch (e) {
				console.warn('[speech] recognizer init failed', e);
			}
		}
		return this.recognizer !== null;
	}

	/** feed 16kHz mono PCM frames from an AudioWorklet/ScriptProcessor tap */
	push(samples: Float32Array) {
		if (!this.recognizer || !this.stream) return;
		try {
			this.stream.acceptWaveform(16000, samples);
			while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
			const text = this.recognizer.getResult(this.stream).text;
			if (this.recognizer.isEndpoint(this.stream)) {
				this.recognizer.reset(this.stream);
				if (text) this.onSegment({ text, final: true });
			} else if (text) {
				this.onSegment({ text, final: false });
			}
		} catch {
			// sherpa's wasm can wedge on bad input; never let it throw across the
			// socket boundary — prod treats a send error as fatal capture failure
		}
	}

	/** release wasm heap — recognizers churn per caption socket; leaked ones OOM the module */
	dispose() {
		try { this.stream?.free?.(); } catch {}
		try { this.recognizer?.free?.(); } catch {}
		this.stream = null;
		this.recognizer = null;
	}
}

/**
 * local TTS via the pack's own worker — the ~110MB VITS wasm + MEMFS preload
 * is far too heavy for the main thread (it froze pages for minutes when run
 * there). The worker's own sherpa-onnx-tts.worker.js is the intended host:
 * it importScripts the wasm, builds the engine, and answers generate msgs.
 */
export class LocalTts {
	private worker: Worker | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private pending: ((a: { samples: Float32Array; sampleRate: number } | null) => void) | null = null;

	private async makeWorker(): Promise<Worker> {
		const name = 'sherpa-onnx-tts.worker.js';
		const local = `${PACKS.tts.dir}/${name}`;
		const localOk = await fetch(local, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
		if (localOk) return new Worker(local);
		// remote: the worker importScripts its siblings and locates wasm/.data
		// relative to its own URL — rewrite both to the extracted blob map
		const files = await fetchRemotePack(PACKS.tts.remote);
		let src = await (await fetch(files[name])).text();
		src = src
			.replace(/importScripts\((['"])([^'"]+)\1\)/g, (_m, q, p) => `importScripts(${q}${files[p] ?? p}${q})`)
			.replace('return scriptDirectory + path', 'return (__PACK__[path.split("/").pop()] ?? scriptDirectory + path)');
		return new Worker(
			URL.createObjectURL(new Blob([`const __PACK__=${JSON.stringify(files)};\n${src}`], { type: 'text/javascript' }))
		);
	}

	async init(): Promise<boolean> {
		if (this.worker) return true;
		console.debug('[stt] tts init start');
		try {
			const w = await this.makeWorker();
			const ok = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 180_000);
				w.onmessage = (e) => {
					const d = e.data as { type?: string; message?: string };
					if (d?.type === 'sherpa-onnx-tts-ready') {
						clearTimeout(timer);
						resolve(true);
					} else if (d?.type === 'error') {
						clearTimeout(timer);
						console.warn('[stt] tts init error:', d.message);
						resolve(false);
					}
				};
				w.onerror = (e) => {
					clearTimeout(timer);
					console.warn('[stt] tts worker error:', e.message);
					resolve(false);
				};
			});
			if (!ok) {
				w.terminate();
				return false;
			}
			this.worker = w;
			w.onmessage = (e) => this.onResult(e);
			w.onerror = null;
			console.debug('[stt] tts pack loaded: true');
			return true;
		} catch (e) {
			console.warn('[stt] tts init failed', e);
			return false;
		}
	}

	private onResult(e: MessageEvent) {
		const d = e.data as { type?: string; samples?: Float32Array; sampleRate?: number; message?: string };
		const resolve = this.pending;
		if (!resolve) return;
		if (d?.type === 'sherpa-onnx-tts-result' && d.samples) {
			this.pending = null;
			resolve({ samples: d.samples, sampleRate: d.sampleRate ?? 22050 });
		} else if (d?.type === 'error') {
			this.pending = null;
			console.warn('[stt] tts generate failed:', d.message);
			resolve(null);
		}
	}

	/** serialized — the worker generates one utterance at a time */
	speak(text: string): Promise<{ samples: Float32Array; sampleRate: number } | null> {
		const w = this.worker;
		if (!w) return Promise.resolve(null);
		const run = this.queue.then(
			() =>
				new Promise<{ samples: Float32Array; sampleRate: number } | null>((resolve) => {
					const timer = setTimeout(() => {
						this.pending = null;
						resolve(null);
					}, 60_000);
					this.pending = (a) => {
						clearTimeout(timer);
						resolve(a);
					};
					w.postMessage({ type: 'generate', text, sid: 0, speed: 1.0 });
				})
		);
		this.queue = run.catch(() => {});
		return run;
	}
}
