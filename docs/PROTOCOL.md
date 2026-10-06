# CIC Protocol — Ground Truth

Message and state vocabulary extracted from the deployed production bundle
(`static/cic`, SvelteKit immutable chunks, 2026-09). These names are
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

The talking-circle flow and rules built on these fields are specified in
`docs/TALKING-CIRCLE.md` (modes, seat order, stick state machine, timers,
floor-vs-mic sovereignty, authority).

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
`/site/*.html` → static copies (privacy/terms/imprint/login).

## Local realtime extensions (mesh-only, invisible to prod wire)

These ride `sendRealtime` on the Trystero mesh — they never leave the room
data channel and prod's deployed protocol is untouched:

- `bw-stats` `{rtt, jitter?, loss?, est?}` — peer → elected `bw-allocator`
  quality report (media/broker.ts).
- `bw-budget` `{max, sid?}` — allocator → peer clamp; applied via
  `sender.setParameters.maxBitrate`, per-track when `sid` present.
- `reaction-kind` `{kind}` — already carries prod reaction kinds; the sensory
  lane also emits `audio:<event>` (laughter/applause/music) from Speechmatics
  audio events.
- `pull-hint` `{rid: 'f'|'h'|'q'|'none'}` — per-receiver layer selection:
  the receiver asks the sender to activate a simulcast rid on just that
  peer's pc (media/simulcast.ts). Witnesses use it for webinar-lite:
  stage video 'f', everyone else 'none', audio untouched. Producers pull
  every seat at 'h'. Single-encoding senders degrade to bitrate/active
  clamps — same semantics.
- `stream-manifest` `{hls}` — authority → room announcement that a
  Cloudflare Stream live input exists; witnesses beyond mesh scale attach
  the HLS manifest via media/hlsPlay.ts (native HLS or lazy hls.js).
- `rec-manifest` `{rec, seg, durationMs, bytes, ts}` — a peer's ISO
  recorder announced a sealed segment (src/lib/rec/iso.ts); assembled
  host-side into the multi-track index (session.recManifests).
- `milo-hear` `{text, lang?}` — a consenting speaker's own on-device ASR
  final, sent **only** to the elected `milo-brain` seat (never broadcast).
  Self-attributed `ear-set{on}` op turns the lane on/off; an explicit
  direct address counts as implicit consent for that one line.
- `milo-mem` `{req?, recall?, items?[{text,by?}], wipe?, forget?}` —
  persistent-memory sync, targeted between `milo-brain` and the authority
  (the room's memory host). Brain distills + sends items; authority stores
  them sealed in a per-room Dexie journal (`cic-milo`,
  XChaCha20-Poly1305/HKDF(roomSecret) — ciphertext at rest, never on a
  server). A new brain sends `req` once per session; the host answers with
  `recall` items which the brain injects into every prompt — so Milo
  thinks across all conversations of the same room link. `wipe` is
  manager-gated, `forget` purges one peer's items (also fired by the
  erasure op locally). Voice commands: "milo remember that …", "milo
  forget me", "milo forget everything" (manager only). `ai-set{memory}`
  gates the whole surface; content inherits the ear-set consent bounds.
- `milo-state` `{state}` — brain-seat broadcast of Milo's state machine
  (standby/listening/speaking); `milo-stop` rests him.
- `ai-set` op fields — `enabled` (master gate), `brain`
  (`auto|local|cloud`: auto = cloud only while the pool funds it),
  `standby`, `instructions`, `name`, `voice`, `storeTranscript`,
  and facilitation flags `roundSummary`/`equityNudge`/`welcome`.
- SMAP `tag` — the wsRoom slot-map frame carries an optional `tag`
  (`'milo'`) so a synthesized media lane lands in its own remote stream;
  old peers ignore the field and hear Milo merged into the seat's audio.

## Paid lanes (all opt-in, all badged)

- `enableEdgeDenoise()` — attaches a CF Realtime Media Transport Adapter to
  cic-dsp; mic audio reaches the edge as PLAINTEXT → `edgeProcessed` badge
  ("edge-processed, not E2EE") is mandatory.
- captions/stt — local ASR is `VITE_CIC_ASR_PACK`-selectable: `whisper` =
  transformers.js `onnx-community/whisper-*` in-browser (**zero-egress,
  ~99 languages, per-utterance auto-LID via the SOT-token first-token
  trick** — transformers.js doesn't implement detect_language itself);
  sherpa packs `en|zh-en|zh-yue-en`. Model files arrive via the
  `/ai/hf/<repo>/resolve/...` allowlist proxy, ONNX runtime via `/ai/ort/`.
  Detected language propagates on `caption-update.lang`,
  `caption-sections.original.lang`, and `tr-segment.originalLang` —
  listeners only pick their *output* language (tr-lang); input detection
  is automatic.
- `enableSensory()` — PCM16 tee → sensory lane. Two transports:
  relay (default) — cic-dsp `/speech` owns provider auth and speaks
  Speechmatics RT (diarization + audio events, `SPEECH_LANG` selects the
  language or `auto` LID), AssemblyAI (`SPEECH_LANG` → `language_code` /
  `language_detection`), or OpenAI Realtime transcription
  (`SPEECH_PROVIDER=openai`, `SPEECH_MODEL` default `gpt-4o-transcribe` —
  ~99 languages auto-detected per segment, code-switching works; note:
  no diarization/audio-events on that lane), incl. on-prem
  Speechmatics via `SPEECH_BASE_URL`;
  direct — `VITE_CIC_SPEECH_URL` points the client at a Speechmatics RT
  endpoint itself (SaaS with a 60 s `?jwt=` temp key minted by
  cic-dsp `/speech-token`, an on-prem appliance, or Speechmatics
  On-Device's local service in a native shell — on-device is a native
  C/C++ library, not a browser API). Events feed Milo's transcriptWindow
  as `[S3] text` / `[room] laughter`.
- `uploadRecording()` — segments sealed client-side (XChaCha20-Poly1305,
  HKDF(roomSecret)) → `PUT /api/rec/{room}/{recId}/{n}` → R2 ciphertext.
- `IsoRecorder` (rec/iso.ts) — each seat records its OWN raw feed into
  rotating WebM segments (VP9/Opus, up to 4K on paid tiers), sealed +
  progressively uploaded during the session; journaled ciphertext survives
  crashes and `resumeUploads()` drains on next join. `clip.ts` trims any
  sealed segment by transcript span (mediabunny Conversion). Composite
  recording stays the convenience output; ISO is the production master.
- `?role=producer` — witness + never recorded + monitors all seats at 'h'.

## Metered spend (prepaid — nothing served that isn't funded)

Paid rooms carry a MeterBus DO per pool: `{balance, spent}` in KV storage,
single-threaded per instance so debits are atomic by construction. **Every
cost-bearing path is pay-before-serve**: MeterBus `/charge` debits the
covering pool BEFORE the provider is invoked and returns 402
`insufficient_credits` at zero; `callId` markers dedupe retries and the
usage heartbeat's reconcile report (same id = never double-billed).
Coverage order is room pool → sponsor wallet → caller's *signed* account
wallet; wallet debits derive the amount from the signed request body, so a
compromised worker can't inflate spend.

Per-lane behavior at exhaustion:

- `/ai/chat|stt|tts` — `/charge` before the upstream call; 402 → the
  client surfaces the credits pill and falls back to the on-device lane
  (auto brain) or refuses (brain:'cloud').
- cic-dsp `/speech` + `/speech-token` — funded check at connect, then the
  relay debits streamed seconds continuously; an empty pool closes the
  socket `4402` → local whisper stays up.
- cic-dsp `/audio` adapter — funded check at upgrade.
- cic-sfu — `sessions/new` requires a funded pool; `tracks/new` re-checks
  (lease) so a session created on a live pool can't stream on a dead one.
- `/api/ice` — TURN credentials only for a funded `?room=`; unfunded gets
  STUN-only + `reason:"topup"` (direct P2P unaffected).
- `/api/rec` PUT — room ticket + per-MiB charge before R2 writes; 402 keeps
  the local sealed recording.
- `/ai/hf`, `/ai/ort`, `/ai/pack` — with `MODELS_BASE` set they 302 to the
  free-egress R2 bucket (`scripts/models-to-r2.sh` provisions it); unset,
  they proxy only for a funded room (room in `?room=` or the first `/hf/`
  path segment, since asset fetchers can't send headers).

The `/ai/usage` heartbeat still reports streaming-lane seconds + `callIds`;
the pool floors at zero and `paid:false` triggers the client's
`onPoolEmpty` — sensory stops, edge lanes drop, the credits pill shows
"top up to continue". `markToppedUp()` re-arms after a grant lands.
Top-ups are Ed25519-signed grants (`{seconds, nonce, sig}` over
`"room.seconds.nonce"`, minted by `scripts/grant.mjs`, verified against
`GRANT_PUBKEY`, nonce-replay-blocked). Whatever payment rail settles money
mints grants — checkout, crypto, invoices, or sequential small top-ups
which ARE the streaming-payment model.

## Edge endpoints

| Path | Handler | Notes |
|---|---|---|
| `POST /ai/chat` `/ai/stt` `/ai/tts` | ai-gateway | ZDR; optional `cf-turnstile` header gate |
| `GET /ai/entitlement?room=` | ai-gateway | `{paid, balanceSeconds, spentSeconds}` |
| `POST /ai/usage` | ai-gateway | `{room, seconds, calls}` → atomic pool debit |
| `POST /ai/topup` | ai-gateway | signed grant → credit pool (nonce-blocked) |
| `GET /ai/status` | ai-gateway | uptime probe surface |
| `POST /ai/telemetry` | ai-gateway | opt-in anonymous → Analytics Engine |
| `GET cic-dsp /speech-token` | dsp worker | 60 s Speechmatics RT temp key mint |
| `wss cic-dsp /audio` | dsp DO | adapter PCM ↔ processed PCM |
| `wss cic-dsp /speech` | dsp worker | PCM → diarized sensory events |
| `PUT/GET /api/rec/...` | Pages fn | R2 ciphertext only |
