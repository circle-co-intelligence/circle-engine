/**
 * sensory.ts — the paid sensory lane's client half. Streams local mic PCM16
 * to cic-dsp /speech, which relays through Speechmatics/AssemblyAI and hands
 * back diarized transcripts + audio events (laughter/applause/music).
 *
 * Events land in the room session as speaker-attributed transcript-window
 * lines — Milo gains who-spoke and what-the-room-sounded-like, and audio
 * events surface as reactions. Paid-gated, explicit opt-in; audio leaves the
 * device only inside this lane (plaintext, badged).
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

export class SensoryPipe {
	private ws: WebSocket | null = null;
	private alive = false;

	constructor(
		private endpoint: string,
		private sink: SensorySink
	) {}

	start() {
		if (this.alive) return;
		this.alive = true;
		const ws = new WebSocket(this.endpoint);
		ws.binaryType = 'arraybuffer';
		ws.onmessage = (ev) => {
			try {
				this.sink.ingestSensory(JSON.parse(ev.data as string) as SensoryEvent);
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
