import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadPolicy } from '@open-policy-agent/opa-wasm';
import type { Op, RoomState } from '../wire/messages';

/**
 * Policy gate tests — evaluate the real compiled wasm (static/policy/cic.wasm,
 * built from cic.rego by `pnpm policy:build`) so the spec's op matrix in
 * docs/TALKING-CIRCLE.md is asserted, not just claimed.
 */

type Policy = { evaluate(input: unknown, entrypoint?: string): { result: unknown }[] };
let policy: Policy;

const STATE = (over: Partial<RoomState> = {}): RoomState => ({
	epoch: 0,
	config: {
		mode: 'circle_round', direction: 'sunwise', speakingTimerEveryone: false,
		heartMode: false, transcriptScope: 'all', recording: false,
		maxSeats: 12, questionMoments: true
	},
	seats: { '0': 'aaaaaaaa', '1': 'bbbbbbbb', '2': 'cccccccc' },
	occupants: {
		aaaaaaaa: { name: 'A', raisedHand: false, selfMuted: true, autoMuted: false, remotelyMuted: false, joinedAtOp: '', recordingConsent: 'granted' },
		bbbbbbbb: { name: 'B', raisedHand: false, selfMuted: true, autoMuted: false, remotelyMuted: false, joinedAtOp: '', recordingConsent: 'granted' },
		cccccccc: { name: 'C', raisedHand: false, selfMuted: true, autoMuted: false, remotelyMuted: false, joinedAtOp: '', recordingConsent: 'pending' }
	},
	stick: { state: 'held', holderId: 'aaaaaaaa', atSeatOf: null, resumeTo: null, questionActive: false },
	recording: { active: false, startedBy: 'dddddddd', consentRequired: true },
	authorityId: 'aaaaaaaa',
	roles: { miloBrain: null, miloVoice: null, recorderPrimary: null, recorderStandby: null },
	...over
});

const HOLDER = { id: 'aaaaaaaa', canManageRoom: true };
const MEMBER = { id: 'bbbbbbbb', canManageRoom: false };

const deny = (op: Op, actor = MEMBER, state = STATE()) =>
	(policy.evaluate({ op, actor, state }, 'cic/deny')[0]?.result as string[]) ?? [];

beforeAll(async () => {
	const wasm = readFileSync('static/policy/cic.wasm');
	policy = (await loadPolicy(wasm)) as Policy;
});

describe('manager-gated ops (spec §6)', () => {
	const MANAGER_ONLY: Op[] = [
		{ t: 'mode-set', mode: 'open_round' },
		{ t: 'direction-set', direction: 'earthwise' },
		{ t: 'config-set', patch: { speakingTimerEveryone: true } },
		{ t: 'turn-timer-set', minutes: 2 },
		{ t: 'heart-set', on: true },
		{ t: 'lobby-set', enabled: true },
		{ t: 'co-host-set', id: 'bbbbbbbb', on: true },
		{ t: 'started-set', on: true },
		{ t: 'host-locks-set', locks: { captions: true } },
		{ t: 'appearance-set', theme: 'deep' },
		{ t: 'ai-set', enabled: false },
		{ t: 'milo-wake-set', mode: 'click' },
		{ t: 'tr-fanout-set', lanes: ['es'] },
		{ t: 'password-set', hash: 'x' },
		{ t: 'breakout-open', count: 2 },
		{ t: 'breakout-close' },
		{ t: 'mute-set', id: 'bbbbbbbb', kind: 'audio', on: true },
		{ t: 'peer-remove', id: 'bbbbbbbb' },
		{ t: 'stick-grant', to: 'bbbbbbbb' },
		{ t: 'room-end' }
	];
	for (const op of MANAGER_ONLY) {
		it(`denies ${op.t} for non-manager`, () => {
			expect(deny(op)).not.toHaveLength(0);
		});
		it(`allows ${op.t} for manager`, () => {
			expect(deny(op, HOLDER)).toHaveLength(0);
		});
	}
});

describe('stick sovereignty', () => {
	it('denies stick-pass from non-holder', () => {
		expect(deny({ t: 'stick-pass' })).not.toHaveLength(0);
	});
	it('allows stick-pass from holder', () => {
		expect(deny({ t: 'stick-pass' }, HOLDER)).toHaveLength(0);
	});
	it('denies stick-table from non-holder non-manager', () => {
		expect(deny({ t: 'stick-table' }, { id: 'cccccccc', canManageRoom: false })).not.toHaveLength(0);
	});
	it('allows stick-table from holder; from manager', () => {
		expect(deny({ t: 'stick-table' }, HOLDER)).toHaveLength(0);
		expect(deny({ t: 'stick-table' }, { id: 'dddddddd', canManageRoom: true })).toHaveLength(0);
	});
	it('denies stick-give from non-holder non-manager', () => {
		expect(deny({ t: 'stick-give', to: 'cccccccc' }, { id: 'cccccccc', canManageRoom: false })).not.toHaveLength(0);
	});
	it('stick-resume: allowed for holder, asker (atSeatOf), manager — denied otherwise', () => {
		const questionState = STATE({ stick: { state: 'question', holderId: 'aaaaaaaa', atSeatOf: 'bbbbbbbb', resumeTo: 'aaaaaaaa', questionActive: true } });
		expect(deny({ t: 'stick-resume' }, HOLDER, questionState)).toHaveLength(0); // holder
		expect(deny({ t: 'stick-resume' }, MEMBER, questionState)).toHaveLength(0); // asker
		expect(deny({ t: 'stick-resume' }, { id: 'cccccccc', canManageRoom: false }, questionState)).not.toHaveLength(0);
	});
	it('stick-request is open to any participant', () => {
		expect(deny({ t: 'stick-request' })).toHaveLength(0);
	});
});

describe('mute sovereignty', () => {
	it('remote unmute is denied even for a manager', () => {
		expect(deny({ t: 'mute-set', id: 'bbbbbbbb', kind: 'audio', on: false }, HOLDER)).not.toHaveLength(0);
	});
	it('remote mute (force-close) is allowed for a manager', () => {
		expect(deny({ t: 'mute-set', id: 'bbbbbbbb', kind: 'audio', on: true }, HOLDER)).toHaveLength(0);
	});
});

describe('consent + recording', () => {
	it('recording-start is vetoed when any occupant denied', () => {
		const denied = STATE();
		denied.occupants['cccccccc'].recordingConsent = 'denied';
		expect(deny({ t: 'recording-start' }, HOLDER, denied)).not.toHaveLength(0);
	});
	it('recording-start allowed when nobody denied (pending = excluded, not blocking)', () => {
		expect(deny({ t: 'recording-start' }, HOLDER)).toHaveLength(0);
	});
	it('recording-stop allowed for starter or manager only', () => {
		expect(deny({ t: 'recording-stop' }, { id: 'dddddddd', canManageRoom: false })).toHaveLength(0);
		expect(deny({ t: 'recording-stop' }, MEMBER)).not.toHaveLength(0);
		expect(deny({ t: 'recording-stop' }, HOLDER)).toHaveLength(0);
	});
});

describe('admission + erasure', () => {
	it('seat-claim on an occupied seat is denied', () => {
		expect(deny({ t: 'seat-claim', seat: 1 }, MEMBER)).not.toHaveLength(0);
	});
	it('seat-claim on a free seat is allowed', () => {
		expect(deny({ t: 'seat-claim', seat: 5 }, MEMBER)).toHaveLength(0);
	});
	it('peer-remove of self is denied even for manager', () => {
		expect(deny({ t: 'peer-remove', id: 'aaaaaaaa' }, HOLDER)).not.toHaveLength(0);
	});
	it('participant erasure is authority-only; self erasure is free', () => {
		expect(deny({ t: 'erasure', scope: 'participant', target: 'bbbbbbbb' }, MEMBER)).not.toHaveLength(0);
		expect(deny({ t: 'erasure', scope: 'participant', target: 'bbbbbbbb' }, HOLDER)).toHaveLength(0);
		expect(deny({ t: 'erasure', scope: 'self', target: 'bbbbbbbb' }, MEMBER)).toHaveLength(0);
	});
});
