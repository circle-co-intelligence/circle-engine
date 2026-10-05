import { describe, it, expect } from 'vitest';
import { exportAudit, verifyAudit } from './export';
import { createIdentity, canonicalBytes } from '../crypto/identity';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { OpEnvelope } from '../wire/messages';

function signedOp(id: ReturnType<typeof createIdentity>, opId: string): OpEnvelope {
	const base = {
		v: 1 as const, t: 'op' as const, opId, roomEpoch: 0,
		senderId: 'peer-a', sentAt: 0,
		op: { t: 'stick-table' as const }
	};
	return { ...base, sig: id.sign(canonicalBytes(base)) };
}

describe('audit export', () => {
	it('round-trips: exported ops verify against their keys', () => {
		const id = createIdentity('peer-a');
		const ops = [signedOp(id, 'op-1'), signedOp(id, 'op-2')];
		const json = exportAudit(ops, 0);
		const res = verifyAudit(json, { 'peer-a': bytesToHex(id.publicKey) });
		expect(res.ok).toBe(true);
		expect(res.checked).toBe(2);
	});

	it('flags a forged op', () => {
		const id = createIdentity('peer-a');
		const ops = [signedOp(id, 'op-1')];
		const json = exportAudit(ops, 0);
		const res = verifyAudit(json, { 'peer-a': '00'.repeat(32) });
		expect(res.ok).toBe(false);
		expect(res.failures[0].opId).toBe('op-1');
	});
});
