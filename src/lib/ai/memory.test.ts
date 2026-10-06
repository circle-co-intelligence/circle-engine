import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
	addMemories,
	loadMemories,
	forgetPeer,
	wipeRoom,
	memoryBlock,
	parseDistilled
} from './memory';

const SECRET = 'test-room-secret';
const ROOM = 'ROOM1';

describe('milo sealed memory journal', () => {
	beforeEach(async () => {
		indexedDB.deleteDatabase('cic-milo');
		await new Promise((r) => setTimeout(r, 20));
	});

	it('round-trips items sealed per room — cross-conversation recall', async () => {
		await addMemories(ROOM, SECRET, [
			{ text: 'weekly check-in is Tuesdays' },
			{ text: 'Christine prefers early sessions', by: 'peer-b' }
		]);
		const items = await loadMemories(ROOM, SECRET);
		expect(items).toHaveLength(2);
		expect(items[0].text).toBe('weekly check-in is Tuesdays');
		expect(items[1].by).toBe('peer-b');
	});

	it('wrong-room secret cannot open the journal (sealed at rest)', async () => {
		await addMemories(ROOM, SECRET, [{ text: 'secret fact' }]);
		const items = await loadMemories(ROOM, 'a-different-room-secret');
		expect(items).toHaveLength(0);
	});

	it('rooms are isolated journals', async () => {
		await addMemories('ROOM-A', SECRET, [{ text: 'a-fact' }]);
		await addMemories('ROOM-B', SECRET, [{ text: 'b-fact' }]);
		expect((await loadMemories('ROOM-A', SECRET)).map((i) => i.text)).toEqual(['a-fact']);
	});

	it('forgetPeer drops attributed items and name mentions', async () => {
		await addMemories(ROOM, SECRET, [
			{ text: 'direct line from them', by: 'peer-x' },
			{ text: 'Christine runs the budget review' },
			{ text: 'unrelated fact' }
		]);
		const n = await forgetPeer(ROOM, SECRET, 'peer-x', 'Christine');
		expect(n).toBe(2);
		const left = await loadMemories(ROOM, SECRET);
		expect(left).toHaveLength(1);
		expect(left[0].text).toBe('unrelated fact');
	});

	it('wipeRoom clears the whole journal', async () => {
		await addMemories(ROOM, SECRET, [{ text: 'gone' }]);
		expect(await wipeRoom(ROOM)).toBe(1);
		expect(await loadMemories(ROOM, SECRET)).toHaveLength(0);
	});

	it('memoryBlock stays inside the context budget, newest-first', () => {
		const items = Array.from({ length: 40 }, (_, i) => ({ text: `memory item ${i} padding padding padding` }));
		const block = memoryBlock(items, 200);
		expect(block.length).toBeLessThan(280);
		expect(block).toContain('Things you remember');
		expect(block).toContain('memory item 39'); // newest survives
	});
});

describe('parseDistilled', () => {
	it('strips bullets and preamble, drops NONE', () => {
		const reply = 'Here are things to remember:\n- The group meets Tuesdays\n1. Christine owns budget\nNONE';
		expect(parseDistilled(reply)).toEqual(['The group meets Tuesdays', 'Christine owns budget']);
	});
	it('returns [] for a bare NONE', () => {
		expect(parseDistilled('NONE')).toEqual([]);
	});
});
