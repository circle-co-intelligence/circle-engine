import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
	readSyncMessage,
	writeSyncStep1,
	writeUpdate,
	messageYjsSyncStep1
} from 'y-protocols/sync';
import type { RoomHandle } from '../net/room';

/**
 * Collaborative notes — Yjs document synced over the room's data channel.
 * No server, no awareness provider: peers exchange the standard
 * y-protocols sync messages (SyncStep1 on join → SyncStep2 diff → Update
 * broadcast) multiplexed on the 'yjs-sync' action.
 */

export class NotesDoc {
	doc = new Y.Doc();
	get text() {
		return this.doc.getXmlFragment('notes');
	}
	onRemoteUpdate: (() => void) | null = null;

	constructor(room: RoomHandle) {
		const [send, onMsg] = room.makeAction<Uint8Array>('yjs-sync');
		const emit = (enc: encoding.Encoder, peerId?: string) =>
			encoding.length(enc) > 0 ? send(encoding.toUint8Array(enc), peerId ?? null) : undefined;

		this.doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (origin === 'remote') return;
			const enc = encoding.createEncoder();
			writeUpdate(enc, update);
			void emit(enc);
		});

		onMsg((data: Uint8Array, peerId: string) => {
			const enc = encoding.createEncoder();
			const type = readSyncMessage(decoding.createDecoder(data), enc, this.doc, 'remote');
			void emit(enc, peerId);
			if (type !== messageYjsSyncStep1) this.onRemoteUpdate?.();
		});

		room.onPeerJoin((peerId) => {
			const enc = encoding.createEncoder();
			writeSyncStep1(enc, this.doc);
			void emit(enc, peerId);
		});
	}

	destroy() {
		this.doc.destroy();
	}
}
