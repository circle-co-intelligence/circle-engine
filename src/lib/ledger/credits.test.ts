import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { quote, confirm, balance, budget } from './credits';

describe('local credits ledger', () => {
	beforeEach(async () => {
		indexedDB.deleteDatabase('cic-ledger');
		await new Promise((r) => setTimeout(r, 20));
	});

	it('reports unlimited local budget with a real purchased balance', async () => {
		const b = await budget('ROOM1');
		expect(b.budget.remainingSeconds).toBeNull();
		expect(b.budget.purchasedSeconds).toBe(0);
		expect(b.canPurchase).toBe(true);
	});

	it('quote then confirm grants seconds to the ledger', async () => {
		const q = await quote('ROOM1', 1);
		expect(q.status).toBe('quoted');
		expect(q.seconds).toBe(1800);
		const r = await confirm('ROOM1', q.quoteId);
		expect(r.status).toBe('purchased');
		expect(await balance('ROOM1')).toBe(1800);
	});

	it('a quote confirms once — replays are stale', async () => {
		const q = await quote('ROOM1', 1);
		await confirm('ROOM1', q.quoteId);
		expect((await confirm('ROOM1', q.quoteId)).status).toBe('stale');
	});

	it('unknown quoteIds are stale, wrong-room quoteIds too', async () => {
		const q = await quote('ROOM1', 1);
		expect((await confirm('ROOM2', q.quoteId)).status).toBe('stale');
		expect((await confirm('ROOM1', 'nope')).status).toBe('stale');
	});
});
