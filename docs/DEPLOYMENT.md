# Deployment

Two fully-supported topologies. The frontend is the same static bundle in
both — only build-time `VITE_CIC_*` env differs.

## A. Cloudflare edge (recommended)

| Piece | Where | Config |
|---|---|---|
| Frontend | Pages / GitHub Pages | `pnpm build:cf` / `pnpm build:pages` |
| Signaling | Trystero lanes (mqtt/nostr/torrent) + `/sig` DO bus | `VITE_CIC_LANES`, `VITE_CIC_SIGNAL_WS` |
| ICE | `/api/ice` Pages Function → short-lived TURN creds | `TURN_KEY_ID`, `TURN_API_TOKEN` Pages secrets |
| Paid SFU | `/api/sfu` → Cloudflare Realtime | `CALLS_APP_ID`, `CALLS_APP_SECRET` Pages secrets |
| Sealed recording | `/api/rec` → R2 (ciphertext only) | `REC_BUCKET` binding |
| AI gateway | `cic-ai-gateway` worker | `METER`, `GRANT_PUBKEY`, `AI_*` |
| Sensory/DSP | `cic-dsp` worker | `SPEECH_API_KEY` |
| Metering | MeterBus DO on ai-gateway | `METER` binding |
| Admin console | `/admin/*` on ai-gateway | `CF_ACCESS_TEAM`, `CF_ACCESS_AUD`, `GRANT_SECRET` |

**Verified deployment (regenleadership account, `circle-engine.pages.dev`):**
all six workers (`cic-signaling`, `cic-sfu`, `cic-ice`, `cic-push`, `cic-dsp`,
`cic-ai-gateway`) deploy to the same account via `wrangler deploy` from
`workers/*/`. Pages Functions proxy `/sig`, `/api/ai`, `/api/push` to
`*.regenleadership.workers.dev`; `/api/ai/pack/llm` serves the on-device LLM
(CORS/CORP-safe). Set Pages Function secrets under project → Settings →
Functions: `TURN_KEY_ID` + `TURN_API_TOKEN` (CF dashboard → Realtime →
TURN → Create key) and `CALLS_APP_ID` + `CALLS_APP_SECRET` (Realtime →
Calls app) — without them `/api/ice` and `/api/sfu` degrade gracefully
(`turn-unconfigured`/`sfu-unconfigured`). Until TURN creds exist the free
path runs STUN-only, which covers most consumer NATs but not symmetric
NATs/corporate firewalls.

## B. Self-host (no Cloudflare)

`deploy/` ships a three-service compose stack: **caddy** (static+TLS+proxy),
**mosquitto** (trystero mqtt lane over WSS), **coturn** (STUN/TURN).

```bash
cd deploy
cp env.example .env   # fill DOMAIN + TURN_SECRET
./selfhost.sh         # builds the bundle pointed at your domain, renders
                      # coturn's config, `docker compose up -d`
```

Port requirements: 80/443 (Caddy, TLS + WSS), 3478 udp/tcp + 49152–49252 udp
(coturn relay range). DNS `A`/`AAAA` for `DOMAIN` must point at the host —
Caddy provisions and renews certificates itself.

### Mapping: what self-host replaces

| Edge piece | Self-host equivalent |
|---|---|
| Trystero public brokers | bundled mosquitto (`VITE_CIC_MQTT_BROKERS=wss://$DOMAIN/mqtt`) |
| `/api/ice` TURN broker | bundled coturn (`VITE_CIC_TURN` fixed creds) |
| Cloudflare Realtime SFU | mesh only — simulcast + pull-hints carry scaling |
| R2 sealed recording | journal stays local; `/api/rec` absent → uploads retry-then-keep-local |
| cic-ai-gateway / cic-dsp | unset → all AI stays on-device (default free path) |
| Speechmatics SaaS | `VITE_CIC_SPEECH_URL` → on-prem RT endpoint (same protocol) |
| Access admin | self-host has no console — meters are Cloudflare-side |

Optional heavier services — a faster-whisper/piper speech container or an
on-prem Speechmatics appliance — plug in via `VITE_CIC_SPEECH_URL` /
`VITE_CIC_AI_ENDPOINT` without touching the compose file.

## Operations

- **TLS**: Caddy manages ACME; keep 443 reachable.
- **Backups**: recording ciphertext lives client-side (Dexie journal);
  R2/compose hold only ciphertext either way — back up `mosquitto-data`
  only if persistence matters (it doesn't for signaling correctness).
- **Upgrades**: `git pull && ./selfhost.sh` — the bundle rebuild + rolling
  restart is the whole upgrade; no schema migrations.
- **Health**: `curl -I https://$DOMAIN/` (200), `curl https://$DOMAIN/mqtt`
  (101 upgrade), `turnutils_uclient` against 3478.
- **Secrets**: `.env` is gitignored; `turnserver.rendered.conf` contains the
  TURN secret — also gitignored, chmod-600 on disk recommended.

## Native app (Tauri shell)

`src-tauri/` wraps the same static build in a system webview — P2P media,
E2EE, sherpa STT, wllama Milo all run identically; the shell adds a local
speech endpoint and deep links.

```bash
pnpm icons          # regenerate src-tauri/icons (no ImageMagick needed)
pnpm tauri:dev      # vite dev + webview window
pnpm tauri:build    # pnpm build:native → bundled installers
```

`build:native` bakes the deployed worker endpoints (ai-gateway, dsp, sfu,
signaling bus over `VITE_CIC_SIGNAL_WS`) — same lanes as the hosted site.

**What the shell adds**

- `speech_endpoint` → in-process **speechd** (`src-tauri/speechd`), a local
  Speechmatics-RT-protocol WebSocket on 127.0.0.1. Engine selection:
  `CIC_SPEECH_UPSTREAM=ws://…` relays sessions to an on-prem appliance, an
  On-Device SDK service bridge, or any RT-compatible engine — verbatim
  `StartRecognition` passthrough, so diarization/audio-events survive.
  With no upstream the endpoint refuses sessions cleanly and the client
  stays on its sherpa lane. `cargo test --manifest-path src-tauri/speechd/Cargo.toml`.
- `circle://` deep links + single-instance — `circle://room/184729#secret`
  focuses the running window and lands in the room.

**Platform notes**

- Linux build host needs: `sudo dnf install webkit2gtk4.1-devel libsoup3-devel
  gtk3-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel
  dbus-devel pkgconf-pkg-config` (apt equivalents on Debian).
- macOS: camera/mic entitlements + usage strings ship in
  `entitlements.plist`/`Info.plist`; WKWebView getUserMedia needs macOS 14+.
- Linux getUserMedia depends on the WebKitGTK/wry media-capture support in
  the deployed webkit — verify camera/mic on the target distro before
  shipping a .deb/.rpm. Windows (WebView2) grants media by default.
- Speechmatics On-Device SDK is commercial-procurement; the seam is built,
  drop-in is a license + bridge-service away.
