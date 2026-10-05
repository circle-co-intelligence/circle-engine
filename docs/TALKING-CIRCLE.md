# Talking Circle — Flow & Rules Spec

The circle implements the indigenous talking-circle protocol as a formal
state machine. A **talking piece** ("the stick") grants the floor; a
**seat ring** fixes the order of travel; an **elected authority**
enforces the rules identically on every client. This document is the
product-level spec — the normative machine is
`src/lib/domain/stick.machine.ts` (XState), the enforceable rules are in
`src/lib/policy/cic.rego` (OPA), and the wire names are in
`src/lib/wire/messages.ts`.

The vocabulary intentionally mirrors ceremony language: the stick rests
**on the table** (center of the circle, beneath the fire), travel is
**sunwise** (clockwise) or **earthwise** (anticlockwise), and a question
moment is a *brief floor loan*, never a transfer.

## 1. Circle modes

| Mode | UI label | Rule |
|---|---|---|
| `circle_round` | Earthwise / Sunwise | The stick travels seat-to-seat in `direction` order. `pass` transfers it **directly** to the next occupied seat — there is no event that can jump a seat. A recipient who doesn't wish to speak places it down or passes on. |
| `open_round` | Open Round — "Everyone may speak" | Any seated participant may take the stick from the table; the holder may hand it to a chosen seat (`give`/`throw`) or return it. Free-floor mode. |

Mode and direction are manager-gated (`canManageRoom`) — the circle's
keeper sets the form, not any participant. Wire: `set-mode{mode}` /
`set-direction{direction}` → signed `mode-set` / `direction-set` ops.

## 2. The seat ring

- The machine's canonical ring is `seatedIdsOf()` — **sorted participant
  ids**, updated on every join/leave via `SEATS_SET`. Sorted ids are the
  only ordering every client can derive identically (join timestamps are
  client-subjective), so they are both the enforced travel order and the
  UI's `nextId` indicator.
- `earthwise` traverses the ring reversed; `sunwise` traverses it forward.
- Lobby-held and password-denied peers are never seated — they cannot
  hold the stick, request it, or take authority (`seatedIdsOf` /
  `activePeersOf` exclude them).

## 3. Stick states and legal moves

States: `on_table` → `held` → (`offered` | `question`) → back to `held`
or `on_table`.

| Prod UI action | Wire frame | Signed op | Legal when |
|---|---|---|---|
| Take the stick | `take-stick` / `request-stick` | `stick-request` | stick `on_table`, requester is seated |
| Pass (circle round) | `pass` | `stick-pass` | caller is the holder; destination is **forced** to the next seat in `direction` — applied as `PASS`→`GRANT` atomically, so the transfer is immediate and deterministic on every client |
| Pass (open round) | `pass` | `stick-table` | returns the stick to the table |
| Place the stick down | `place-down` | `stick-table` | caller holds it |
| Hand to a chosen seat | `give-stick{id}` / `host-set-current{id}` | `stick-give{to}` | open round throw, or manager/host placement; target must be seated |
| End a question moment | `question-end` | `stick-resume` | a question is active |

Structural guarantees (these are machine-level, not convention):

- **No seat-skipping in circle round.** `PASS` has no target parameter;
  the destination is computed as the next occupied seat. A two-seat jump
  is impossible to express.
- **Questions resume to the holder, never the asker.** `QUESTION_ASK`
  parks `atSeatOf = asker` and `resumeTo = holder`; `QUESTION_END` (or a
  lost asker) always restores `resumeTo`.
- **Orphan rule.** If the holder's seat empties (leave/kick/crash), every
  client emits `HOLDER_LOST` on peer-leave and the stick returns to the
  table immediately — it can never be stranded on a ghost.
- **`offered` is a transient internal hop.** A `circle_round` pass enters
  it only until the same applied op's `GRANT` resolves the destination;
  it is rendered to the wire as `held` by the destined seat — prod's
  vocabulary (`on_table`/`held`/`question`) has no offered state.
- **`THROW` is rejected in `circle_round`** — the machine literally has
  no transition for it.

## 4. Speaking timer

Two independent controls (the UI's "Off / Only me / Everyone" row):

| Control | Wire | Op | Effect |
|---|---|---|---|
| Turn duration | `turn-timer{minutes}` | `turn-timer-set` (0–120) | Minutes each holder's turn runs. `0` = Off. |
| Timer visibility | `set-speaking-timer{enabled}` | `config-set{speakingTimerEveryone}` | `false` = "Only me" — the holder sees their own countdown; `true` = "Everyone" — all seats see it. |

The timer is **advisory** — expiry never force-passes the stick and never
mutes anyone. Ceremony pacing is a human decision; the software only
makes time visible.

## 5. Floor ≠ microphone

Holding the stick grants the **floor** (who the circle hears); it does
not operate anyone's mic. The mute invariant is absolute:

```
effectiveMuted = selfMuted OR autoMuted OR remotelyMuted
```

- Remote unmute is forbidden by policy — `mute-set{on:false}` is dropped;
  `unmute-remote` is a hard deny.
- A host may force-*close* a mic (`mute-set{on:true}`, manager-only) —
  e.g. a non-holder speaking over the circle — but can never open one.
- `hand-raise`/`hand-lower` are realtime signals only: they advertise
  intent to speak; they never grant or queue the stick.

## 6. Who may command what (policy gate, `cic.rego`)

| Op | Who |
|---|---|
| `stick-request`, `stick-table`, `stick-resume` | any seated participant |
| `stick-pass` | current holder only (`holder only` deny) |
| `mode-set`, `direction-set`, `turn-timer-set`, `config-set` | `canManageRoom` (authority or co-host) |
| `mute-set`, `peer-remove`, `password-set`, `lobby-set`, `breakout-*` | `canManageRoom` |
| `peer-remove` of self | denied — you cannot kick yourself |
| `erasure{scope:'participant'}` | authority only |
| `recording-start` | requires **universal** `recording-consent` |
| `caption-capture` while `heartMode` | denied — Heart-Sharing disables all capture |

All ops are Ed25519-signed and epoch-fenced; denials reject the op on
every client identically.

## 7. Authority (the circle's keeper is a protocol role, not a server)

- Authority = lexicographically smallest seated peer id — deterministic,
  no negotiation, identical on every client.
- Lease: `authority-heartbeat` every 2.5 s; two missed beats → next seat
  takes over and `epoch++`. Stale-epoch ops are rejected — no split-brain.
- `host-set-current{id}` and `'table'` let the keeper place or retrieve
  the stick directly (`stick-give` / `stick-table` ops).

## 8. Adjacent ceremony rules

- **Heart-Sharing mode** (`heart-set{on}`): forces recording and
  transcription off — a privacy-preserving "what is spoken here stays
  here" lane enforced in policy, not UI convention.
- **Talk-time equity**: every client accumulates each holder's wall-clock
  time (`talkMs`) from stick snapshots → the notes doc's *Talk time*
  section — the circle can see whether the floor has been shared fairly.
- **Question moments**: the machine supports a brief floor loan
  (`atSeatOf` the asker, `resumeTo` the holder) and the `question-end`
  frame resumes. No current production frame *opens* a question — that
  transition is reserved in the machine, not yet wired, and is documented
  as such in `PROTOCOL.md` (`question` is a phantom frame).
- **Circle opening/closing**: `started-set{on}` is the host's formal
  open/close marker; `room-end` terminates the session.

## 9. Invariants summary (the promises a circle can rely on)

1. Only the holder may pass the stick; in circle round it may only go to
   the next seat in `direction`.
2. The stick can never be lost — orphans return to the table.
3. A question borrows the floor; it always returns to the holder.
4. Nobody's mic is ever opened remotely; the floor and the microphone
   are separate sovereignties.
5. Mode/direction/timer changes require the keeper role.
6. Timer expiry advises; it never interrupts.
7. Recording requires unanimous consent; Heart-Sharing forbids it.
