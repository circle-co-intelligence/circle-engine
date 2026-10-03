import { describe, it, expect } from 'vitest';
import {
	JOIN_PROOF_WINDOW_MS,
	activePeersOf,
	authorityListOf,
	seatedIdsOf,
	shouldAnnounceOnReplay,
	shouldDenyHello,
	shouldHoldOnJoin,
	shouldHonorAccessDenied,
	shouldHonorLobbyWait,
	shouldWaitlist,
	type GateView
} from './gates';
import { authorityOf } from '../authority/authority';

function view(over: Partial<GateView> = {}): GateView {
	return {
		lobbyEnabled: false,
		lobbyAnnounced: false,
		waitingSelf: false,
		admitted: false,
		seatedPeers: new Set(),
		deniedPeers: new Set(),
		heldPeers: new Set(),
		memberKeys: new Set(),
		passwordHash: '',
		joinedAfterPassword: false,
		joinAgeMs: JOIN_PROOF_WINDOW_MS + 1, // established by default
		waitingIds: new Set(),
		...over
	};
}

describe('hold-on-join gate', () => {
	it('member session holds a new joiner while lobby is on', () => {
		expect(shouldHoldOnJoin('new', view({ lobbyEnabled: true }))).toBe(true);
	});

	it('a joiner session never holds members', () => {
		// learned lobby via replay → announced; every member's onPeerJoin fires
		// at connect and none may be held (holding shrinks activePeers →
		// divergent authority → replayed ops policy-fail on that view)
		expect(
			shouldHoldOnJoin('member', view({ lobbyEnabled: true, lobbyAnnounced: true }))
		).toBe(false);
		expect(
			shouldHoldOnJoin('member', view({ lobbyEnabled: true, waitingSelf: true }))
		).toBe(false);
	});

	it('a seated peer reconnect is never held', () => {
		expect(
			shouldHoldOnJoin('m', view({ lobbyEnabled: true, seatedPeers: new Set(['m']) }))
		).toBe(false);
	});

	it('lobby off never holds', () => {
		expect(shouldHoldOnJoin('new', view())).toBe(false);
	});
});

describe('hello password gate', () => {
	const pw = 'hash-of-pw';

	it('denies a fresh joiner missing cap[2]', () => {
		expect(
			shouldDenyHello(['idkey-new', 'e2ee'], view({ passwordHash: pw }))
		).toBe(true);
	});

	it('denies a wrong proof', () => {
		expect(
			shouldDenyHello(['idkey-new', 'e2ee', 'wrong'], view({ passwordHash: pw }))
		).toBe(true);
	});

	it('admits a correct proof', () => {
		expect(
			shouldDenyHello(['idkey-new', 'e2ee', pw], view({ passwordHash: pw }))
		).toBe(false);
	});

	it('exempts a known member key lacking cap[2] (joined pre-password)', () => {
		const v = view({ passwordHash: pw, memberKeys: new Set(['idkey-old']) });
		expect(shouldDenyHello(['idkey-old', 'e2ee'], v)).toBe(false);
	});

	it('never gates while our own join is unproven (lobby-held)', () => {
		const v = view({ passwordHash: pw, waitingSelf: true });
		expect(shouldDenyHello(['idkey-new'], v)).toBe(false);
	});

	it('gates immediately once seated — no age window (fail-closed)', () => {
		// a held hash is the converged value regardless of member age; an
		// unverified joiner inside the old 15s window pulled member media
		const v = view({ passwordHash: pw, joinAgeMs: 100 });
		expect(shouldDenyHello(['idkey-new', 'e2ee'], v)).toBe(true);
	});

	it('never gates member hellos while we are a post-password joiner', () => {
		// a joiner who arrived after the password was set must not deny
		// members' cap[2]-less hellos — that poisons deniedPeers into ignoring
		// their legitimate access-denied (deadlocks the password prompt)
		const v = view({ passwordHash: pw, joinedAfterPassword: true });
		expect(shouldDenyHello(['idkey-member', 'e2ee'], v)).toBe(false);
		expect(shouldDenyHello(['idkey-member', 'e2ee', pw], v)).toBe(false);
	});

	it('never denies without a password set', () => {
		expect(shouldDenyHello(['idkey-new'], view())).toBe(false);
	});
});

describe('access-denied honoring', () => {
	it('honors a denial inside the join window', () => {
		expect(shouldHonorAccessDenied('member', view({ joinAgeMs: 100 }))).toBe(true);
	});

	it('ignores a denial once our join is proven', () => {
		expect(shouldHonorAccessDenied('member', view())).toBe(false);
	});

	it('ignores counter-denials from peers we denied or held', () => {
		const v = view({ joinAgeMs: 100, deniedPeers: new Set(['x']), heldPeers: new Set(['y']) });
		expect(shouldHonorAccessDenied('x', v)).toBe(false);
		expect(shouldHonorAccessDenied('y', v)).toBe(false);
	});
});

describe('lobby-join waitlist', () => {
	it('waitlists a fresh announce while lobby is on', () => {
		expect(shouldWaitlist('j', view({ lobbyEnabled: true }))).toBe(true);
	});

	it('never waitlists a seated peer or a duplicate', () => {
		expect(
			shouldWaitlist('m', view({ lobbyEnabled: true, seatedPeers: new Set(['m']) }))
		).toBe(false);
		expect(
			shouldWaitlist('j', view({ lobbyEnabled: true, waitingIds: new Set(['j']) }))
		).toBe(false);
	});

	it('lobby off never waitlists', () => {
		expect(shouldWaitlist('j', view())).toBe(false);
	});
});

describe('lobby announce on replay', () => {
	it('announces only for a replayed enable on a fresh joiner', () => {
		expect(shouldAnnounceOnReplay(true, true, view())).toBe(true);
	});

	it('members applying live never announce', () => {
		expect(shouldAnnounceOnReplay(false, true, view())).toBe(false);
	});

	it('admitted / already-announced sessions are idempotent', () => {
		expect(shouldAnnounceOnReplay(true, true, view({ admitted: true }))).toBe(false);
		expect(shouldAnnounceOnReplay(true, true, view({ lobbyAnnounced: true }))).toBe(false);
	});

	it('disable never announces', () => {
		expect(shouldAnnounceOnReplay(true, false, view())).toBe(false);
	});
});

describe('lobby-wait gate', () => {
	it('a fresh joiner honors a member hold notice', () => {
		expect(shouldHonorLobbyWait(view({ joinAgeMs: 1000 }))).toBe(true);
	});

	it('established members ignore forged waits', () => {
		expect(shouldHonorLobbyWait(view())).toBe(false);
		expect(shouldHonorLobbyWait(view({ joinAgeMs: 1000, admitted: true }))).toBe(false);
	});
});

describe('authority composition', () => {
	it('held and denied peers are excluded from the electorate', () => {
		const active = activePeersOf(['a', 'b', 'c'], new Set(['b']), new Set(['a']));
		expect(active).toEqual(['c']);
		expect(authorityOf(authorityListOf('self', active, false))).toBe('c');
	});

	it('a waiting self does not vote — every session elects the same authority', () => {
		// member view: joiner 'z' is held → electorate {self, z-excluded}
		const memberAuth = authorityOf(
			authorityListOf('m', activePeersOf(['z'], new Set(), new Set(['z'])), false)
		);
		// joiner view: waiting → excludes self; member 'm' is active
		const joinerAuth = authorityOf(
			authorityListOf('z', activePeersOf(['m'], new Set(), new Set()), true)
		);
		expect(memberAuth).toBe('m');
		expect(joinerAuth).toBe('m');
	});

	it('once seated, self rejoins the electorate', () => {
		expect(authorityOf(authorityListOf('a', ['m'], false))).toBe('a');
	});
});

describe('seats composition', () => {
	it('excludes a waiting self until admitted', () => {
		const v = view({ waitingSelf: true });
		expect(seatedIdsOf('me', ['p'], v)).toEqual(['p']);
		expect(seatedIdsOf('me', ['p'], view({ waitingSelf: true, admitted: true }))).toEqual([
			'me',
			'p'
		]);
	});

	it('excludes waiting-listed peers even if connected', () => {
		const v = view({ waitingIds: new Set(['w']) });
		expect(seatedIdsOf('me', ['w', 'p'], v)).toEqual(['me', 'p']);
	});
});
