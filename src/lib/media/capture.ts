import type { RoomHandle } from '../net/room';
import type { E2EESession } from '../crypto/e2ee';
import { deviceClass, videoConstraints } from './adapt';

/**
 * Media capture + publish — getUserMedia, stream publish over trystero,
 * SFrame cryptor attach on every RTCRtpSender/Receiver (E2EE default).
 */

export interface LocalMedia {
	stream: MediaStream;
	setMuted(muted: boolean): void;
	stop(): void;
}

export async function capture(opts: { video?: boolean; audio?: boolean } = { video: true, audio: true }): Promise<LocalMedia> {
	const stream = await navigator.mediaDevices.getUserMedia({
		video: opts.video ? videoConstraints(deviceClass()) : false,
		audio: opts.audio
			? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			: false
	});
	return {
		stream,
		setMuted(muted) {
			for (const t of stream.getAudioTracks()) t.enabled = !muted;
		},
		stop() {
			for (const t of stream.getTracks()) t.stop();
		}
	};
}

/** attach E2EE cryptors to all senders/receivers on trystero's peer connections */
export function wireE2EE(room: RoomHandle, e2ee: E2EESession) {
	if (!e2ee.supported) return;
	const attach = (peerId: string) => {
		const pc = room.raw.getPeers()[peerId];
		if (!pc) return;
		for (const s of pc.getSenders()) e2ee.attachSender(peerId, s);
		for (const r of pc.getReceivers()) e2ee.attachReceiver(peerId, r);
	};
	room.onPeerJoin(attach);
	for (const peerId of Object.keys(room.raw.getPeers())) attach(peerId);
}
