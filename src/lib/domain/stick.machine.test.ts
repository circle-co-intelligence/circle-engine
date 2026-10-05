import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { stickMachine, type StickContext } from './stick.machine';

function make(overrides: Partial<StickContext> = {}) {
	const actor = createActor(stickMachine);
	actor.start();
	actor.send({ type: 'SEATS_SET', seats: ['a', 'b', 'c'], ...overrides });
	return actor;
}

describe('stick machine', () => {
	it('open_round: seated requester takes stick from table', () => {
		const a = make();
		a.send({ type: 'MODE_SET', mode: 'open_round' });
		a.send({ type: 'REQUEST', by: 'a' });
		expect(a.getSnapshot().context.holderId).toBe('a');
	});

	it('unseated participant cannot request', () => {
		const a = make();
		a.send({ type: 'MODE_SET', mode: 'open_round' });
		a.send({ type: 'REQUEST', by: 'intruder' });
		expect(a.getSnapshot().context.holderId).toBeNull();
	});

	it('circle_round: PASS moves stick sunwise to next seat — no skipping', () => {
		const a = make(); // circle_round, sunwise, seats [a,b,c]
		a.send({ type: 'REQUEST', by: 'b' }); // b holds
		expect(a.getSnapshot().context.holderId).toBe('b');
		a.send({ type: 'PASS' });
		// offered → next seat after b sunwise is c
		a.send({ type: 'GRANT', to: 'c' });
		expect(a.getSnapshot().context.holderId).toBe('c');
	});

	it('circle_round: earthwise reverses travel order', () => {
		const a = make();
		a.send({ type: 'DIRECTION_SET', direction: 'earthwise' });
		a.send({ type: 'REQUEST', by: 'b' });
		a.send({ type: 'PASS' });
		expect(a.getSnapshot().context.resumeTo).toBe('a'); // b → a earthwise
	});

	it('two-step bypass is structurally impossible: PASS has no target', () => {
		const a = make();
		a.send({ type: 'REQUEST', by: 'a' });
		a.send({ type: 'PASS' });
		// machine offers only to next seat (b); granting to anyone else is
		// still constrained to resumeTo on entry
		expect(a.getSnapshot().context.resumeTo).toBe('b');
	});

	it('question moment resumes to original holder, never the asker', () => {
		const a = make();
		a.send({ type: 'MODE_SET', mode: 'open_round' });
		a.send({ type: 'REQUEST', by: 'a' });
		a.send({ type: 'QUESTION_ASK', by: 'c', to: 'a' });
		expect(a.getSnapshot().context.atSeatOf).toBe('c');
		expect(a.getSnapshot().context.resumeTo).toBe('a');
		a.send({ type: 'QUESTION_END' });
		expect(a.getSnapshot().context.holderId).toBe('a');
		expect(a.getSnapshot().context.atSeatOf).toBeNull();
	});

	it('question moment: holder cannot question themselves, unseated cannot ask', () => {
		const a = make();
		a.send({ type: 'REQUEST', by: 'a' });
		a.send({ type: 'QUESTION_ASK', by: 'a', to: 'a' });
		expect(a.getSnapshot().value).toBe('held'); // self-question rejected
		a.send({ type: 'QUESTION_ASK', by: 'intruder', to: 'a' });
		expect(a.getSnapshot().value).toBe('held'); // unseated asker rejected
	});

	it('question moment: moments disabled blocks QUESTION_ASK', () => {
		const a = make();
		a.send({ type: 'QUESTION_MOMENTS_SET', on: false });
		a.send({ type: 'REQUEST', by: 'a' });
		a.send({ type: 'QUESTION_ASK', by: 'b', to: 'a' });
		expect(a.getSnapshot().value).toBe('held');
	});

	it('HOLDER_LOST returns stick to table (orphan deadline)', () => {
		const a = make();
		a.send({ type: 'REQUEST', by: 'a' });
		a.send({ type: 'HOLDER_LOST' });
		expect(a.getSnapshot().context.holderId).toBeNull();
		expect(a.getSnapshot().value).toBe('on_table');
	});

	it('THROW is rejected in circle_round', () => {
		const a = make();
		a.send({ type: 'REQUEST', by: 'a' });
		a.send({ type: 'THROW', to: 'c' });
		expect(a.getSnapshot().context.holderId).toBe('a'); // unchanged
	});

	it('open_round THROW targets any seated participant', () => {
		const a = make();
		a.send({ type: 'MODE_SET', mode: 'open_round' });
		a.send({ type: 'REQUEST', by: 'a' });
		a.send({ type: 'THROW', to: 'c' });
		expect(a.getSnapshot().context.holderId).toBe('c');
	});
});
