/**
 * CaptionSocket — terminates the production caption-audio socket.
 * The frontend pushes raw PCM (Int16) here after `caption-source-ready`;
 * we run it through the local sherpa-onnx streaming ASR and emit real
 * `caption-update` frames back over the room socket (and to the mesh so
 * remote bridges show our speech too). No audio ever leaves the device.
 */
import { LocalSocket } from './localSocket';
import { CaptionPipeline, LocalTts } from '../ai/speech';
import { translateText } from '../ai/translate';
import type { RoomSession } from '../state/room.svelte';

type Frame = Record<string, unknown>;
interface Emit {
	frame(f: Frame): void;
}

// one VITS engine per page — fanout instances churn with sockets, and the
// ~110MB pack + engine alloc must not repeat per instance
let sharedTtsInstance: LocalTts | null = null;
function sharedTts(): LocalTts {
	return (sharedTtsInstance ??= new LocalTts());
}
/** start the TTS pack download as soon as translation has targets — first
 *  caption-audio shouldn't wait on a ~110MB cold load at final time */
let ttsWarming: Promise<boolean> | null = null;
function warmTts(): Promise<boolean> {
	return (ttsWarming ??= sharedTts().init());
}

export class CaptionSocket extends LocalSocket {
	private pipeline = new CaptionPipeline();
	private ready = false;
	private sampleRate = 16000;
	private seq = 0;
	private fanout: TranslationFanout | null = null;

	constructor(
		url: string,
		private sink: Emit,
		private session: RoomSession | null,
		private sourceId: string,
		private target = 'en',
		private subscription = 0
	) {
		super(url);
		const gen = new URL(url).searchParams.get('gen') ?? '0';
		// open before ASR init — prod's worklet starts pushing PCM the moment the
		// socket opens; a CONNECTING socket makes prod buffer into its bounded
		// pending queue (~1s of audio) and then fail the whole capture. Frames
		// dropped while !ready cost a moment of warmup audio instead.
		this.open();
		void this.init(gen);
	}

	private async init(generation: string) {
		this.ready = await this.pipeline.init();
		if (!this.ready) {
			this.sink.frame({ t: 'caption-state', state: 'error', reason: 'model_unavailable', generation });
			this.terminate();
			return;
		}
		this.pipeline.onSegment = (seg) => {
			const update = {
				sourceId: this.sourceId,
				generation,
				target: this.target,
				subscription: this.subscription,
				sequence: ++this.seq,
				state: 'live',
				at: Date.now(),
				sections: [
					{
						id: 1,
						original: { final: seg.final ? seg.text : '', partial: seg.final ? '' : seg.text },
						translation: { final: '', partial: '' }
					}
				]
			};
			this.sink.frame({ t: 'caption-update', update });
			if (this.session) {
				this.fanout ??= new TranslationFanout(this.session, this.sink);
				this.fanout.emit(seg, generation, this.session.selfId, this.sourceId);
			}
			// remote docks get the same sections via the caption-sections relay —
			// NOT s.captions (the speech-frame lane owns transcript entries; adding
			// here would double-commit the same audio on every remote)
			this.session?.broadcast({ t: 'caption-sections', update });
		};
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
		if (!this.ready || typeof data === 'string' || data instanceof Blob) return;
		const bytes = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
		const pcm16 = new Int16Array(bytes);
		const f32 = new Float32Array(pcm16.length);
		for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
		this.pipeline.push(this.sampleRate === 16000 ? f32 : resample(f32, this.sampleRate));
	}

	protected onClose() {
		this.pipeline.dispose(); // release the wasm recognizer — sockets churn
		this.pipeline = new CaptionPipeline();
		this.fanout?.dispose();
		this.fanout = null;
	}
}

/**
 * SpeechStreamPipe — terminates the production multiplexed speech stream.
 * The app opens a logical stream on the room socket via `speech-open`
 * ({engine:"deepgram"|..., sampleRate}) and pushes `speech-frame` frames
 * carrying base64 Int16 PCM. We decode, run sherpa-onnx, and emit
 * `speech-event` replies in the provider result shape the app parses
 * ({type:"Results", is_final, channel.alternatives[0].transcript}).
 * Text frames (Configure/CloseStream/etc.) get the matching ack shapes.
 */
export class SpeechStreamPipe {
	private pipeline = new CaptionPipeline();
	private ready = false;
	private t0 = 0;
	readonly id: string;
	readonly sampleRate: number;

	constructor(
		id: string,
		sampleRate: number,
		private sink: Emit,
		private session: RoomSession | null,
		private sourceId: string,
		private fanout: TranslationFanout | null = null
	) {
		this.id = id;
		this.sampleRate = sampleRate;
	}

	async init(): Promise<boolean> {
		try {
			this.ready = await this.pipeline.init();
		} catch (e) {
			console.warn('[stt] pipeline init threw', e);
		}
		console.debug('[stt] speech stream init', this.id.slice(0, 8), this.sampleRate, 'ready:', this.ready);
		if (!this.ready) {
			this.sink.frame({ t: 'speech-event', id: this.id, event: 'close' });
			return false;
		}
		this.t0 = Date.now();
		if (this.session) this.session.captionsAvailable = true;
		this.pipeline.onSegment = (seg) => {
			console.debug('[stt] seg', seg.final ? 'final' : 'partial', JSON.stringify(seg.text));
			this.sink.frame({
				t: 'speech-event',
				id: this.id,
				event: 'message',
				data: JSON.stringify({
					type: 'Results',
					start: (Date.now() - this.t0) / 1000,
					duration: 0,
					is_final: seg.final,
					speech_final: seg.final,
					channel: { alternatives: [{ transcript: seg.text, confidence: 0.99 }] }
				})
			});
			// the source's own device translates for subscribers — prod's server
			// did this; here the mesh realtime lane carries tr-segment payloads
			if (this.session)
				this.fanout?.emit(seg, this.id, this.session.selfId, this.sourceId);
			// transcript entries commit only when prod sends its `transcript`
			// frame back (after its own quiet-detection) — appending here too
			// would double every line
		};
		this.sink.frame({ t: 'speech-event', id: this.id, event: 'open' });
		return true;
	}

	frame(data: string, binary: boolean) {
		if (!this.ready) return;
		if (!binary) {
			try {
				const msg = JSON.parse(data);
				if (msg?.type === 'Configure')
					this.sink.frame({
						t: 'speech-event',
						id: this.id,
						event: 'message',
						data: JSON.stringify({ type: 'ConfigureSuccess' })
					});
				else if (msg?.type === 'CloseStream') this.dispose();
			} catch {}
			return;
		}
		const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
		const pcm16 = new Int16Array(bin.buffer, bin.byteOffset, bin.byteLength >> 1);
		const f32 = new Float32Array(pcm16.length);
		for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
		const mono16k = this.sampleRate === 16000 ? f32 : resample(f32, this.sampleRate);
		// sensory tee (paid lane): 16k PCM16 → cic-dsp /speech → diarized events
		if (this.session?.sensory) {
			const i16 = new Int16Array(mono16k.length);
			for (let i = 0; i < mono16k.length; i++)
				i16[i] = Math.max(-32768, Math.min(32767, Math.round(mono16k[i] * 32767)));
			this.session.sensory.feed(i16);
		}
		try {
			this.pipeline.push(mono16k);
		} catch (e) {
			console.warn('[stt] sherpa push failed', e);
			this.dispose();
			this.sink.frame({ t: 'speech-event', id: this.id, event: 'close' });
		}
	}

	dispose() {
		if (!this.ready) return;
		this.ready = false;
		this.pipeline.dispose(); // release the wasm recognizer — pipes churn
		this.pipeline = new CaptionPipeline();
	}
}

/**
 * TranslationFanout — the speaker's device does prod's server-side job: every
 * locally-ASR'd segment is translated on-device (wllama) into each language
 * subscribers declared via participant-translation, then shipped to them.
 *
 *   self subscriber  → frames emitted on our own room socket directly
 *   remote subscriber → tr-segment realtime mesh message; the remote bridge
 *                       drains it into tr-caption{lang,which,delta} +
 *                       caption-audio{sourceId,generation,sequence,pcm,cue}
 *                       (base64 Int16 PCM at 24kHz — prod's player rate)
 */
interface Job {
	seg: { text: string; final: boolean };
	targets: Map<string, string[]>;
	generation: string;
	sourceMeshId: string;
	sourceProdId: string;
}

export class TranslationFanout {
	// one VITS engine per page — fanout instances churn with sockets, and the
	// ~110MB pack + engine alloc must not repeat per instance
	private tts = sharedTts();
	private ttsReady: boolean | null = null;
	private seq = 0;
	// wllama is a single-session engine — delivery serializes through pump().
	// Partials are latest-wins (a small local model can't chase every partial);
	// finals queue in order and always run. Crucially, pending partials never
	// accumulate chain nodes — under sustained speech, per-partial enqueues
	// starve finals (and their TTS work) at the tail of a growing queue.
	private finals: Job[] = [];
	private pendingPartial: Job | null = null;
	private pumping = false;
	// subscription diffing for replay: segments emitted before a subscriber
	// declared their language used to drop silently — a late registerer sat
	// silent until the next utterance. Recent finals are buffered and replayed
	// into only the newly-added (lang,peer) lanes on each subscription change.
	private recentFinals: Omit<Job, 'targets'>[] = [];
	private servedTargets = new Map<string, Set<string>>(); // lang → peerIds
	private unwatch: () => void;

	constructor(
		private session: RoomSession,
		private sink: Emit
	) {
		this.unwatch = session.watchTrTargets(() => this.notifyTargets());
	}

	dispose() {
		this.unwatch();
	}

	private computeTargets(): Map<string, string[]> {
		const s = this.session;
		const targets = new Map<string, string[]>(); // lang → mesh peerIds
		for (const [peerId, langs] of Object.entries(s.peerLangs))
			for (const lang of langs)
				if (lang && lang !== 'none' && lang !== s.selfLang)
					targets.set(lang, [...(targets.get(lang) ?? []), peerId]);
		for (const lang of s.selfLangs)
			if (lang !== 'none' && lang !== s.selfLang)
				targets.set(lang, [...(targets.get(lang) ?? []), s.selfId]);
		return targets;
	}

	private markServed(targets: Map<string, string[]>) {
		for (const [lang, peers] of targets) {
			const known = this.servedTargets.get(lang) ?? new Set<string>();
			for (const p of peers) known.add(p);
			this.servedTargets.set(lang, known);
		}
	}

	/** subscription set changed — replay buffered finals to newly-added lanes */
	private notifyTargets() {
		const targets = this.computeTargets();
		// prune departed lanes so a rejoining peer counts as new again
		for (const [lang, known] of this.servedTargets)
			for (const p of [...known]) if (!targets.get(lang)?.includes(p)) known.delete(p);
		const added = new Map<string, string[]>();
		for (const [lang, peers] of targets) {
			const known = this.servedTargets.get(lang);
			for (const p of peers)
				if (!known?.has(p)) added.set(lang, [...(added.get(lang) ?? []), p]);
		}
		this.markServed(targets);
		if (!added.size || !this.recentFinals.length) return;
		void warmTts();
		// catch the lane up on the last two finals only — deeper backlog is
		// the transcript pane's job, not the caption lane's
		for (const f of this.recentFinals.slice(-2))
			this.finals.push({ ...f, targets: added });
		void this.pump();
	}

	/** fan a locally-ASR'd segment out to every declared translation lane */
	emit(seg: { text: string; final: boolean }, generation: string, sourceMeshId: string, sourceProdId: string) {
		if (!seg.text) return;
		const s = this.session;
		if (seg.final) {
			this.recentFinals.push({ seg, generation, sourceMeshId, sourceProdId });
			if (this.recentFinals.length > 4) this.recentFinals.shift();
		}
		const targets = this.computeTargets();
		this.markServed(targets);
		if (!targets.size) {
			console.debug('[stt] fanout: no targets', JSON.stringify({
				selfLangs: s.selfLangs, selfLang: s.selfLang, peerLangs: s.peerLangs, final: seg.final
			}));
			return;
		}
		void warmTts(); // a final will need it — start the ~110MB pack download early
		const job: Job = { seg, targets, generation, sourceMeshId, sourceProdId };
		if (seg.final) this.finals.push(job);
		else this.pendingPartial = job;
		void this.pump();
	}

	private async pump() {
		if (this.pumping) return;
		this.pumping = true;
		try {
			for (;;) {
				// a final supersedes a pending partial of the same utterance
				let job: Job | null = this.finals.shift() ?? null;
				if (job) this.pendingPartial = null;
				else {
					job = this.pendingPartial;
					this.pendingPartial = null;
				}
				if (!job) break;
				try {
					await this.deliver(job.seg, job.targets, job.generation, job.sourceMeshId, job.sourceProdId);
				} catch { /* one bad segment must not wedge the lane */ }
			}
		} finally {
			this.pumping = false;
		}
	}

	private async deliver(
		seg: { text: string; final: boolean },
		targets: Map<string, string[]>,
		generation: string,
		sourceMeshId: string,
		sourceProdId: string
	) {
		const s = this.session;
		const which = seg.final ? 'final' : 'partial';
		for (const [lang, peers] of targets) {
			const text = await translateText(seg.text, lang, s.selfLang);
			if (!text) {
				console.debug('[stt] translate→', lang, 'unavailable (model missing or busy)');
				continue;
			}
			// text first — the ~110MB TTS pack's first init is slow; prod shows
			// the caption immediately and plays audio when it arrives
			const cueId = ++this.seq;
			for (const peerId of peers) {
				if (peerId === s.selfId) this.sink.frame({ t: 'tr-caption', lang, which, delta: text });
				else
					s.sendTrSegment(peerId, {
						lang, which, delta: text, sourceId: sourceMeshId,
						generation, cueId, original: seg.text
					});
			}
			// caption-audio only for finalized speech — partials are text-only
			if (!seg.final) continue;
			const pcm = await this.synthesize(text);
			if (!pcm) continue;
			for (const peerId of peers) {
				if (peerId === s.selfId)
					this.sink.frame({
						t: 'caption-audio', sourceId: sourceProdId, generation,
						sequence: cueId, pcm, cue: { id: cueId, text, original: seg.text }
					});
				else
					s.sendTrSegment(peerId, {
						lang, which, delta: '', sourceId: sourceMeshId,
						generation, cueId, original: seg.text, pcm
					});
			}
		}
	}

	/** sherpa piper → base64 Int16 PCM at 24kHz (prod's caption player rate) */
	private async synthesize(text: string): Promise<string | null> {
		if (this.ttsReady === null) {
			this.ttsReady = await warmTts();
			console.debug('[stt] tts ready:', this.ttsReady);
		}
		if (!this.ttsReady) return null;
		const audio = await this.tts.speak(text);
		if (!audio) return null;
		const f32 = audio.sampleRate === 24000 ? audio.samples : resampleTo(audio.samples, audio.sampleRate, 24000);
		const pcm16 = new Int16Array(f32.length);
		for (let i = 0; i < f32.length; i++)
			pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
		const bytes = new Uint8Array(pcm16.buffer);
		let bin = '';
		for (let i = 0; i < bytes.length; i += 8192)
			bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
		return btoa(bin);
	}
}

/**
 * TranslationSpeechPipe — terminates prod's `speech-open{engine:"translation"}`
 * stream. On prod this is the subscriber's transport/receive channel (their p_
 * wraps it into an audio element); the consumer sends no PCM, so there is
 * nothing to ASR here. The actual translation fanout runs on the source's
 * ASR path — see TranslationFanout.
 */
export class TranslationSpeechPipe {
	private ready = false;
	readonly id: string;
	readonly sampleRate: number;

	constructor(id: string, sampleRate: number, private sink: Emit) {
		this.id = id;
		this.sampleRate = sampleRate;
	}

	async init(): Promise<boolean> {
		this.ready = true;
		this.sink.frame({ t: 'speech-event', id: this.id, event: 'open' });
		return true;
	}

	frame(data: string, binary: boolean) {
		if (!this.ready || binary) return; // subscribers never send PCM
		try {
			const msg = JSON.parse(data);
			if (msg?.type === 'Configure')
				this.sink.frame({
					t: 'speech-event', id: this.id, event: 'message',
					data: JSON.stringify({ type: 'ConfigureSuccess' })
				});
			else if (msg?.type === 'CloseStream') this.dispose();
		} catch {}
	}

	dispose() {
		this.ready = false;
	}
}

function resampleTo(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	const ratio = fromRate / toRate;
	const out = new Float32Array(Math.floor(input.length / ratio));
	for (let i = 0; i < out.length; i++) {
		const pos = i * ratio;
		const lo = Math.floor(pos);
		const hi = Math.min(lo + 1, input.length - 1);
		out[i] = input[lo] + (input[hi] - input[lo]) * (pos - lo);
	}
	return out;
}

function resample(input: Float32Array, fromRate: number): Float32Array {
	const ratio = fromRate / 16000;
	const out = new Float32Array(Math.floor(input.length / ratio));
	for (let i = 0; i < out.length; i++) {
		const pos = i * ratio;
		const lo = Math.floor(pos);
		const hi = Math.min(lo + 1, input.length - 1);
		out[i] = input[lo] + (input[hi] - input[lo]) * (pos - lo);
	}
	return out;
}
