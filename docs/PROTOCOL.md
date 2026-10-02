# CIC Protocol — Ground Truth

Message and state vocabulary extracted from the deployed production bundle
(`site-mirrors/cic-app`, SvelteKit immutable chunks, 2026-09). These names are
the wire contract our implementation must remain compatible with.

## Confirmed message types (verbatim strings in production JS)

| Category | Observed names |
|---|---|
| Presence | `hello`, `welcome`, `join`, `join-room`, `leave`, `admit`, `admitted`, `lobby`, `participant` |

> Internal mesh realtime (peer↔peer over Trystero datachannels, never the prod
> room socket): `hello` carries `cap[]` (idkey, e2ee key, access proof) plus an
> optional `sfu` field — the peer's cloud-SFU publication when it publishes via
> `VITE_CIC_SFU_ENDPOINT`. Either a bare session-id string or
> `{session, tracks[]}` carrying the real published trackNames; subscribers bind
> remote pulls to those names. Older clients ignore it (zod-optional).
| Stick/round | `round`, `stick`, `open-throw`, `question`, `hand-*` (implied), `seat` fields |
| Chat/notes | `chat`, `note`, `notes`, `notes-state`, `notes-save`, `reaction`, `whisper` |
| Captions | `captions`, `caption-ticket`, `caption-subscribe`, `caption-state`, `caption-source`, `caption-source-ready`, `caption-source-failed`, `caption-update`, `caption-clear`, `caption-capture`, `caption-capability`, `caption-audio`, `caption-audio-stop` |
| Transcript | `transcript`, `transcription`, `transcript-line-flash`, `transcript-translated`, `participant-translation` |
| Recording | `recording`, `recording-state`, `recording-consent`, `recording-ready`, `recordings`, `recorder`, `rec-upload`, `rec-upload-begin`, `rec-uploaded`, `rec-server`, `opfs`, `recording-budget`, `recording-purchase`, `recording-choice-title` |
| Breakouts | `breakouts`, `breakout-open`, `breakout-assign`, `breakout-hop`, `breakout-move`, `breakout-close`, `breakout-return`, `breakout-broadcast` |
| Milo | `milo`, `milo-wake` |
| Room | `room-defaults`, `room-controls-panel`, `snapshot`, `delta`, `mute`, `unmute`, `mute-state`, `muted`, `grant`, `sfu` |
| WebRTC internals | `offer`, `answer`, `candidate-pair` |
| Provider backends | `openai`, `deepgram`, `gemini` (CSP-confirmed) |

## Confirmed state fields

`stick.holderId`, `stick.atSeatOf`, `stick.resumeTo`, `on_table`,
`circle_round`, `open_round`, `sunwise`, `earthwise`, `heartMode`,
`speakingTimerEveryone`, `canManageRoom`.

## Design tokens (deployed CSS, `0.B0NZKGKX.css`)

Fonts: Lato (sans), EB Garamond (serif), self-hosted woff2.
Themes: mist `#f3f6f6`, deep `#181d23`, sand `#f7f1e6`.
Accent `#1abc9c`, fire `#d9823f`, radius 18px.
Full set: `design/tokens.json` (DTCG format).

## Production CSP (worth preserving)

`default-src 'self'`; `worker-src 'self' blob:`; `media-src 'self' blob: mediastream:`;
`object-src 'none'`; `script-src 'self' 'wasm-unsafe-eval'`.

## Deviations from production (intentional)

- Production uses server-side caption tickets + provider STT (Deepgram/OpenAI/Gemini in CSP).
  Ours: sherpa-onnx in-browser, zero provider calls.
- Production `rec-upload`/`rec-server` implies server recording path.
  Ours: `recorder-primary`/`recorder-standby` peer roles + OPFS journal, local export.
- Production ships a Cloudflare Insights beacon despite its own no-analytics comment.
  Ours: none.

## Confirmed wire semantics (verified against the live bundle, 2026-09)

- `delta` seq must be strictly consecutive (`seq === last+1`) or production drops
  the delta and calls `resync()` (re-sends `hello` on the same socket). `snapshot`
  seq applies directly. `hello` re-delivery must be idempotent — reuse the live
  session, never spawn a second one.
- `caption-capability` **replaces** `features.captions` wholesale — always emit the
  complete object (`provider`, `available`, `epoch`, `translationAudioEnabled`) or
  `available`/`epoch` are wiped and the caption pipeline silently disables itself.
- `caption-source{on}` is server→client and unconditional when `allowed`
  (`live && features.captions.available && ai.transcription`); subscriber-side
  enable UI is dormant in the deployed bundle — the backend designates sources.
- `recording-budget` reply must carry `{requestId, budget:<object>, canPurchase}` —
  a `{ok}` ack leaves the UI disabled.
- `recording-state.sessions[]` must include `recorderId`, `recorderName`,
  `consentedIds`, `toServer`; the consent dialog keys off it. Starter resolves on
  `recording-ready{requestId}` only after universal `recording-consent`.
- `breakouts.names` must always be an array — the bundle indexes it unguarded.
- Breakout state travels via fresh `snapshot` frames (`breakouts.roster`,
  per-participant `channel`) plus `breakout-move{channel}` to the moved client.
  Channel moves make the client reconnect the room socket (media restart) — the
  session must be adoptable across socket reconnects (grace window on close).
- Host breakout controls live in Room controls → "Breakout rooms" section:
  `breakout-broadcast{message}` ("Message all rooms…") and `breakout-close`
  ("Bring everyone back"). The `!isHost` co-host details carries the parallel
  "Close breakouts and return everyone" variant.
- `refresh-ice` must be answered with a real future `iceExpiresAt` — `0` leaves
  the client's ICE-refresh timer permanently overdue.

## Full coverage pass (2026-10) — remaining frames implemented

All 68 production outbound frames are now terminated by the local engine.
Additions since the first pass:

**Inbound (client→bridge) now handled:**
- `take-stick` — prod's on-table "Take the stick" button → `stick-request` op.
- `stop-ai` — anyone may rest Milo; broadcasts `milo-stop` realtime, emits
  `ai-stopped{by,eventId}` delta, interrupts in-flight generation + TTS.
- `remove{id}` — dual-purpose frame: if `id` is in `waiting` it's the lobby
  "Decline" (targeted `lobby-decline` realtime → their socket gets
  `circle_closed{reason:'declined'}`); otherwise a host kick (signed
  `peer-remove` op → the target's session self-ejects → `removed` +
  `circle_closed{reason:'removed'}`).
- `admit` — emits the `admit{id}` delta op plus a **targeted** `admitted`
  frame to the joiner's socket (prod sets `store.closed=null` on it).
- `mute{target,kind}` — host force-mute; signed `mute-set` op (policy: manager
  only, `on:false` is dropped — remote unmute is forbidden) + targeted
  `force-muted{kind}` to the victim's socket.
- `set-password{password}` — manager-only `password-set{hash}` op storing
  `sha256(code+':'+pw)`. Enforcement is mesh-side: the joiner's `hello.cap[2]`
  carries the same hash; any member whose op-log has the hash verifies it and
  sends `access-denied` to failures → joiner's socket gets
  `error{code:'password_required'}` + close (prod re-prompts + re-hellos).
- `set-store-transcript{on}` — `ai-set.storeTranscript` op; when on, final
  captions persist to `localStorage['cic.transcript.{code}']` (exit view).
- `translation-active{on}`, `participant-translation{lang,langs,mintSecret}`
  — langs propagate via `tr-lang` realtime; authority composes the union into
  the `tr-fanout{lanes}` op. `mintSecret` → `translation-secret{secret,
  expiresAt,lang,model:'local-sherpa'}`.
- `translate-transcript{lang}` — wllama/SmolLM2 local translation →
  `transcript-translated{lang,text}` (prod stores it as `transcript-{lang}`).
- `speech-open{engine:'translation',language}` — translation pipe: sherpa ASR
  → per finalized segment, wllama-translate into every registered listener
  lang → `tr-caption{lang,which,delta}` + sherpa-TTS `caption-audio{sourceId,
  generation,sequence,pcm,cue}` (base64 Int16 LE @24kHz) fanned out to each
  listening peer's socket via the bridge registry; close →
  `caption-audio-stop{sourceId}`.
- `account-link-start{requestId}` → `account-link-challenge{requestId,
  challengeId,pollSecret,loginUrl:'/account/link?ch=…',expiresAt}`; the link
  page resolves the challenge in localStorage; `account-link-poll
  {challengeId,pollSecret}` (prod polls 2s) → `account-linked{accountId}`.
  The accountId is a device-local identity (localStorage `cic.account`).
- `recording-purchase{action:'quote'|'confirm'}` → `{requestId,result}` from
  the Dexie credits ledger (`src/lib/ledger/credits.ts`); confirm grants
  seconds and emits the `credits{remaining,reference,lowWarned,
  sttMinutesLeft,sttLowWarned}` delta op. Local recording stays Unlimited —
  purchased seconds are tracked honestly, not pretended to be required.
- `recording-budget` — real ledger numbers (`purchasedSeconds` from Dexie).
- `rec-uploaded{key,bytes}` — registers the artifact; `recordings{items}`
  frame lists local `/rec-local/*` artifacts.
- `caption-source-failed{generation}` — re-arms source designation (fresh
  generation → client re-opens the caption socket).

**Outbound ops/frames now emitted:** `admitted`, `removed`, `force-muted`,
`admit`, `tracks`, `speaking`, `ai-stopped`, `credits`, `tr-caption`,
`translation-secret`, `transcript-translated`, `caption-audio`,
`caption-audio-stop`, `caption-clear`, `recording-purchase`, `recordings`,
`account-link-challenge`, `account-linked`, `circle_closed`,
`error{code:'password_required'}`.

`connected` delta op is intentionally not emitted: mesh join/leave is atomic
(socket grace keeps participants live across reconnects), so no producer
exists — emitting it would be fabricating state.

**Phantom frames ruled out** (never sent by the deployed bundle):
`whisper`, `question`, `open-throw`, `admit-all`, `decline`, `end-circle`,
`leave-room`, `screen-stop`, `heartbeat`, `notes-load`, `todo`.

## Targeted sends

`bridgesByPeer: Map<code, Map<meshPeerId, RoomBridge>>` — remote participants
are addressed by mesh peerId (prod IDs are only declared for self). Registry
entries drop on socket close.

## Routes

`/` → vendored marketing site (`static/site/`); `/join` → local entry gate
(reads prod's `?code`/`?name`, seeds `cic.name`); `/room/{code}` +
`[...rest]` → prod bundle mount; `/account/link` → link-challenge resolver;
`/site/*.html` → static mirrors (privacy/terms/imprint/login).
