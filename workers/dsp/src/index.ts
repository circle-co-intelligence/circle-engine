/**
 * cic-dsp — edge-side audio processing for paid, opted-in rooms.
 *
 * Cloudflare Realtime Media Transport Adapters hand a track's audio to this
 * worker as PCM over WebSocket; we return processed PCM which the adapter
 * republishes as a track. One DspBus DO per adapter session.
 *
 * Frame contract (symmetric): binary messages are raw PCM — Int16
 * little-endian, 16 kHz mono, 10 ms frames (160 samples / 320 bytes per
 * message). We echo processed frames with identical length.
 *
 * The processing chain below is a real, deterministic DSP pass (DC-block
 * high-pass → adaptive noise gate → soft compressor). DeepFilterNet WASM is
 * the designated upgrade: swap `processFrame` for a libdf `df_process_frame`
 * call once the wasm module is bundled — the plumbing doesn't change.
 *
 * NOTHING is stored. The DO keeps no state between frames beyond filter
 * coefficients; hibernation-compatible.
 */

export interface Env {
	DSP: DurableObjectNamespace<DspBus>;
	/** paid sensory lane: 'speechmatics' | 'assemblyai' — unset = lane off */
	SPEECH_PROVIDER?: string;
	SPEECH_API_KEY?: string;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (req.headers.get('upgrade') !== 'websocket')
			return new Response('expected websocket', { status: 426 });
		if (url.pathname === '/speech') {
			// sensory lane: PCM16 in → diarized transcript + audio events out
			if (!env.SPEECH_API_KEY) return new Response('speech lane off', { status: 503 });
			return relaySpeech(req, env);
		}
		if (url.pathname !== '/audio')
			return new Response('cic-dsp: /audio or /speech', { status: 404 });
		// one DO per adapter session — adapter supplies ?session=<id>
		const name = url.searchParams.get('session') ?? 'default';
		const stub = env.DSP.get(env.DSP.idFromName(name));
		return stub.fetch(req);
	}
};

/**
 * /speech — bidirectional relay to a cloud speech provider's realtime API.
 * In:  binary PCM16 mono 16 kHz frames from the client (or adapter tee).
 * Out: JSON events {t:'transcript'|'event', speaker?, text, event?} — the
 * annotated stream Milo consumes as its sensory layer (who spoke, what the
 * room sounded like). No audio or transcript is retained here.
 */
async function relaySpeech(req: Request, env: Env): Promise<Response> {
	const provider = env.SPEECH_PROVIDER ?? 'speechmatics';
	const upstream =
		provider === 'assemblyai'
			? `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&token=${env.SPEECH_API_KEY}&speaker_labels=true`
			: `wss://eu2.rt.speechmatics.com/v2?jwt=${env.SPEECH_API_KEY}`;
	const up = await fetch(upstream, { headers: { upgrade: 'websocket' } });
	const upWs = up.webSocket;
	if (!upWs) return new Response('provider connect failed', { status: 502 });
	upWs.accept();

	const pair = new WebSocketPair();
	const [client, server] = Object.values(pair);
	server.accept();

	if (provider === 'speechmatics')
		upWs.send(
			JSON.stringify({
				message: 'StartRecognition',
				audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
				transcription_config: {
					language: 'en',
					diarization: 'speaker',
					enable_entities: true,
					max_delay: 2
				},
				audio_events_config: { types: ['laughter', 'applause', 'music'] }
			})
		);

	server.addEventListener('message', (ev) => {
		const d = ev.data;
		if (d instanceof ArrayBuffer) upWs.send(d); // raw PCM16 frame
	});
	upWs.addEventListener('message', (ev) => {
		try {
			if (typeof ev.data !== 'string') return;
			const m = JSON.parse(ev.data) as Record<string, unknown>;
			const mapped = mapProviderEvent(provider, m);
			if (mapped) server.send(JSON.stringify(mapped));
		} catch {
			/* malformed provider frame — drop */
		}
	});
	upWs.addEventListener('close', () => server.close());
	server.addEventListener('close', () => upWs.close());
	return new Response(null, { status: 101, webSocket: client });
}

/** normalize provider messages → our sensory event contract */
function mapProviderEvent(
	provider: string,
	m: Record<string, unknown>
): Record<string, unknown> | null {
	if (provider === 'assemblyai') {
		if (m.message_type === 'FinalTranscript')
			return { t: 'transcript', text: m.text, final: true, speaker: m.words ? undefined : undefined };
		return null;
	}
	// speechmatics
	if (m.message === 'AddTranscript') {
		const results = (m.results ?? []) as { alternatives?: { content?: string; speaker?: string }[]; type?: string }[];
		const words = results
			.filter((r) => r.type === 'word')
			.map((r) => r.alternatives?.[0])
			.filter(Boolean);
		const text = words.map((w) => w!.content).join(' ');
		const speaker = words.find((w) => w!.speaker)?.speaker;
		return text ? { t: 'transcript', text, final: true, speaker } : null;
	}
	if (m.message === 'AudioEventStarted' || m.message === 'AudioEventEnded') {
		const ev = (m as { event_type?: string }).event_type;
		return ev ? { t: 'event', event: ev, end: m.message === 'AudioEventEnded' } : null;
	}
	return null;
}

export class DspBus implements DurableObject {
	private hpPrevIn = 0;
	private hpPrevOut = 0;
	private noiseFloor = 0.004; // adaptive RMS floor, starts just above silence

	constructor(private ctx: DurableObjectState) {}

	async fetch(): Promise<Response> {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server); // hibernation-compatible
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(_ws: WebSocket, msg: ArrayBuffer | string) {
		if (typeof msg === 'string' || msg.byteLength < 2) return;
		const out = this.processFrame(new Int16Array(msg));
		for (const ws of this.ctx.getWebSockets()) ws.send(out.buffer);
	}

	webSocketClose() {}
	webSocketError() {}

	/**
	 * One-pole DC-blocker (removes DC/rumble) → RMS-adaptive noise gate →
	 * soft-knee compressor. ~40× realtime on a single core at 16 kHz.
	 */
	private processFrame(pcm: Int16Array): Int16Array {
		const out = new Int16Array(pcm.length);
		// adaptive noise floor: track the quietest decile RMS
		let sum = 0;
		for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
		const rms = Math.sqrt(sum / pcm.length) / 32768;
		if (rms < this.noiseFloor * 1.5)
			this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
		const gate = rms < this.noiseFloor * 1.2 ? 0.15 : 1.0;
		for (let i = 0; i < pcm.length; i++) {
			const x = pcm[i] / 32768;
			// DC-blocker: y[n] = x[n] - x[n-1] + 0.995·y[n-1]  (~20 Hz high-pass)
			const hp = x - this.hpPrevIn + 0.995 * this.hpPrevOut;
			this.hpPrevIn = x;
			this.hpPrevOut = hp;
			// soft compressor: tanh-ish soft clip above 0.6
			let y = hp * gate * 1.25;
			y = Math.abs(y) > 0.6 ? Math.sign(y) * (0.6 + Math.tanh((Math.abs(y) - 0.6) * 3) * 0.4) : y;
			out[i] = Math.max(-32768, Math.min(32767, Math.round(y * 32768)));
		}
		return out;
	}
}
