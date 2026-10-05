/**
 * sensory.ts — the paid sensory lane's client half. Streams local mic PCM16
 * to a Speechmatics-RT-compatible endpoint and gets back diarized
 * transcripts + audio events (laughter/applause/music).
 *
 * Two transports, same event contract:
 *   relay   — wss cic-dsp /speech (default): we ship raw PCM16, the worker
 *             owns provider auth + StartRecognition
 *   direct  — VITE_CIC_SPEECH_URL: a Speechmatics RT endpoint the client
 *             reaches itself — SaaS (with a temp ?jwt= minted by
 *             cic-dsp/speech-token), an on-prem appliance, or Speechmatics
 *             On-Device's local service in a native shell. Direct mode
 *             sends StartRecognition itself.
 *
 * Events land in the room session as speaker-attributed transcript-window
 * lines — Milo gains who-spoke and what-the-room-sounded-like, and audio
 * events surface as reactions. Paid-gated, explicit opt-in; audio leaves
 * the device only inside this lane (plaintext, badged).
 */

export interface SensoryEvent {
	t: 'transcript' | 'event';
	text?: string;
	final?: boolean;
	speaker?: string;
	event?: string;
	end?: boolean;
}

export interface SensorySink {
	ingestSensory(ev: SensoryEvent): void;
}

const SPEECH_LANG =
	(import.meta.env as Record<string, string | undefined>).VITE_CIC_SPEECH_LANG ?? 'en';

const START_RECOGNITION = {
	message: 'StartRecognition',
	audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
	transcription_config: {
		language: SPEECH_LANG,
		diarization: 'speaker',
		enable_entities: true,
		max_delay: 2
	},
	audio_events_config: { types: ['laughter', 'applause', 'music'] }
};

export class SensoryPipe {
	private ws: WebSocket | null = null;
	private alive = false;

	constructor(
		private endpoint: string,
		private sink: SensorySink,
		/** direct mode: we're speaking Speechmatics RT ourselves */
		private direct = false
	) {}

	start() {
		if (this.alive) return;
		this.alive = true;
		const ws = new WebSocket(this.endpoint);
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			if (this.direct) ws.send(JSON.stringify(START_RECOGNITION));
		};
		ws.onmessage = (ev) => {
			try {
				const m = JSON.parse(ev.data as string) as Record<string, unknown>;
				const mapped = this.direct ? mapDirect(m) : (m as unknown as SensoryEvent);
				if (mapped) this.sink.ingestSensory(mapped);
			} catch {
				/* malformed frame */
			}
		};
		ws.onclose = () => {
			this.ws = null;
			if (this.alive) setTimeout(() => this.start(), 3000); // simple reconnect
		};
		this.ws = ws;
	}

	/** feed a PCM16 frame (16 kHz mono) — called from the mic tap */
	feed(pcm: Int16Array) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm.buffer);
	}

	stop() {
		this.alive = false;
		this.ws?.close();
		this.ws = null;
	}
}

/** Speechmatics RT messages → sensory events (direct mode) */
export function mapDirect(m: Record<string, unknown>): SensoryEvent | null {
	if (m.message === 'AddTranscript') {
		const results = (m.results ?? []) as {
			alternatives?: { content?: string; speaker?: string }[];
			type?: string;
		}[];
		const words = results
			.filter((r) => r.type === 'word')
			.map((r) => r.alternatives?.[0])
			.filter(Boolean);
		const text = words.map((w) => w!.content).join(' ');
		const speaker = words.find((w) => w!.speaker)?.speaker;
		return text ? { t: 'transcript', text, final: true, speaker } : null;
	}
	if (m.message === 'AddPartialTranscript') {
		const meta = m.metadata as { transcript?: string } | undefined;
		return meta?.transcript ? { t: 'transcript', text: meta.transcript, final: false } : null;
	}
	if (m.message === 'AudioEventStarted' || m.message === 'AudioEventEnded') {
		const ev = (m as { event_type?: string }).event_type;
		return ev ? { t: 'event', event: ev, end: m.message === 'AudioEventEnded' } : null;
	}
	return null;
}
