/**
 * Speaking detection — AnalyserNode RMS over each participant's audio track.
 * Emits the loudest active speaker to the bridge as prod's `speaking{id}` op
 * (drives the production ring highlight). WebAudio only — no model needed.
 */

const POLL_MS = 180;
const THRESHOLD = 0.012; // RMS gate — speech-level signal
const HOLD_MS = 700; // hysteresis so the ring doesn't flicker mid-sentence

export class SpeakingMonitor {
	private ctx: AudioContext | null = null;
	private analysers = new Map<string, { analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> }>();
	private streams = new Map<string, MediaStream>();
	private timer = 0;
	private current: string | null = null;
	private lastActive = 0;

	constructor(private onSpeaking: (peerId: string | null) => void) {}

	/** called by the bridge whenever session remoteStreams/local stream change */
	setStreams(selfStream: MediaStream | null, remotes: Record<string, MediaStream>, selfId: string) {
		this.streams = new Map(Object.entries(remotes));
		if (selfStream) this.streams.set(selfId, selfStream);
		this.ensureCtx();
		for (const [id, stream] of this.streams) {
			if (this.analysers.has(id)) continue;
			const track = stream.getAudioTracks().find((t) => t.readyState === 'live' && t.enabled !== false);
			if (!track || !this.ctx) continue;
			try {
				const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
				const analyser = this.ctx.createAnalyser();
				analyser.fftSize = 512;
				src.connect(analyser);
				this.analysers.set(id, { analyser, buf: new Uint8Array(new ArrayBuffer(analyser.fftSize)) });
			} catch {}
		}
		for (const id of [...this.analysers.keys()]) {
			if (!this.streams.has(id)) this.analysers.delete(id);
		}
		if (!this.timer && this.analysers.size) {
			this.timer = window.setInterval(() => this.poll(), POLL_MS);
		}
	}

	private ensureCtx() {
		if (!this.ctx) {
			try {
				this.ctx = new AudioContext();
			} catch {
				this.ctx = null;
			}
		}
		if (this.ctx?.state === 'suspended') void this.ctx.resume();
	}

	private poll() {
		let loudest: string | null = null;
		let loudestRms = 0;
		for (const [id, a] of this.analysers) {
			a.analyser.getByteTimeDomainData(a.buf);
			let sum = 0;
			for (let i = 0; i < a.buf.length; i++) {
				const v = (a.buf[i] - 128) / 128;
				sum += v * v;
			}
			const rms = Math.sqrt(sum / a.buf.length);
			if (rms > THRESHOLD && rms > loudestRms) {
				loudest = id;
				loudestRms = rms;
			}
		}
		if (loudest) {
			this.lastActive = Date.now();
			if (loudest !== this.current) {
				this.current = loudest;
				this.onSpeaking(loudest);
			}
		} else if (this.current && Date.now() - this.lastActive > HOLD_MS) {
			this.current = null;
			this.onSpeaking(null);
		}
	}

	dispose() {
		clearInterval(this.timer);
		this.timer = 0;
		this.analysers.clear();
		this.streams.clear();
		void this.ctx?.close();
		this.ctx = null;
	}
}
