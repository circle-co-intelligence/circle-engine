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
| Pass (circle round) | `pass` | `stick-pass` | caller is the holder (policy-enforced); destination is **forced** to the next seat in `direction` — applied as `PASS`→`GRANT` atomically, so the transfer is immediate and deterministic on every client |
| Pass (open round) | `pass` | `stick-table` | returns the stick to the table |
| Place the stick down | `place-down` | `stick-table` | holder or manager only (policy-enforced) |
| Hand to a chosen seat | `give-stick{id}` / `host-set-current{id}` | `stick-give{to}` | holder or manager (policy-enforced); target must be seated |
| End a question moment | `question-end` | `stick-resume` | holder, asker (`atSeatOf`), or manager (policy-enforced) |

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

- Remote unmute is impossible at the protocol level — `mute-set{on:false}`
  is policy-denied unconditionally, for everyone including the keeper.
- A host may force-*close* a mic (`mute-set{on:true}`, manager-only) —
  e.g. a non-holder speaking over the circle — but can never open one.
- `hand-raise`/`hand-lower` are realtime signals only: they advertise
  intent to speak; they never grant or queue the stick.

## 6. Who may command what (policy gate, `cic.rego`)

Every op is Ed25519-signed and epoch-fenced; denials reject the op on
every client identically. The whole matrix is asserted against the
compiled wasm in `src/lib/policy/cic.policy.test.ts`.

| Op | Who |
|---|---|
| `stick-request` | any seated participant |
| `stick-pass` | current holder only |
| `stick-table`, `stick-give` | holder or manager |
| `stick-resume` | holder, question asker (`atSeatOf`), or manager |
| `stick-grant`, `room-end` | manager only |
| `mode-set`, `direction-set`, `config-set`, `turn-timer-set`, `heart-set`, `lobby-set`, `co-host-set`, `started-set`, `host-locks-set`, `appearance-set`, `ai-set`, `milo-wake-set`, `tr-fanout-set`, `password-set`, `breakout-open`, `breakout-close`, `mute-set`, `peer-remove` | manager only (`canManageRoom` = authority or co-host) |
| `peer-remove` of self | denied — you cannot kick yourself |
| `mute-set{on:false}` | denied **unconditionally** — remote unmute is impossible even for the keeper |
| `seat-claim` on an occupied seat | denied |
| `erasure{scope:'participant'}` | authority only; `scope:'self'` is free |
| `recording-stop` | starter or manager |

### Consent is exclusion, not a vote to start

Recording is **consent-scoped**: once started, the record contains only
participants whose `recordingConsent` is `granted` — the recorder composes
`consentedPeers` only, silence counts as not-granted (fail-closed), and
heart mode forces all capture off at apply time. Policy's part is the
hard veto: a `recording-start` op is denied if *any* occupant explicitly
denied. The realtime `recording-consent` gather runs before the op; the
denial veto runs at apply time, on every client.

## 7. Authority (the circle's keeper is a protocol role, not a server)

- Authority = lexicographically smallest seated peer id, excluding demoted
  keepers — deterministic, no negotiation, identical on every client.
- Lease: the authority emits `authority-heartbeat` every 2.5 s
  (`LEASE_MS/2`). Two missed beats (>10 s, our clock) → the keeper is
  demoted **session-permanently** and the next seat takes over. Peer-leave
  is the fast path; the watchdog catches the frozen-but-connected case.
- Takeover: the new authority calls `oplog.advanceEpoch()` (epoch++),
  broadcasts `op-sync` of the signed log plus an immediate heartbeat.
  Receivers replay via the epoch-tolerant path and converge; a peer that
  still emits stale-epoch ops is healed by a rate-limited `op-sync` reply,
  and a returning keeper that sees the advanced log **self-demotes**
  rather than fork the room.
- Epoch fencing: ops carry `roomEpoch`; anything under the current epoch
  is rejected — the old regime cannot issue ops after takeover.
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
5. Room-form changes (mode/direction/timer/lobby/appearance/end) require
   the keeper role — enforced in policy, asserted by `cic.policy.test.ts`.
6. Timer expiry advises; it never interrupts.
7. The record contains only granting participants — a denial is a policy
   veto, silence is excluded; Heart-Sharing forbids all capture.
