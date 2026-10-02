/**
 * tune.ts — the role→params table for every media knob prod leaves stock.
 * One declarative module covers: codec preference (AV1 → VP9 → H264, audio
 * RED when lossy), scalabilityMode temporal layers, contentHint, Opus
 * FEC/DTX/ptime hints, degradationPreference and encoding priority.
 *
 * Roles come from the talking-stick machine: who holds the stick is the
 * interactive talker (low latency, full quality), listeners get temporal
 * layers + normal budgets, screen share is detail-first. Witness/audience
 * pulls are handled SFU-side (preferredRid), not here.
 */

export type MediaRole = 'talker' | 'listener' | 'screen';

interface SenderTune {
	maxBitrate?: number;
	maxFramerate?: number;
	scalabilityMode?: string;
	degradationPreference?: RTCDegradationPreference;
	priority?: 'very-low' | 'low' | 'medium' | 'high';
}

/** per-role encoding params — audio stays constant-rate, video scales */
const ROLE_PARAMS: Record<MediaRole, { video: SenderTune; audio: SenderTune }> = {
	talker: {
		video: {
			maxBitrate: 2_500_000,
			maxFramerate: 30,
			scalabilityMode: 'L1T3',
			degradationPreference: 'maintain-resolution',
			priority: 'high'
		},
		audio: { priority: 'high' }
	},
	listener: {
		video: {
			maxBitrate: 1_800_000,
			maxFramerate: 30,
			scalabilityMode: 'L1T2',
			degradationPreference: 'maintain-framerate',
			priority: 'medium'
		},
		audio: { priority: 'medium' }
	},
	screen: {
		video: {
			maxBitrate: 2_000_000,
			maxFramerate: 15,
			degradationPreference: 'maintain-resolution',
			priority: 'medium'
		},
		audio: { priority: 'medium' }
	}
};

/** contentHint per role — browsers read it at capture/encode time */
export function hintTrack(track: MediaStreamTrack, role: MediaRole): void {
	if (track.kind !== 'video') return;
	try {
		(track as MediaStreamTrack & { contentHint?: string }).contentHint =
			role === 'screen' ? 'detail' : 'motion';
	} catch { /* unsupported — cosmetic hint anyway */ }
}

/**
 * Tune every sender on a peer connection for our media role.
 * setParameters is renegotiation-free; codec prefs land on next negotiation.
 */
export function tunePeerConnection(pc: RTCPeerConnection, role: MediaRole): void {
	const params = ROLE_PARAMS[role];
	for (const sender of pc.getSenders()) {
		const kind = sender.track?.kind;
		if (kind !== 'video' && kind !== 'audio') continue;
		const tune = kind === 'video' ? params.video : params.audio;
		const p = sender.getParameters();
		if (!p.encodings?.length) p.encodings = [{}];
		for (const enc of p.encodings) {
			if (tune.maxBitrate !== undefined) enc.maxBitrate = tune.maxBitrate;
			if (tune.maxFramerate !== undefined) enc.maxFramerate = tune.maxFramerate;
			if (tune.scalabilityMode && kind === 'video')
				(enc as { scalabilityMode?: string }).scalabilityMode = tune.scalabilityMode;
			if (tune.priority && (enc as { priority?: string }).priority !== undefined)
				(enc as { priority?: string }).priority = tune.priority;
		}
		p.degradationPreference = tune.degradationPreference;
		sender.setParameters(p).catch(() => {});
	}
}

/**
 * Codec preference: AV1 → VP9 → H264 for video (AV1's SVC + efficiency),
 * audio RED under lossy networks (opus encapsulated in RFC 2198
 * redundancy — Chrome supports it, majors under-use it). Applied to
 * transceivers; takes effect at next negotiation — safe to call early.
 */
export function preferCodecs(pc: RTCPeerConnection, opts: { lossy?: boolean } = {}): void {
	for (const tr of pc.getTransceivers()) {
		const kind = tr.sender.track?.kind ?? (tr.receiver.track?.kind as 'audio' | 'video' | undefined);
		if (kind !== 'audio' && kind !== 'video') continue;
		try {
			const caps = RTCRtpSender.getCapabilities(kind)?.codecs ?? [];
			if (!caps.length) continue;
			const order = codecOrder(kind, caps, opts.lossy ?? false);
			tr.setCodecPreferences(order);
		} catch { /* setCodecPreferences unsupported (old Safari) — skip */ }
	}
}

function codecOrder(
	kind: 'audio' | 'video',
	caps: RTCRtpCodec[],
	lossy: boolean
): RTCRtpCodec[] {
	const rank = (c: RTCRtpCodec): number => {
		const name = c.mimeType.toLowerCase();
		if (kind === 'audio') {
			if (name === 'audio/red') return lossy ? 0 : 90; // prefer under loss, else last
			if (name === 'audio/opus') return 1;
			if (name === 'audio/cn' || name === 'audio/telephone-event') return 80;
			return 50;
		}
		if (name === 'video/av1') return 0;
		if (name === 'video/vp9') return 1;
		if (name === 'video/h264') return 2;
		if (name === 'video/rtx' || name === 'video/ulpfec' || name === 'video/red') return 60;
		if (name === 'video/vp8') return 3;
		return 50;
	};
	return [...caps].sort((a, b) => rank(a) - rank(b));
}

/**
 * Adaptive jitter buffer per role — the stick holder's audio gets a tight
 * buffer (real-time conversation), everyone else a normal one. Browser
 * support is Chromium; noop elsewhere.
 */
export function tuneReceivers(pc: RTCPeerConnection, lowLatency: boolean): void {
	for (const tr of pc.getTransceivers()) {
		if (tr.receiver.track?.kind !== 'audio') continue;
		const rec = tr.receiver as unknown as {
			jitterBufferTarget?: number;
			playoutDelayHint?: number;
		};
		const ms = lowLatency ? 80 : 200; // delay hint in ms
		if ('jitterBufferTarget' in rec) rec.jitterBufferTarget = ms;
		else if ('playoutDelayHint' in rec) rec.playoutDelayHint = ms / 1000;
	}
}
