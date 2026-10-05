# Co-Intelligence Circle — circle-engine

A zero-server, browser-first video circle: talking-stick rounds, live captions,
translation, voice synthesis, an on-device AI companion (Milo), recording, and
end-to-end encryption — with **no backend server**. The production frontend is
the vendored, byte-pristine Co-Intelligence Circle app; everything it expects
from "the backend" is implemented locally, in your tab.

**Live:** https://circle-co-intelligence.github.io/circle-engine/

---

## Contents

1. [What this is](#what-this-is)
2. [Architecture at a glance](#architecture-at-a-glance)
3. [How the backend works — step by step](#how-the-backend-works--step-by-step)
   - [Free plan (Circle — $0 forever)](#free-plan-circle--0-forever)
   - [Paid plan (Circle Host — $8/host/month)](#paid-plan-circle-host--8hostmonth)
4. [Free vs. paid](#free-vs-paid)
5. [The local backend in detail](#the-local-backend-in-detail)
6. [Models](#models)
7. [Development](#development)
8. [Deployment (GitHub Pages)](#deployment-github-pages)
9. [Security](#security)
10. [Repository layout](#repository-layout)
11. [Licenses](#licenses)

---

## What this is

- **The frontend is the real production app.** `static/cic/` holds the vendored
  production bundle (SvelteKit immutable chunks), unmodified. The
  marketing site at `/` is the `www.co-intelligence.online` landing,
  rendered verbatim (scripts stripped).
- **The backend is this repo — and it runs in your browser.** Every production
  backend touchpoint (`/ws/room`, `/ws/caption`, the SFU media plane, `/api/*`,
  recording persistence) is terminated by an in-process bridge before the app
  ever reaches the network.
- **Peers find each other over public rendezvous relays** (Trystero: Nostr/MQTT
  signaling only — relays see ciphertext and hashes, never media or keys).
- **There is nothing to breach.** No accounts database, no media server, no
  transcript store. Room secrets live in the URL `#fragment`, which browsers
  never send to any server.

## Architecture at a glance

```
┌──────────────────────────── browser tab ────────────────────────────┐
│                                                                     │
│  vendored production app (static/cic/)                              │
│        │  /ws/room · /ws/caption · /api/* · /rec/* · sfu offers     │
│        ▼                                                            │
│  local bridge (src/lib/bridge/install.ts)                           │
│   ├─ RoomSocket → RoomBridge → RoomSession                          │
│   ├─ CaptionSocket → sherpa-onnx ASR (WASM, on-device)              │
│   ├─ fetch shim → localStorage, brand assets, recorder artifacts    │
│   └─ SfuLoopback → single RTCPeerConnection ↔ Trystero mesh         │
│                                                                     │
│  engine (src/lib/)                                                  │
│   authority election · signed op-log · OPA policy · SFrame E2EE     │
│   XState stick machine · Milo (wllama) · TTS/ASR (sherpa-onnx)      │
│   recorder (mediabunny → OPFS journal) · notes (Yjs/TipTap)         │
└────────┬──────────────────────────────────────────────┬─────────────┘
         │ WebRTC data channels + media (E2EE)           │ HTTPS
         ▼                                               ▼
   other peers' browsers                    public relays (Trystero rendezvous)
                                            + model upstreams (GitHub/HF)
```

## How the backend works — step by step

### Free plan (Circle — $0 forever)

Everything below runs **today, entirely in the browsers of the people in the
circle**. No cloud function, no database, no media server is involved at any
step. This is the complete pipeline:

**1. Room creation & join**

1. You open `/join`, enter a name + circle code (or get a `/join?code=…`
   invite link — the format the production app generates).
2. The app navigates client-side to `/room/{code}#{secret}`. The `#fragment`
   is generated locally and **never sent anywhere** — it is the room's
   membership key.
3. The vendored app boots and opens `wss://{host}/ws/room/{code}` — which the
   installed shim (`src/lib/bridge/install.ts`) intercepts and hands to a
   `RoomSocket` instead of a real socket.

**2. Peer discovery (the only outside contact)**

4. `openRoom(secret)` (`src/lib/net/room.ts`) calls Trystero `joinRoom`, which
   hashes the secret into a rendezvous topic on public Nostr/MQTT relays.
5. Peers exchange encrypted WebRTC offers/answers through those relays —
   signaling only. Relays cannot read them and see no media.
6. Each new peer gets a direct DataChannel + media connection to every other
   peer (full mesh).

**3. Handshake, authority & state**

7. On peer join, each side sends `hello` (capabilities incl. ephemeral X25519
   pubkey) + a `muted` announce (mute state is broadcast up front — silent
   audio tracks are expected, not transport failure).
8. The deterministic **authority** is elected: lexicographically smallest
   seated peerId. It emits `welcome`/`snapshot` (full room state) to joiners
   and heartbeats every 2.5 s; two missed heartbeats → the next peer takes
   over and bumps the epoch.
9. Every state change is an **Ed25519-signed op envelope**: each client verifies
   signature → OPA policy (`cic.rego` compiled to WASM) → epoch fencing before
   applying. Replays and stale-epoch ops are rejected. See `docs/PROTOCOL.md`.

**4. End-to-end encryption**

10. The epoch author mints a fresh SFrame (RFC 9605) chain key per membership
    change and wraps it per-recipient via ECDH (`sframe-ratchet`).
11. Media frames are encrypted per-sender inside each peer's WebRTC stack;
    ops travel encrypted on the data channel. Joins/leaves rotate keys —
    departed members cannot decrypt post-departure frames. Browsers without
    Insertable Streams show a visible "not E2EE" badge; there is no silent
    downgrade.

**5. Media plane — the "SFU" is a loopback**

12. The vendored app speaks SFU signaling: `publish` (one SDP offer with
    mic/cam/screen transceivers) + `subscribe` (pull requests per remote
    track).
13. `SfuLoopback` (`src/lib/bridge/sfu.ts`) answers on a single local
    `RTCPeerConnection` (host candidates — no STUN/TURN). Tracks it receives
    on the publish pc are relayed into the Trystero mesh via `addStream`;
    mesh tracks the app wants are offered back as pull m-lines, with
    `replaceTrack` reuse when remote tracks are swapped.

**6. Captions, translation, voice — on-device AI**

14. The app's caption socket (`/ws/caption/{code}`) is intercepted by
    `CaptionSocket`, which feeds mic audio through sherpa-onnx WASM: silero
    VAD → Zipformer streaming ASR → `captions` frames in the production wire
    format, fanned out to peers over the mesh.
15. Translation text + TTS audio run through the same sherpa packs; **Milo**
    uses wllama (llama.cpp WASM) with a consent-bounded transcript window —
    `heartMode`/scope=off rooms send him nothing.
16. On first use, model packs are fetched from their **upstream remotes**
    (k2-fsa GitHub releases, Hugging Face — `models/manifest.json`),
    extracted in-browser via libarchive.js, injected as blob URLs, and
    persisted in CacheStorage. No weights live in this repo.

**7. Recording & artifacts**

17. `recorder.ts` composes remote+local video on a canvas, mixes audio via
    WebAudio, muxes WebM through mediabunny into an OPFS/IndexedDB journal —
    30 s segments, 5 s journal cadence (crash loss bounded ~5 s).
18. The app's `/rec/*` upload calls are terminated by the fetch shim into a
    real artifact store — actual bytes, retrievable, not acknowledged-and-
    dropped.

**8. Leaving**

19. Explicit ops end capture; when the last peer leaves, recording/mic capture
    stops and mesh connections close. Nothing persists off-device.

### Paid plan (Circle Host — $8/host/month, $79/yr)

The paid plan **adds managed services on top of the same zero-trust
pipeline** — it never changes the trust model: room secrets still live in URL
fragments, ops are still signed and policy-checked, media is still E2EE, and
the hosted pieces are infrastructure the room *could* run without. Status:
the free pipeline above is shipping today; the managed services below are the
paid tier being stood up alongside paid enrollment.

Step by step, this is what changes on Host:

**1. Reserved codes & persistent rooms**

1. On the free plan a circle's identity is a fresh code + URL fragment per
   session; a Host registration binds a **reserved circle code** to your
   account via the account-link flow (`/account/link`).
2. The room directory keeps your circle addressable between sessions —
   participants join `your-circle` instead of a fresh code, and room
   defaults (theme, stick mode, gates) persist instead of resetting.

**2. Managed relay mesh — up to 30 seats**

3. Free rooms run a full WebRTC mesh: every peer connects to every other.
   That is optimal up to ~9 seats; beyond it, uplink bandwidth grows
   quadratically.
4. On Host, media routes through a **managed SFU relay mesh**: each browser
   keeps a single publish/subscribe connection to the relay instead of
   n−1 peer connections. The wire signaling is identical — the app already
   speaks `publish`/`subscribe` SFU protocol; only where the SFU terminates
   changes (hosted relay instead of the in-tab loopback).
5. E2EE is preserved end-to-end: SFrame encrypts media at the sender, so the
   relay forwards ciphertext it cannot read. The relay is dumb plumbing,
   not a trusted party.

**3. Cloud recording vault & replay links**

6. The same local recorder produces the same journaled WebM segments — that
   part does not move off your device during the circle.
7. On Host, completed segments additionally sync to an encrypted object
   vault keyed to your account, producing shareable replay links after the
   circle ends (rather than recordings living only in the host's OPFS).
8. Vault objects are encrypted with room-derived keys — the vault is
   ciphertext storage; replay decryption happens in the viewer's browser.

**4. Hosted model CDN — fuller Milo, faster captions**

9. Free plan fetches the compact model packs (`manifest.json`: ~100 MB
   SmolLM2-135M, zipformer ASR, Piper-class TTS) from public upstreams.
10. Host circles get priority-fetch, CDN-hosted **larger packs** — a bigger
    instruct model for Milo (better summaries, better round facilitation)
    and higher-accuracy ASR — fetched once, cached in CacheStorage.

**5. Custom branding & priority support**

11. Brand assets (logo, fire theme, colors) are supplied to the room's
    `/brand` and `room-defaults` surfaces — the same fetch-shim endpoints the
    app already calls, served from your account config instead of defaults.
12. Founding hosts get priority human support and early access to V2
    rituals/tools.

## Free vs. paid

| | Circle (Free) | Circle Host ($8/host/mo) |
|---|---|---|
| Circles & time | Unlimited, no time limit | Same |
| Seats | Up to 9 (full P2P mesh) | Up to 30 (managed relay mesh) |
| E2EE | Always on | Always on |
| Talking stick / rounds | All modes | All modes |
| Captions / translation / TTS | On-device | On-device + larger packs |
| Milo AI | On-device (135M) | Larger hosted model pack |
| Recording | Local (OPFS), yours | + encrypted cloud vault & replay links |
| Room address | Fresh code per circle | Reserved code, persistent room |
| Branding | Circle defaults | Your logo & theme |
| Account / tracking | None | Host account only (guests stay anonymous) |
| Support | Community | Priority human support |

**Why it's cheaper:** competitors charge you to rent their servers, and they
charge every seat (Butter $24/member, Zoom Pro $15.99/host, Whereby Pro
$10.99/host — monthly billing, public pricing pages). Our free tier's marginal
cost is near zero because the room *is* the browsers; the $8 host fee pays for
the parts that genuinely need infrastructure: relays for big rooms, vault
storage, and the model CDN.

## The local backend in detail

| Prod touchpoint | Termination point | Implementation |
|---|---|---|
| `wss://…/ws/room/{code}` | `RoomSocket` → `RoomBridge` → `RoomSession` | `src/lib/bridge/roomBridge.svelte.ts`, `src/lib/state/room.svelte.ts` |
| `wss://…/ws/caption/{code}` | `CaptionSocket` → sherpa streaming ASR | `src/lib/bridge/stt.ts`, `src/lib/ai/speech.ts` |
| SFU `publish`/`subscribe` | `SfuLoopback` — in-tab RTCPeerConnection ↔ mesh | `src/lib/bridge/sfu.ts` |
| `GET /api/room-ui/*` | localStorage (themes, prefs, defaults) | `src/lib/bridge/install.ts` |
| `GET /api/site-brand/*` | local brand assets under `/brand` | `src/lib/bridge/install.ts` |
| `/rec/abort`, `/rec-local/*` | in-memory artifact store (real bytes) | `src/lib/bridge/artifacts.ts` |
| `/api/ux-events`, `feedback` | accepted 204 — no telemetry sink exists | `src/lib/bridge/install.ts` |
| op dispatch | Ed25519 sign/verify + OPA-Wasm policy + epoch fence | `src/lib/authority/authority.ts`, `src/lib/policy/` |
| E2EE | SFrame (RFC 9605) + ECDH epoch distribution | `src/lib/crypto/e2ee.ts`, `sframe-ratchet` |
| Peer rendezvous | Trystero over public Nostr/MQTT relays | `src/lib/net/room.ts` |
| AI | sherpa-onnx WASM (VAD/ASR/TTS) + wllama (Milo) | `src/lib/ai/` |
| Recording | mediabunny WebM → OPFS/IndexedDB journal | `src/lib/rec/recorder.ts` |
| Notes | Yjs + TipTap, synced over the op channel | `src/lib/notes/` |

Wire-compatibility contract: `docs/PROTOCOL.md`. Security invariants:
`docs/SECURITY-MODEL.md`.

## Models

Model weights are **never committed** — they are fetched at runtime from their
upstream repositories (`models/manifest.json`):

| Pack | Runtime | Upstream |
|---|---|---|
| `vad` (silero) | sherpa-onnx | k2-fsa GitHub releases (Apache-2.0) |
| `asr-en` (zipformer) | sherpa-onnx | k2-fsa GitHub releases (Apache-2.0) |
| `tts-en` (vits-piper) | sherpa-onnx | k2-fsa GitHub releases (MIT) |
| `llm` (SmolLM2-135M Q4_K_M) | wllama | bartowski Hugging Face repo (Apache-2.0) |

Browser flow: fetch `.tar.bz2` → extract via libarchive.js → inject blob URLs
→ persist in CacheStorage. For local dev, `scripts/fetch-models.sh` drops the
same packs into `static/models/` (gitignored).

## Development

```bash
pnpm install          # pnpm 11 (allowBuilds config must stay — see AGENTS.md)
pnpm dev              # dev server
pnpm check            # svelte-check — must pass
pnpm test             # vitest — 51 tests
pnpm build            # production build
pnpm test:e2e         # Playwright (chromium/firefox/webkit)
pnpm policy:build     # recompile cic.rego → static/policy/cic.wasm (needs opa CLI)
pnpm probe            # multi-page probes driving the real prod frontend
pnpm probe:pw         # focused lobby + password lane
```

Probe seams (dev/test only): `window.__cicSend(code, frame)` injects a
production-protocol frame through the real `RoomSocket` dispatch;
`window.__cicDebug(code)` returns the session's authority/lobby view.

## Deployment (GitHub Pages)

```bash
pnpm build:pages      # CIC_BASE=/circle-engine build + post-build patch
# push build/ contents to the gh-pages branch
```

What `scripts/patch-pages.mjs` does to the **build artifact only** (vendored
source stays byte-pristine):

- Neutralizes the prod env gate ("Engine and dashboard environments do not
  match") — makes the env resolver return `location.origin + base`, so every
  derived API/brand/join URL is same-origin and the bridge shims terminate it.
- Prefixes root-absolute asset refs (`/fonts/`, `*.lottie`, worklets,
  `/site/`, `/cic/`…) with the Pages base path.
- Emits `404.html` SPA fallback + `.nojekyll`; `/join` and `/account/link` are
  prerendered real files (200), matching the invite links prod generates.
- `static/coi-serviceworker.js` restores COOP/COEP → `crossOriginIsolated` →
  SharedArrayBuffer for multi-threaded WASM, which Pages headers can't set.

## Edge services (all optional, env-gated)

The app is fully functional with zero configuration. Optional env vars light
up edge infrastructure — none of them see room secrets or plaintext media:

| Env | Effect |
|---|---|
| `VITE_CIC_LANES` | signaling lanes, comma-separated: `mqtt` (default), `ws`, `nostr`, `torrent`, `ipfs`, `supabase` |
| `VITE_CIC_SIGNAL_WS` | ws lane endpoint — own DO-backed bus, same-origin `/sig` on Pages |
| `VITE_CIC_MQTT_BROKERS` / `VITE_CIC_NOSTR_RELAYS` | relay URL lists for those lanes |
| `VITE_CIC_SUPABASE_URL` / `VITE_CIC_SUPABASE_KEY` | enable the supabase lane |
| `VITE_CIC_TURN` | JSON `RTCIceServer[]` static TURN entries (prefer the `/api/ice` broker for real deploys) |
| `VITE_CIC_SFU_ENDPOINT` | cloud-SFU adapter endpoint (default shape: `/api/sfu`, proxy to CF Realtime) |
| `VITE_CIC_AI_ENDPOINT` | zero-retention AI gateway endpoint (`/ai/chat`, `/ai/stt`, `/ai/tts`); unset → on-device sherpa/wllama |

Cloudflare Pages deployment (`pnpm build:cf` bakes the endpoints):

- `functions/api/ice.ts` — TURN credential broker (`TURN_KEY_ID` + `TURN_API_TOKEN` secrets)
- `functions/api/sfu/[[path]].ts` — CF Realtime auth proxy (`CALLS_APP_ID` + `CALLS_APP_SECRET` secrets)
- `functions/sig/[[path]].ts` — WS proxy → `cic-signaling` worker (RoomBus DO, no secrets)
- `functions/api/ai/[[path]].ts` — proxy → `cic-ai-gateway` worker (Workers AI binding, no keys)
- `functions/api/push/[[path]].ts` — proxy → `cic-push` worker (VAPID keypair via `wrangler secret put`)

`workers/` holds the standalone Worker sources (ice, signaling DO, VAPID
push, ai-gateway); each has its own `wrangler.toml` and takes secrets via
`wrangler secret put`. Deployed on this account: `cic-signaling`,
`cic-ai-gateway`, `cic-push`, `cic-ice`. Pages secrets are scoped per
environment — production uses the `circle-engine` Calls app + `cic-turn`
key; preview deploys use dedicated `cic-prev3` credentials.

## Security

- Room secret in `#fragment` — never on the wire.
- Ops are Ed25519-signed, epoch-fenced, policy-gated (OPA).
- `effectiveMuted = selfMuted OR autoMuted OR remotelyMuted` — no remote
  unmute, ever.
- E2EE default-on; unsupported browsers show a visible badge, never silently
  downgrade.
- CSP: `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `wasm-unsafe-eval` for the WASM runtimes.

## Repository layout

```
src/routes/          landing (vendored marketing site), /join, /room/[code], /account/link
src/lib/bridge/      install.ts shims, RoomSocket/Bridge, SfuLoopback, stt, artifacts
src/lib/net/         Trystero room adapter, breakouts
src/lib/state/       RoomSession — mesh engine, participants, gates
src/lib/authority/   election, lease, signed OpLog
src/lib/crypto/      SFrame E2EE session, Ed25519 identity
src/lib/policy/      cic.rego → opa-wasm engine
src/lib/ai/          sherpa-onnx speech/translate, wllama Milo
src/lib/media/       mic/cam capture
src/lib/rec/         mediabunny recorder + OPFS journal
src/lib/wire/        production-compatible wire messages (zod)
static/cic/          vendored production app (source of truth)
static/site/         vendored marketing site (rendered at /)
static/models/       gitignored — fetched at runtime from upstream
scripts/             patch-pages.mjs, fetch-models.sh, licenses.mjs
docs/                PROTOCOL.md, SECURITY-MODEL.md, DESIGN-DELTAS.md
```

## Licenses

Authored code in this repo is licensed under the **GNU Affero General Public
License v3.0** ([`LICENSE`](LICENSE)) — copyleft, commercial use permitted;
if you run a modified version as a network service you must offer its source.
Commercial/proprietary licensing is available separately — contact
hello@co-intelligence.online.

Vendored and upstream components carry their own licenses — see `NOTICE.md`,
`docs/OSS-LICENSES.md` (canonical inventory), `docs/CUSTOM-CODE-AUDIT.md` (custom-code disposition), and `pnpm licenses:gen` to regenerate.
