import {
	RoomRatchet,
	FrameCryptor,
	newIdentity,
	supportsSFrame,
	buildPeerIndexMap,
	type PeerIdentity,
	type EpochAnnouncement,
	type EpochParams,
	type SasData,
	type PeerIndex
} from 'sframe-ratchet';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { RoomHandle } from '../net/room';

/**
 * E2EE via SFrame (RFC 9605) with forward secrecy.
 *
 * Key exchange: each peer generates an ephemeral X25519 IdentityKeyPair and
 * publishes its public key in `hello.cap[1]`. The lexicographically smallest
 * peer is the epoch author (same rule as authority election): it mints a fresh
 * random ChainKey per membership change and wraps it per-recipient under an
 * ECDH(ephemeral) — the RoomRatchet "simple" distribution protocol. Ops travel
 * on the data channel; media frames are encrypted end-to-end per sender.
 *
 * Forward secrecy: every join/leave rotates the epoch chain key; departed
 * members cannot decrypt post-departure frames. Room secret in the URL
 * fragment gates *membership*; media keys never derive from it.
 */

function announcementToJson(a: EpochAnnouncement): string {
	return JSON.stringify({
		...a,
		keyWrapped: bytesToHex(a.keyWrapped),
		iv: bytesToHex(a.iv),
		ephemeralPub: bytesToHex(a.ephemeralPub)
	});
}
function announcementFromJson(s: string): EpochAnnouncement {
	const o = JSON.parse(s);
	return { ...o, keyWrapped: hexToBytes(o.keyWrapped), iv: hexToBytes(o.iv), ephemeralPub: hexToBytes(o.ephemeralPub) };
}

export class E2EESession {
	readonly supported = supportsSFrame();
	private ratchet: RoomRatchet;
	// keyed per sender/receiver instance, not per peer — a pc carries several
	// pooled senders+receivers per peer and per-role keys would orphan every
	// cryptor but the last, leaving their transforms attached but forever
	// unkeyed (inbound RTP arrives, decrypt starves, zero frames decoded)
	private cryptors = new Map<string, FrameCryptor>();
	private attachedSenders = new WeakSet<RTCRtpSender>();
	private attachedReceivers = new WeakSet<RTCRtpReceiver>();
	private cryptorSeq = 0;
	private worker?: Worker;
	private members = new Map<string, PeerIdentity>(); // peerId -> identity
	active = false;

	constructor(private room: RoomHandle) {
		this.ratchet = new RoomRatchet({ identity: newIdentity(room.selfId) });
		if (this.supported) {
			this.worker = new Worker(new URL('sframe-ratchet/worker', import.meta.url), { type: 'module' });
		}
	}

	/** our X25519 public key hex — put in hello.cap[1] */
	get publicKeyHex() {
		return bytesToHex(this.ratchet.getIdentity().publicKey);
	}
	get epoch() {
		return this.ratchet.epoch;
	}
	get selfPeerIndex() {
		return this.ratchet.selfPeerIndex;
	}

	/** register a peer's identity (from hello) — does not yet trigger rotation */
	addPeerIdentity(peerId: string, x25519PubHex: string) {
		this.members.set(peerId, { peerId, publicKey: hexToBytes(x25519PubHex) });
	}

	/**
	 * Membership changed. If we are the epoch author (lex-min peer id), mint
	 * announcements and return {peerId -> json} for targeted delivery.
	 * Non-authors simply wait for their announcement.
	 */
	async onMembershipChange(kind: 'join' | 'leave', peerId: string): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		if (!this.supported) return out;
		if (kind === 'leave') this.members.delete(peerId);

		const allIds = [this.room.selfId, ...this.members.keys()].sort();
		const iAmAuthor = allIds[0] === this.room.selfId;
		if (!iAmAuthor) return out;

		// startNewEpoch prepends our own identity — pass OTHER peers only
		const peers = [...this.members.values()];
		let announcements: EpochAnnouncement[] = [];
		if (kind === 'join' && this.ratchet.epoch >= 0 && this.members.has(peerId)) {
			announcements = await this.ratchet.rotateOnMemberChange({ kind: 'join', peer: this.members.get(peerId)! });
		} else if (kind === 'leave') {
			announcements = await this.ratchet.rotateOnMemberChange({ kind: 'leave', peerId });
		} else {
			announcements = await this.ratchet.startNewEpoch(peers);
		}
		for (const a of announcements) out.set(a.forPeer, announcementToJson(a));

		await this.applyEpochToCryptors();
		this.active = true;
		return out;
	}

	/** inbound wrapped epoch announcement (targeted to us) */
	async consumeAnnouncement(json: string) {
		await this.ratchet.consumeEpochAnnouncement(announcementFromJson(json));
		await this.applyEpochToCryptors();
		this.active = true;
	}

	private epochParams(): EpochParams | null {
		const epoch = this.ratchet.epoch;
		const chainKey = this.ratchet.getEpochChainKey(epoch);
		const peerIndexMap = this.ratchet.getEpochPeerIndexMap(epoch);
		if (!chainKey || !peerIndexMap) return null;
		return { epoch, peerIndexMap, chainKey };
	}

	private async applyEpochToCryptors() {
		const params = this.epochParams();
		if (!params) return;
		for (const [key, c] of this.cryptors) {
			// a receiver cryptor for a peer the epoch map doesn't cover yet (no
			// cap[1] e2ee key, or joined after this epoch was authored) can't be
			// keyed — their hello triggers a rotation that includes them
			if (key.startsWith('r:') && !(key.split(':')[1] in params.peerIndexMap)) continue;
			try {
				await c.setEpoch(params);
			} catch { /* stale cryptor — next rotation rekeys it */ }
		}
	}

	private makeCryptor(role: 'sender' | 'receiver', peerId: string): FrameCryptor | null {
		if (!this.supported || !this.worker) return null;
		const myIndex = this.ratchet.selfPeerIndex ?? 0;
		const c = new FrameCryptor({
			worker: this.worker,
			role,
			peerId,
			peerIndex: role === 'sender' ? myIndex : (this.peerIndexOf(peerId) ?? 0),
			onWorkerError: (d) => console.warn('[sframe]', d)
		});
		const params = this.epochParams();
		if (params && (role === 'sender' || peerId in params.peerIndexMap))
			void c.setEpoch(params).catch(() => {});
		return c;
	}

	private peerIndexOf(peerId: string): PeerIndex | undefined {
		const map = this.ratchet.getEpochPeerIndexMap(this.ratchet.epoch) ?? buildPeerIndexMap([this.room.selfId, ...this.members.keys()]);
		return map[peerId];
	}

	attachSender(peerId: string, sender: RTCRtpSender) {
		if (this.attachedSenders.has(sender)) return;
		const c = this.makeCryptor('sender', peerId);
		if (!c) return;
		c.attachSender(sender);
		this.attachedSenders.add(sender);
		this.cryptors.set(`s:${peerId}:${this.cryptorSeq++}`, c);
	}

	attachReceiver(peerId: string, receiver: RTCRtpReceiver) {
		if (this.attachedReceivers.has(receiver)) return;
		const c = this.makeCryptor('receiver', peerId);
		if (!c) return;
		c.attachReceiver(receiver);
		this.attachedReceivers.add(receiver);
		this.cryptors.set(`r:${peerId}:${this.cryptorSeq++}`, c);
	}

	/** SAS emoji for MITM verification — per-peer DH transcript */
	sasFor(peerId: string): SasData | null {
		return this.ratchet.getSas(peerId);
	}
	markSasVerified(peerId: string) {
		this.ratchet.markSasVerified(peerId, true);
	}
	onSasReady(cb: (peerId: string) => void) {
		return this.ratchet.onSasReady(cb);
	}

	dispose() {
		for (const c of this.cryptors.values()) c.detach();
		this.cryptors.clear();
		this.worker?.terminate();
		this.active = false;
	}
}
