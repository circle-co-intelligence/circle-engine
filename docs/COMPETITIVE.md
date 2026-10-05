# Competitive Assessment + Gap-Closure Plan

Verdict: for its niche — private, facilitated talking-stick circles — this
codebase is best-in-class and now presses the production-recording market
(Riverside) directly. Nobody else combines protocol-level facilitation,
default-on E2EE, on-device AI, and client-sealed ISO recording. Mainstream
parity is close; the remaining gates are Cloudflare account configuration,
not code.

## Part 1 — Honest competitive scorecard (current tree)

### What the codebase ships (verified in-tree)

- Full facilitation protocol: stick machine, direction, heart mode, queue,
  turn-timer — the ritual is encoded *in the protocol*
- Room management: lobby/waiting, breakouts, co-hosts, host-locks,
  passwords, seat claim/release, force-mute (remote unmute impossible)
- Workshop tooling: `/poll` `/agenda` `/talktime` `/recap` → synced notes
  doc; E2EE-synced Excalidraw whiteboard island
- SFrame E2EE default-on: epoch ratchet, forward secrecy, SAS emoji
- On-device AI default: sherpa-onnx STT, wllama Milo, translation + TTS
- Sensory lane: Speechmatics RT (relay/direct/on-prem) → diarized captions,
  audio events → reactions + Milo context + clip markers
- Metered paid pools: MeterBus DO, Ed25519 grants, replay-blocked,
  exhausts live to free tier — verified end-to-end on deployed workers
- Media coordination beyond GCC: elected bw-allocator, fair-share budgets,
  RTT-gradient pre-emption, ICE path reselection, per-peer pull clamps
- **Mesh simulcast**: `sendEncodings` rid ladder per peer-pc + `pull-hint`
  per-receiver layer selection — no SFU needed; SFU layer-selection via CF
  Realtime is the cred-gated variant (spike in plan)
- Recording: composite (canvas mix → OPFS journal) AND per-participant
  **sealed ISO** — raw own-feed, progressive encrypted upload, journaled
  resume, transcript→clip extraction, producer role, retention purge
- Webinar-lite: witness seats pull audio + stage video only; `pull-hint`
  `none`/`f` gives ~1 video leg per audience member regardless of seats
- SIP/PSTN dial-in seam; multi-lane signaling (mqtt live + nostr/torrent/
  ipfs/supabase/ws env-gated); edge stack: SFU proxy, TURN broker, AI
  gateway, push, sensory/DSP worker, pack proxy
- Enterprise console: `/admin/overview` + `/admin/mint` behind a verified
  Cloudflare Access JWT (RS256 against team JWKS, zero-dep) — pseudonymous
  room-code + seconds view, no content exposure
- Self-host bundle: `deploy/` compose (caddy + mosquitto + coturn) —
  complete zero-Cloudflare stack, one `./selfhost.sh`

### Cohort R — Riverside.fm (primary: where our clients are)

| Axis | Verdict |
|---|---|
| ISO recording (raw feed per participant) | **Surpass on privacy** — we record each client's own localMedia (source-quality, network can't degrade it), seal XChaCha20 before upload; Riverside's cloud sees plaintext and has had incidents |
| Progressive upload | **Parity+** — sealed segments upload during the session, journaled for crash/offline resume |
| Transcript-based clips | **Parity-lite** — span→trim via mediabunny; theirs is a full NLE editor |
| Show notes / recap | **Parity** — /recap + diarized sensory context |
| Call-in guests | **Parity** — SIP leg ships |
| Producer mode | **Parity** — `?role=producer`: unrecorded, monitors all seats |
| AI moments | **Surpass** — laughter/applause events → clip markers; no equivalent on their side |
| E2EE | **Surpass decisively** — theirs is plaintext-to-cloud, always |
| Live social streaming | **Trail** — code-ready (`stream-manifest` + hls.js witness path); flips on CF Stream creds |
| Mobile apps | **Parity-** — Tauri shell shipped (desktop); stores/notarization + mobile ports remain |

### Cohort A — facilitation tools (circl.es, Butter, SessionLab, BBB)

| Axis | Verdict |
|---|---|
| Circle/facilitation model | **Surpass** — ritual in-protocol; circl.es needs human facilitators |
| Workshop tooling | **Parity/Surpass** — polls/agenda/recap/talk-time + E2EE whiteboard (nobody else can E2EE a whiteboard) |
| Room controls | **Parity+** — plus policy-gated ops |
| Transcription | **Surpass** — on-device default + diarized sensory lane |

### Cohort B — mainstream video (Zoom, Meet, Teams, Whereby)

| Axis | Verdict |
|---|---|
| Core UX | **Parity** — production frontend delivers the standard surface |
| E2EE | **Surpass decisively** — Zoom E2EE disables cloud recording/transcription; ours loses nothing |
| Accounts/friction | **Surpass** — no account, secret stays in the URL fragment |
| Media under load | **Parity- → Parity** — mesh simulcast + pull-hints + beyond-GCC broker shipped; CF SFU layer-selection pending creds (mesh path needs no creds) |
| Audio quality | **Parity+** — on-device denoise/vbg/spatial/loudness + opt-in edge lane |
| Scale | **Parity-** — webinar-lite mesh mode ships; >100 webinar + PSTN coded, cred-gated (CF Stream) |
| Mobile | **Parity-** — Tauri desktop shell shipped; mobile ports remain |
| Enterprise | **Parity-** — Access-gated console + metered pools live; SSO/SCIM provisioning deferred |

### Cohort C — privacy video (Element Call, Jitsi, Signal, Brave Talk)

| Axis | Verdict |
|---|---|
| E2EE rigor | **Parity/Surpass** — epoch ratchet + SAS + fragment-kept secrets + consent ops |
| Rendezvous resilience | **Surpass** — redundant signaling lanes vs single-point relay |
| Facilitation | **Surpass** — none have any |
| Self-hosting | **Parity-** — compose bundle ships (caddy/mosquitto/coturn); Jitsi's decade of ops maturity is the remaining delta |

### Bottom line

**#1 in the niche, and the Riverside moat (local-first ISO + progressive
upload) is now matched with an E2EE advantage it can't copy.** Remaining
gaps are cred-gated deploys (CF Realtime/Stream/R2) and store/mobile
distribution of the shipped Tauri shell — documented in the megaplan,
not missing features.

## Part 2 — what remains (all code-ready or cred-gated)

- **CF Realtime creds** → SFU media offload + edge denoise live + the
  simulcast layer-selection spike (mesh simulcast already ships without it)
- **R2 enable** → sealed rec offload live (code path verified; dashboard
  opt-in only)
- **CF Stream** → `stream-manifest` + hls.js witness path flips on → true
  webinar scale + social restream
- **Pages token scope** → same-origin `/api/*` (cic-sfu worker bypasses)
- **Tauri shell** → native app + Speechmatics On-Device seam
  (`VITE_CIC_SPEECH_URL` already speaks the RT protocol)
- **SCIM/IdP provisioning** — Access covers SSO; directory sync is the
  deferred enterprise piece

## License posture

All runtime deps commercially usable (MIT/Apache/BSD/ISC/OFL + MPL-2.0
weak-copyleft). Non-OSS flags: Speechmatics On-Device SDK (commercial),
pyannote model weights (HF-gated). The vendored production bundle is
org-owned and AGPL-3.0-licensed (see `static/cic/LICENSE.txt` —
copyleft is accepted; commercial use permitted under AGPL terms).
See docs/OSS-LICENSES.md / NOTICE.md.
