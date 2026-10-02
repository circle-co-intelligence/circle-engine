# Competitive Assessment + Gap-Closure Plan


Verdict: for its niche — private, facilitated talking-stick circles — this codebase is already best-in-class: nobody else combines protocol-level facilitation, true default-on E2EE through the SFU, and on-device AI. Against mainstream video (Zoom/Meet) it reaches feature parity on core room mechanics but trails on media-quality engineering, scale, mobile, and enterprise surface. The gap plan below closes the highest-leverage deficits.

## Part 1 — Honest competitive scorecard

### What the codebase actually ships (verified in-tree)

- Full facilitation protocol: stick machine (`stick-give/grant/pass/request/table/resume`, `nextId` queue), direction (sunwise/earthwise), turn-timer, circle_round mode, heart mode — the ritual model is encoded *in the protocol*, not bolted on
- Room management: lobby/waiting room, breakouts (open/assign/move/broadcast/close/return), co-hosts, host-locks, passwords, seat claim/release, force-mute (remote unmute impossible by invariant)
- Real SFrame E2EE (RFC 9605): X25519 epoch ratchet, forward secrecy on join/leave, SAS emoji verification, `RTCRtpScriptTransform` native + `createEncodedStreams` fallback — ciphertext through the SFU, verified live
- On-device AI: sherpa-onnx STT captions, wllama Milo participant, translation + TTS; cloud path exists only behind a zero-retention gateway with consent ops
- Recording with protocol-level consent ops → local OPFS; erasure op; transcript + captions; Yjs/TipTap shared notes; reactions; appearance; away/listening states; account-linking
- Resilience: multi-lane signaling (mqtt + ws/DO live; nostr/torrent/ipfs/supabase env-gated) with late-join + dedupe + ICE self-repair — no competitor runs redundant rendezvous protocols
- Edge stack: CF Realtime SFU, TURN broker, Workers AI gateway, VAPID push — all same-origin, secrets server-side

### Cohort A — facilitation tools (circl.es, Butter, SessionLab, BigBlueButton)

| Axis | Verdict |
|---|---|
| Circle/facilitation model | **Surpass** — talking-stick state machine, direction, heart mode, stick queue: nobody else encodes the ritual in-protocol. circl.es is software + human facilitators; its tooling is thinner than this protocol |
| Workshop tooling (polls, agenda, embeds, whiteboard, recaps) | **Trail** — Butter/BBB have them; ours are deferred (Phase 5) |
| Room controls (lobby/breakouts/co-host) | **Parity+** — full set, plus policy-gated ops BBB can't express |
| Transcription/captions | **Surpass on privacy** — on-device by default; they all ship audio to cloud |

### Cohort B — mainstream video (Zoom, Meet, Teams, Whereby)

| Axis | Verdict |
|---|---|
| Core UX (seats, mic/cam, captions, breakouts, lobby, reactions, notes) | **Parity** — the production frontend delivers the standard surface |
| E2EE | **Surpass decisively** — Zoom E2EE is opt-in and *disables* cloud recording/streaming/transcription; Meet CSE is enterprise-only; ours is default-on and loses nothing |
| Accounts/friction | **Surpass** — no account, no install, secret never leaves the URL fragment |
| Media quality under load | **Trail** — no simulcast/SVC, no per-receiver layer selection; `adapt.ts` is a coarse pressure ladder vs a decade of bandwidth-estimation engineering |
| Audio quality | **Trail** — browser AGC/NS only; no Krisp-class denoise, no virtual backgrounds |
| Scale | **Trail** — quadratic SFU egress; no PSTN/dial-in; no webinar mode |
| Mobile | **Trail** — no native apps; Safari insertable-streams support is the weak point |
| Enterprise | **Trail** — no SSO/SCIM/audit exports/admin console |

### Cohort C — privacy video (Element Call, Jitsi, Signal calls, Brave Talk)

| Axis | Verdict |
|---|---|
| E2EE rigor | **Parity/Surpass** — Element Call also does E2EE-over-SFU; we're the only ones adding epoch ratchet + emoji SAS + fragment-kept room secrets + consent-ops |
| Rendezvous resilience | **Surpass** — five redundant signaling lanes vs everyone's single-point relay |
| Facilitation | **Surpass** — none of them have any |
| Self-hosting breadth/maturity | **Trail Jitsi** — battle-tested, mobile apps, SIP |

### Bottom line

**In its niche it's #1 already.** As a *general* Zoom replacement: credible for small circles, not yet for org-wide deployment — media-quality engineering and mobile/enterprise surface are the real deficits.

---

## Part 2 — Gap-closure plan (highest leverage first)

### G1. Media quality: simulcast + finer bandwidth control
- Add `scalabilityMode` (L1T3/L2T3 where codec allows) on video senders in `media/capture.ts`; SFrame encrypts payloads not headers, so CF SFU forwarding still works — **but verify CF Realtime honors simulcast layer-selection first** (spike: publish L3T3, pull, inspect selected layer). If CF can't select layers, degrade gracefully to the adapt ladder — document the outcome.
- Extend `media/adapt.ts` pressure ladder → per-receiver bitrate via SFU-side track hints where possible; keep the setParameters clamp as floor.

### G2. On-device denoise (privacy-preserving Krisp-equivalent)
- RNNoise or DeepFilterNet WASM in the capture path (`media/capture.ts` — already has a worklet seam). Genuinely *surpasses* Zoom's cloud-NC on privacy. Fallback: keep browser `noiseSuppression` when WASM path unsupported.

### G3. Mobile/Safari hardening
- Audit `supportsSFrame()` on Safari/Chrome-Android; ensure the visible "not E2EE" badge fires (invariant: never silently degrade); OPFS fallback for `rec/` journal on browsers lacking it; PWA manifest polish.

### G4. Facilitation tooling (deferred Phase 5, scoped)
- Polls + agenda/timer + post-circle recap via additive `custom` op (protocol already has the `custom` escape hatch). Whiteboard only if demanded — it's the heaviest item. This is what moves the needle vs Butter, *not* vs circl.es.

### G5. Ops/maturity
- Documented browser-support matrix; staged rollout checklist; CF usage alerts (billing notifications API) so the cost model from the previous plan can't surprise.

### Explicit non-goals (right to stay out)
PSTN/dial-in, webinar >100 seats, SSO/SCIM, native mobile apps, cloud recording storage — wrong-fit scope for a privacy-first circles product; re-entry only if users demand.

## Verification

- Simulcast spike first (go/no-go on CF layer selection) — it gates G1's shape
- `pnpm check && pnpm test && pnpm build` + e2e; Safari/WebKit lane of `pnpm test:e2e` for G3
- Audio A/B probe: denoise on/off waveform diff; sfu-path E2EE badge present on all browsers

## Risks

- CF Realtime may not expose layer selection → G1 shrinks to ladder-tuning (still worth it, smaller win)
- RNNoise WASM adds bundle weight + CPU — gate by device class (we already detect it)
