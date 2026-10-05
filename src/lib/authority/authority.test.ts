import { describe, it, expect } from 'vitest';
import { OpLog, authorityOf, nextAuthority } from './authority';
import { createIdentity, canonicalBytes } from '../crypto/identity';
import type { OpEnvelope } from '../wire/messages';

function signedOp(id: ReturnType<typeof createIdentity>, epoch = 0, opId = crypto.randomUUID()): OpEnvelope {
	const base = {
		v: 1 as const, t: 'op' as const, opId, roomEpoch: epoch,
		senderId: id.peerId || 'peer-a', sentAt: 0,
		op: { t: 'stick-table' as const }
	};
	const sig = id.sign(canonicalBytes(base));
	return { ...base, sig };
}

describe('authority election', () => {
	it('lexicographically smallest seated peer is authority', () => {
		expect(authorityOf(['c', 'a', 'b'])).toBe('a');
		expect(authorityOf([])).toBeNull();
	});

	it('takeover skips the dead authority', () => {
		expect(nextAuthority(['a', 'b', 'c'], 'a')).toBe('b');
		expect(nextAuthority(['c'], 'a')).toBe('c');
	});
});

describe('op-log', () => {
	it('accepts a validly signed op', () => {
		const id = createIdentity('peer-a');
		const log = new OpLog(id, () => []);
		expect(log.apply(signedOp(id))).toBeNull();
		expect(log.entries).toHaveLength(1);
	});

	it('rejects replayed opIds', () => {
		const id = createIdentity('peer-a');
		const log = new OpLog(id, () => []);
		const env = signedOp(id);
		log.apply(env);
		expect(log.apply(env)).toEqual(['replay']);
	});

	it('rejects stale-epoch ops (fencing)', () => {
		const id = createIdentity('peer-a');
		const log = new OpLog(id, () => []);
		log.advanceEpoch();
		expect(log.apply(signedOp(id, 0))![0]).toMatch(/stale epoch/);
	});

	it('rejects bad signatures', () => {
		const a = createIdentity('peer-a');
		const b = createIdentity('peer-b');
		const log = new OpLog(a, () => []);
		const env = signedOp(a);
		env.senderId = 'peer-b'; // forged sender — b's key won't verify a's sig
		void b;
		expect(log.apply(env)).toEqual(['bad signature']);
	});

	it('rejects policy-denied ops', () => {
		const id = createIdentity('peer-a');
		const log = new OpLog(id, () => ['not room authority']);
		expect(log.apply(signedOp(id))).toEqual(['not room authority']);
	});
});
