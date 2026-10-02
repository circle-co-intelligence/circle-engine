/**
 * Pure gate predicates for lobby/password/authority decisions — extracted from
 * RoomSession so the rules are unit-testable without the browser-heavy ctor
 * graph (trystero handle, OPA wasm, mediabunny recorder).
 */

/** hello/hello-proof grace: denials and password checks only apply inside it */
export const JOIN_PROOF_WINDOW_MS = 15_000;

export interface GateView {
	lobbyEnabled: boolean;
	/** we announced ourselves via lobby-join — we're a joiner, not a gatekeeper */
	lobbyAnnounced: boolean;
	waitingSelf: boolean;
	admitted: boolean;
	/** peers that ever appeared in seats (incl. self once seated) */
	seatedPeers: ReadonlySet<string>;
	deniedPeers: ReadonlySet<string>;
	/** locally held ∪ manager-broadcast waiting list */
	heldPeers: ReadonlySet<string>;
	/** hello cap[0] identity keys that already passed the access gate */
	memberKeys: ReadonlySet<string>;
	passwordHash: string; // '' = no password
	joinAgeMs: number;
	waitingIds: ReadonlySet<string>;
}

/**
 * onPeerJoin hold: a member session holds a NEW joiner out of seats when the
 * lobby is on. A session that announced itself (learned lobby via replay) IS a
 * joiner — it sees every member's onPeerJoin at connect and must never hold
 * them (holding a member shrinks activePeers → divergent authority).
 */
export function shouldHoldOnJoin(peerId: string, v: GateView): boolean {
	return (
		v.lobbyEnabled &&
		!v.lobbyAnnounced &&
		!v.waitingSelf &&
		!v.seatedPeers.has(peerId)
	);
}

/**
 * Member-side hello password gate: members verify a JOINER's proof (cap[2]) —
 * the joiner's op-log can't know the hash yet. We only gate once our own join
 * is proven (past the window) AND the peer's identity key is unknown: a seated
 * member's hello legitimately lacks cap[2] (joined pre-password), and denying
 * it poisons our authority/seat view → replayed ops policy-fail on that view.
 */
export function shouldDenyHello(cap: readonly (string | undefined)[], v: GateView): boolean {
	return (
		v.joinAgeMs > JOIN_PROOF_WINDOW_MS &&
		!(cap[0] && v.memberKeys.has(cap[0])) &&
		!!v.passwordHash &&
		cap[2] !== v.passwordHash
	);
}

/**
 * Honor access-denied only while our own join is unproven — a denied or
 * lobby-held joiner's session denies our hellos in return, and that must never
 * evict an established member. Denials from peers we denied/held are
 * counter-denials — ignored.
 */
export function shouldHonorAccessDenied(peerId: string, v: GateView): boolean {
	return (
		!v.deniedPeers.has(peerId) &&
		!v.heldPeers.has(peerId) &&
		v.joinAgeMs < JOIN_PROOF_WINDOW_MS
	);
}

/**
 * lobby-wait = a member telling us we're held out of seats. Honor only inside
 * the join window — a forged wait must never unseat an established member.
 */
export function shouldHonorLobbyWait(v: GateView): boolean {
	return !v.admitted && v.joinAgeMs < JOIN_PROOF_WINDOW_MS;
}

/**
 * lobby-join announce → waiting list: converges heldPeers across members even
 * when our onPeerJoin ran before lobby-set applied (op-sync ordering).
 * Already-seated peers never announce — only replayed lobby-set triggers it.
 */
export function shouldWaitlist(peerId: string, v: GateView): boolean {
	return (
		v.lobbyEnabled &&
		!v.seatedPeers.has(peerId) &&
		!v.waitingIds.has(peerId)
	);
}

/**
 * Only a late joiner learning lobby via op-sync REPLAY announces lobby-join —
 * members applying it live are already seated and must not waitlist themselves.
 */
export function shouldAnnounceOnReplay(replay: boolean, enabled: boolean, v: GateView): boolean {
	return enabled && replay && !v.admitted && !v.lobbyAnnounced;
}

/** peers actually visible to us — denied (bad/missing password) and held never seat */
export function activePeersOf(
	peers: readonly string[],
	deniedPeers: ReadonlySet<string>,
	heldPeers: ReadonlySet<string>
): string[] {
	return peers.filter((p) => !deniedPeers.has(p) && !heldPeers.has(p));
}

/**
 * Authority electorate = self (unless we're lobby-waiting) + active peers.
 * Held/denied peers can't take authority over the room; excluding a waiting
 * self keeps every session's authority identical.
 */
export function authorityListOf(
	selfId: string,
	activePeers: readonly string[],
	waitingSelf: boolean
): string[] {
	return [...(waitingSelf ? [] : [selfId]), ...activePeers];
}

/** Stick seats: as authorityList but a waiting self that was ADMITTED reseats */
export function seatedIdsOf(
	selfId: string,
	peers: readonly string[],
	v: GateView
): string[] {
	return [
		...(v.waitingSelf && !v.admitted ? [] : [selfId]),
		...activePeersOf(peers, v.deniedPeers, v.heldPeers).filter(
			(p) => !v.waitingIds.has(p)
		)
	].sort();
}
