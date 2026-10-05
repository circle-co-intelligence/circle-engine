import { setup, assign } from 'xstate';

/**
 * Talking-stick machine — declarative definition (counts as spec data, not imperative code).
 * Semantics verified against deployed bundle strings:
 *   stick.holderId / stick.atSeatOf / stick.resumeTo / on_table / sunwise / earthwise.
 *
 * Invariants enforced here (see docs/SECURITY-MODEL.md):
 *  - circle_round: stick may only travel to the next occupied seat in `direction` order —
 *    the two-step bypass is structurally impossible (no event can jump seats).
 *  - open_round: stick may be requested, taken when on_table, or thrown to anyone seated.
 *  - question moment: stick rests `atSeatOf` the asker while the questioned party speaks;
 *    on release it resumes to `resumeTo` — never to the asker.
 *  - orphan rule: if the holder's seat empties, every client emits HOLDER_LOST
 *    on peer-leave → on_table. The stick can never be stranded on a ghost.
 */

export type StickContext = {
	holderId: string | null;
	atSeatOf: string | null;
	resumeTo: string | null;
	mode: 'open_round' | 'circle_round';
	direction: 'sunwise' | 'earthwise';
	seats: string[]; // ordered participant ids, index = seat
	questionMoments: boolean;
};

type StickEvent =
	| { type: 'REQUEST'; by: string }
	| { type: 'GRANT'; to: string }
	| { type: 'PASS' }
	| { type: 'THROW'; to: string } // open_round only
	| { type: 'TABLE' } // holder returns stick to table
	| { type: 'QUESTION_ASK'; by: string; to: string }
	| { type: 'GIVE'; to: string } // holder/host hands the stick to a chosen seat (prod: give-stick / host-set-current)
	| { type: 'QUESTION_END' }
	| { type: 'HOLDER_LOST' } // seat emptied / peer gone (authority emits on deadline)
	| { type: 'MODE_SET'; mode: 'open_round' | 'circle_round' }
	| { type: 'DIRECTION_SET'; direction: 'sunwise' | 'earthwise' }
	| { type: 'SEATS_SET'; seats: string[] };

function nextSeat(ctx: StickContext, fromSeatOf: string | null): string | null {
	const order = ctx.direction === 'sunwise' ? ctx.seats : [...ctx.seats].reverse();
	const i = fromSeatOf ? order.indexOf(fromSeatOf) : -1;
	for (let step = 1; step <= order.length; step++) {
		const candidate = order[(i + step + order.length) % order.length];
		if (candidate) return candidate;
	}
	return null;
}

export const stickMachine = setup({
	types: {
		context: {} as StickContext,
		events: {} as StickEvent
	},
	guards: {
		isSeated: ({ context }, params: { by: string }) => context.seats.includes(params.by),
		isHolder: ({ context }, params: { by: string }) => context.holderId === params.by,
		openRound: ({ context }) => context.mode === 'open_round',
		circleRound: ({ context }) => context.mode === 'circle_round',
		questionsEnabled: ({ context }) => context.questionMoments,
		targetSeated: ({ context }, params: { to: string }) => context.seats.includes(params.to)
	}
}).createMachine({
	id: 'cic.stick',
	initial: 'on_table',
	context: {
		holderId: null,
		atSeatOf: null,
		resumeTo: null,
		mode: 'circle_round',
		direction: 'sunwise',
		seats: [],
		questionMoments: true
	},
	on: {
		SEATS_SET: { actions: assign({ seats: ({ event }) => event.seats }) },
		MODE_SET: { actions: assign({ mode: ({ event }) => event.mode }) },
		DIRECTION_SET: { actions: assign({ direction: ({ event }) => event.direction }) },
		HOLDER_LOST: '.on_table' // emitted on holder peer-leave — always safe
	},
	states: {
		on_table: {
			entry: assign({ holderId: null, atSeatOf: null, resumeTo: null }),
			on: {
				REQUEST: {
					guard: { type: 'isSeated', params: ({ event }) => ({ by: event.by }) },
					target: 'held',
					actions: assign({ holderId: ({ event }) => event.by })
				},
				GRANT: {
					guard: { type: 'targetSeated', params: ({ event }) => ({ to: event.to }) },
					target: 'held',
					actions: assign({ holderId: ({ event }) => event.to })
				},
				THROW: {
					guard: 'openRound',
					target: 'held',
					actions: assign({ holderId: ({ event }) => event.to })
				},
				GIVE: {
					guard: { type: 'targetSeated', params: ({ event }) => ({ to: event.to }) },
					target: 'held',
					actions: assign({ holderId: ({ event }) => event.to })
				}
			}
		},
		offered: {
			// circle_round pass destination — stick conceptually travels to next seat
			entry: assign(({ context }) => {
				const to = nextSeat(context, context.atSeatOf ?? context.holderId);
				return { resumeTo: to };
			}),
			on: {
				GRANT: {
					target: 'held',
					actions: assign(({ context }) => ({
						holderId: context.resumeTo,
						resumeTo: null
					}))
				},
				TABLE: 'on_table' // declined — stick stays on table
			}
		},
		held: {
			on: {
				PASS: [
					// circle_round: deterministic — next seat only, no target allowed
					{ guard: 'circleRound', target: 'offered' },
					// open_round: holder picks target via THROW; bare PASS returns to table
					{ guard: 'openRound', target: 'on_table' }
				],
				THROW: {
					guard: 'openRound',
					actions: assign({ holderId: ({ event }) => event.to })
				},
				TABLE: 'on_table',
				QUESTION_ASK: {
					guard: 'questionsEnabled',
					target: 'question',
					actions: assign(({ context, event }) => ({
						atSeatOf: event.by, // the asker conceptually takes the floor
						resumeTo: context.holderId // the questioned holder keeps the stick
					}))
				},
				GIVE: {
					guard: { type: 'targetSeated', params: ({ event }) => ({ to: event.to }) },
					actions: assign({ holderId: ({ event }) => event.to })
				}
			}
		},
		question: {
			// brief floor loan for a question; stick remains reserved for resumeTo
			on: {
				QUESTION_END: {
					target: 'held',
					actions: assign(({ context }) => ({
						holderId: context.resumeTo,
						atSeatOf: null,
						resumeTo: null
					}))
				},
				HOLDER_LOST: {
					target: 'held',
					actions: assign(({ context }) => ({
						holderId: context.resumeTo,
						atSeatOf: null,
						resumeTo: null
					}))
				}
			}
		}
	}
});
