import type { RoomHandle } from '../net/room';
import type { E2EESession } from '../crypto/e2ee';
import { deviceClass, videoConstraints } from './adapt';
import { hintTrack } from './tune';

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
	for (const t of stream.getVideoTracks()) hintTrack(t, 'talker');
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
	const attachAll = () => {
		for (const peerId of Object.keys(room.raw.getPeers())) attach(peerId);
	};
	room.onPeerJoin(attach);
	// relay lanes create senders/receivers lazily (per addStream/renegotiation),
	// long after the join-time attach — rescan on every local publish and every
	// adopted remote stream so cryptors cover transceivers that appear late
	room.onPeerStream(attachAll);
	const origAdd = room.addStream.bind(room);
	room.addStream = (stream, targets) => {
		origAdd(stream, targets);
		// addTrack happens synchronously inside lane addStream — defer one tick
		// so senders exist before we scan (transform must precede media flow)
		queueMicrotask(attachAll);
	};
	attachAll();
}
