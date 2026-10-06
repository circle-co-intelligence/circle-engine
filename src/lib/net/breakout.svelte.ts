import { openRoom, type RoomHandle } from './room';
import { realtimeMessage } from '../wire/messages';

/**
 * Breakout room — a nested Trystero room on `secret:bo:N`.
 * Media moves to the breakout; membership/ops stay in the parent.
 * breakouts get isolated media paths per spec (separate room = separate peers).
 */

export class BreakoutSession {
	handle: RoomHandle;
	peers = $state<string[]>([]);
	remoteStreams = $state<Record<string, MediaStream>>({});
	chatLog = $state<{ from: string; text: string }[]>([]);

	constructor(secret: string, roomId: string, roomCode?: string) {
		this.handle = openRoom(`${secret}:bo:${roomId}`, { roomCode });
		this.handle.onPeerJoin((id) => (this.peers = [...this.peers, id]));
		this.handle.onPeerLeave((id) => {
			this.peers = this.peers.filter((p) => p !== id);
			delete this.remoteStreams[id];
		});
		this.handle.onPeerStream((stream, id) => (this.remoteStreams[id] = stream));
		this.handle.onRealtime((msg, from) => {
			if (msg.t === 'chat') this.chatLog = [...this.chatLog, { from, text: msg.text }];
		});
	}

	publish(stream: MediaStream) {
		this.handle.addStream(stream);
	}
	sendChat(text: string) {
		this.handle.sendRealtime(realtimeMessage.parse({ t: 'chat', text }));
	}
	leave() {
		return this.handle.leave();
	}
}
