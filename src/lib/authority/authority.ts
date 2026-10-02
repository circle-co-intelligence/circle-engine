import type { OpEnvelope, RoomState } from '../wire/messages';
import { canonicalBytes, type Identity } from '../crypto/identity';

/**
 * Room authority — runs in a browser peer, elected deterministically.
 *
 * - Authority = lexicographically smallest peerId among seated members
 *   (tie-free, no negotiation needed — same rule the sframe-ratchet uses
 *   for epoch authorship).
 * - Lease: authority publishes `authority-heartbeat` every LEASE_MS/2;
 *   missing two heartbeats -> next-in-order takes over, epoch++.
 * - Epoch fencing: ops carry roomEpoch; anything under a stale epoch is
 *   rejected by every client — split-brain is impossible by construction.
 * - Signed op-log: each op is Ed25519-signed by its sender; clients verify
 *   signature + policy + epoch before applying.
 */

export const LEASE_MS = 5_000;
export const ORPHAN_STICK_MS = 30_000;

export function authorityOf(seatedPeerIds: string[]): string | null {
	const sorted = seatedPeerIds.filter(Boolean).sort();
	return sorted[0] ?? null;
}

/** deterministic takeover order — index into sorted seats after current authority */
export function nextAuthority(seatedPeerIds: string[], deadAuthority: string): string | null {
	return authorityOf(seatedPeerIds.filter((id) => id !== deadAuthority));
}

export class OpLog {
	private log: OpEnvelope[] = [];
	private seen = new Set<string>();
	epoch = 0;

	constructor(
		private identity: Identity,
		private validate: (env: OpEnvelope) => string[] // policy deny reasons; [] = ok
	) {}

	/** verify + append an inbound op. Returns deny reasons or null on success. */
	apply(env: OpEnvelope): string[] | null {
		if (this.seen.has(env.opId)) return ['replay'];
		if (env.roomEpoch !== this.epoch) return [`stale epoch ${env.roomEpoch} (have ${this.epoch})`];

		const { sig, ...unsigned } = env;
		if (!this.identity.verify(env.senderId, canonicalBytes(unsigned), sig)) return ['bad signature'];

		const denies = this.validate(env);
		if (denies.length) return denies;

		this.seen.add(env.opId);
		this.log.push(env);
		return null;
	}

	/** authority bumps epoch on takeover — invalidates the old regime's ops */
	advanceEpoch() {
		this.epoch++;
	}

	/**
	 * Replayed op from a peer's log (late-joiner sync) — same signature +
	 * policy verification, but tolerates the log's historical epochs: the
	 * joiner adopts the replayed epoch instead of fencing against it (it has
	 * no prior state to protect; members fence live ops as usual).
	 */
	applyReplay(env: OpEnvelope): string[] | null {
		if (this.seen.has(env.opId)) return ['replay'];
		if (env.roomEpoch < this.epoch) return [`stale epoch ${env.roomEpoch} (have ${this.epoch})`];
		const { sig, ...unsigned } = env;
		if (!this.identity.verify(env.senderId, canonicalBytes(unsigned), sig)) return ['bad signature'];
		const denies = this.validate(env);
		if (denies.length) return denies;
		this.seen.add(env.opId);
		this.log.push(env);
		this.epoch = env.roomEpoch;
		return null;
	}

	get entries(): readonly OpEnvelope[] {
		return this.log;
	}
}
