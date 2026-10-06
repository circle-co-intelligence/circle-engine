/**
 * ear.ts — Milo's consent-bounded hearing.
 *
 * When the room enables AI (ai-set enabled) AND this peer has signed
 * ear-set{on}, we tap the local mic, run the same on-device caption
 * pipeline (whisper by default), and forward each final utterance line to
 * the elected milo-brain seat as a `milo-hear` realtime message.
 *
 *   - Never broadcast as captions — text goes only to the brain seat.
 *   - Audio never leaves the device; the ASR runs locally.
 *   - Revocation (ear-set{off} / heartMode / ai disabled) stops the tap
 *     immediately; already-sent lines can be purged via erasure.
 */

import { CaptionPipeline } from './speech';

const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
	process(inputs) {
		const ch = inputs[0]?.[0];
		if (ch && ch.length) this.port.postMessage(ch.slice(0));
		return true;
	}
}
registerProcessor('cic-ear-tap', PcmTap);
`;

export interface EarSink {
	/** a final utterance line: text + whisper-detected ISO lang */
	onLine(text: string, lang?: string): void;
}

export class MicEar {
	private ctx: AudioContext | null = null;
	private pipeline: CaptionPipeline | null = null;
	private node: AudioWorkletNode | null = null;
	private src: MediaStreamAudioSourceNode | null = null;
	private dead = new Float32Array(0); // sink so the graph pulls
	private gain: GainNode | null = null;

	constructor(private sink: EarSink) {}

	async start(mic: MediaStream): Promise<boolean> {
		if (this.ctx) return true;
		const track = mic.getAudioTracks().find((t) => t.readyState === 'live');
		if (!track) return false;
		const pipeline = new CaptionPipeline();
		if (!(await pipeline.init())) {
			pipeline.dispose();
			return false;
		}
		this.pipeline = pipeline;
		this.pipeline.onSegment = (seg) => {
			if (seg.final && seg.text.trim()) this.sink.onLine(seg.text.trim(), seg.lang);
		};
		try {
			const ctx = new AudioContext();
			// iOS suspends contexts created outside a gesture — the ear opens on
			// op-apply paths, so arm a one-shot resume for the next real tap
			const unstick = () => {
				if (ctx.state !== 'running') void ctx.resume().catch(() => {});
				if (ctx.state === 'running') document.removeEventListener('pointerdown', unstick);
			};
			document.addEventListener('pointerdown', unstick);
			await ctx.audioWorklet.addModule(
				URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))
			);
			this.ctx = ctx;
			this.src = ctx.createMediaStreamSource(new MediaStream([track]));
			this.node = new AudioWorkletNode(ctx, 'cic-ear-tap');
			this.node.port.onmessage = (e) => {
				const f32 = e.data as Float32Array;
				// downsample ctx rate → 16k mono the pipeline expects
				this.pipeline?.push(resampleTo16k(f32, ctx.sampleRate));
			};
			// pull the graph without audible playback: source → worklet → muted gain → out
			this.gain = ctx.createGain();
			this.gain.gain.value = 0;
			this.src.connect(this.node);
			this.node.connect(this.gain);
			this.gain.connect(ctx.destination);
			return true;
		} catch {
			this.stop();
			this.pipeline?.dispose();
			this.pipeline = null;
			return false;
		}
	}

	stop() {
		this.node?.disconnect();
		this.src?.disconnect();
		this.gain?.disconnect();
		this.node = null;
		this.src = null;
		this.gain = null;
		void this.ctx?.close().catch(() => {});
		this.ctx = null;
		this.pipeline?.dispose();
		this.pipeline = null;
	}
}

function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
	if (fromRate === 16000) return input;
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
