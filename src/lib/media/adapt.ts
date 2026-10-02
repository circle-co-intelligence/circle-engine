/**
 * Adaptive media — keeps circles usable on older phones and weak networks.
 *
 * deviceClass() buckets the device up front (cores/memory/mobile UA);
 * capture() uses it for ideal resolution/framerate floors; adaptSenders()
 * walks every mesh RTCRtpSender and applies maxBitrate + scaleResolutionDownBy
 * via setParameters — the knobs WebRTC exposes without renegotiation.
 *
 * Degradation ladder (applied in order as pressure rises):
 *   1. cap video bitrate/framerate
 *   2. scale resolution down
 *   3. audio-only (video track disabled, not removed — instant recovery)
 */
import type { RoomHandle } from '../net/room';

export type DeviceClass = 'low' | 'mid' | 'high';

let cached: DeviceClass | null = null;
export function deviceClass(): DeviceClass {
	if (cached) return cached;
	const cores = navigator.hardwareConcurrency ?? 4;
	const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
	const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
	cached = cores <= 4 || mem <= 4 || (mobile && (cores <= 6 || mem <= 6)) ? 'low' : mobile ? 'mid' : 'high';
	return cached;
}

/** gUM floors by class — 'ideal' hints so devices can still exceed them */
export function videoConstraints(cls: DeviceClass): MediaTrackConstraints {
	if (cls === 'low') return { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 }, facingMode: 'user' };
	if (cls === 'mid') return { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' };
	return { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };
}

export interface PressureInput {
	peerCount: number;
	/** worst per-peer ICE state across lanes ('failed'|'disconnected'|…) */
	worstConn: string;
	batterySaver: boolean;
}

/** 0 = full quality … 3 = audio-only */
export function pressureLevel({ peerCount, worstConn, batterySaver }: PressureInput): number {
	let level = 0;
	const cls = deviceClass();
	if (peerCount > 8) level = Math.max(level, 2);
	else if (peerCount > 4) level = Math.max(level, 1);
	if (worstConn === 'disconnected' || worstConn === 'failed') level = Math.max(level, 2);
	if (batterySaver || (cls === 'low' && peerCount > 3)) level = Math.max(level, 2);
	if (cls === 'low' && level > 0) level++;
	return Math.min(level, 3);
}

const LEVEL_PARAMS: Record<number, { maxBitrate: number; scaleDownBy?: number; maxFramerate?: number }> = {
	0: { maxBitrate: 1_800_000 },
	1: { maxBitrate: 900_000, maxFramerate: 24 },
	2: { maxBitrate: 350_000, scaleDownBy: 2, maxFramerate: 15 },
	3: { maxBitrate: 120_000, scaleDownBy: 4, maxFramerate: 5 }
};

let appliedLevel = -1;

/**
 * Clamp every video sender across all lane connections. Called when peer
 * count or connectivity changes — setParameters is renegotiation-free, so
 * this is cheap enough to run on every state transition.
 */
export function adaptSenders(room: RoomHandle, level: number): void {
	if (level === appliedLevel) return;
	appliedLevel = level;
	const params = LEVEL_PARAMS[level] ?? LEVEL_PARAMS[0];
	for (const pc of Object.values(room.raw.getPeers())) {
		for (const sender of pc.getSenders()) {
			if (sender.track?.kind !== 'video') continue;
			const p = sender.getParameters();
			if (!p.encodings?.length) p.encodings = [{}];
			for (const enc of p.encodings) {
				enc.maxBitrate = params.maxBitrate;
				if (params.scaleDownBy) enc.scaleResolutionDownBy = params.scaleDownBy;
				else delete enc.scaleResolutionDownBy;
				if (params.maxFramerate) enc.maxFramerate = params.maxFramerate;
				else delete enc.maxFramerate;
			}
			sender.setParameters(p).catch(() => {});
		}
	}
}
