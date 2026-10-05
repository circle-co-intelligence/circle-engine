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
| Sensory/DSP | `cic-dsp` worker | `SPEECH_PROVIDER`, `SPEECH_API_KEY`, `SPEECH_LANG`, `SPEECH_MODEL` |
| Metering | MeterBus DO on ai-gateway | `METER` binding |
| Billing | `cic-pay` worker | `STRIPE_*`, `PAY_*`, `APP_ORIGIN`, `METER` (script_name) |
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

### Billing (cic-pay + cic-pay-hook + Stripe)

Billing is split across two workers so that **no client-facing worker holds
any Stripe credential**:

- `workers/pay/` → `cic-pay` — the public bridge. Checkout is Stripe
  **Payment Link** URL assembly (no API call); portal + webhook requests
  are forwarded verbatim to the hook worker. It holds only `METER_TOKEN`.
- `workers/pay-hook/` → `cic-pay-hook` — the isolated Stripe worker. Holds
  the only Stripe secrets, both minimal: a **read-only restricted key**
  plus the webhook secret.

```bash
cd workers/pay-hook && wrangler deploy
wrangler secret put STRIPE_READ_KEY        # rk_… restricted key (see below)
wrangler secret put STRIPE_WEBHOOK_SECRET  # whsec_… from the webhook below
wrangler secret put METER_TOKEN            # 'settle' role — scripts/meter-acl.mjs
# PAY_PORTAL_LINK is a plain var (public hosted link, not a secret):
#   wrangler deploy --var PAY_PORTAL_LINK:https://billing.stripe.com/p/login/<id>

cd ../pay && wrangler deploy   # [[services]] binding → cic-pay-hook
wrangler secret put METER_TOKEN            # 'admin' role
```

**Stripe key — restricted `rk_…` on cic-pay-hook only, read-only.**
Dashboard → Developers → API keys → Create restricted key:

| Permission | Access | Used for |
|---|---|---|
| Checkout Sessions | **Read** | line-item lookup → price → seconds |
| Charges | Read | refund/dispute → bounded clawback resolution |
| Events | Read | webhook event re-verification |

Everything else stays `None` — no PaymentIntents, no PaymentMethods, no
Payouts, no Checkout or Portal write — **the capability to charge a card
or open a session does not exist on this key**. `/pay-hook/status` reports
`readKey: 'restricted'`.

**Checkout = Payment Links.** Create one Payment Link per pack and one for
the subscription (Dashboard → Payment Links), each pointing to its price.
Put the `https://buy.stripe.com/…` URLs in `PAY_PACKAGES[].paymentLink` /
`PAY_SUB.paymentLink`. `/pay/checkout` assembles
`link?client_reference_id=<accountId>` (or `<accountId>:<room>` for room
top-ups) — the hook worker resolves the purchased price to seconds at
settlement time.

**Portal = hosted login link.** Stripe's billing portal has a shareable
login URL (Dashboard → Settings → Billing → Customer portal → "Share a
link to the portal") — `https://billing.stripe.com/p/login/<id>`. Set it
as `PAY_PORTAL_LINK` on cic-pay-hook; `/pay/portal` returns it after the
signed-request + step-up checks, and the customer authenticates with an
email OTP on Stripe's domain. No `billing_portal/sessions` API call
exists anywhere in the codebase.

The webhook additionally re-fetches each event via `GET /v1/events/{id}`
before crediting (Events:Read) — a leaked `whsec_` alone cannot forge
credits, and forged/tampered events are rejected before they can burn a
dedupe slot.

**MeterBus capability tokens** — when `METER_ACL` is set on
cic-ai-gateway, every ledger call needs a role token and `acct:*` money
ops need a client signature / sponsorship / matching credit. Generate:

```bash
node scripts/meter-acl.mjs   # prints 4 tokens + the ACL JSON
```

Deploy order matters — set all four `METER_TOKEN` secrets (cic-pay=admin,
cic-ai-gateway=spend, cic-sfu=probe, cic-pay-hook=settle) **before** setting
`METER_ACL` on cic-ai-gateway, or calls start 401ing. `GET /ai/status`
reports `meterAcl: true` when the gate is live.

Privileged wallet records (`key:*` device keys, `passkey:*`,
`sponsored:*`, `limits`) additionally require the client's own signature —
MeterBus derives the stored value from the signed body, so a compromised
worker can't register an attacker device key or fake a sponsorship.
Internal keys (`balance`, `credit:*`, `nonce:*`, …) are unwritable via
kvput for every role.

Vars in `workers/pay/wrangler.toml` (or `wrangler deploy --var`):
`APP_ORIGIN`, `PAY_PACKAGES` (JSON pack catalog:
id/label/seconds/priceId/paymentLink), `PAY_SUB` (JSON monthly plan with
paymentLink). Mirror `PAY_PACKAGES`/`PAY_SUB` onto cic-pay-hook (it maps
price → seconds at settlement). cic-pay reaches the hook via the
`[[services]]` binding (`PAY_HOOK` → `cic-pay-hook`); `PAY_HOOK_URL`
remains only as a self-host fallback — workers.dev fetches between
same-account workers are refused (error 1042), so do not rely on the URL
path on Cloudflare.

Stripe Dashboard → Developers → Webhooks → add endpoint:
`https://cic-pay-hook.regenleadership.workers.dev/pay-hook/webhook`
(cic-pay's `/pay/webhook` forwards there too, so either URL works) with
events `checkout.session.completed`, `invoice.paid`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`charge.refunded`, `charge.dispute.created`.

Spend model: `acct:<accountId>` wallet per user. The accountId is a public
identifier (sha256 of the device's signing key); spend requires an
x-cic-signed request — see docs/SECURITY.md. `POST /pay/sponsor` lets a
funded host's wallet cover a circle **up to a committed budget**
(default 4h, max 24h — `budgetSeconds` in the signed body); otherwise each
participant's paid lanes draw their own wallet, falling back to the room
pool. Frontend calls it via `VITE_CIC_PAY_ENDPOINT` (default `/pay`).

Recommended Stripe portal configuration (Dashboard → Settings → Billing →
Customer portal): enable invoice history, payment-method update, and
subscription cancellation; disable plan switching (single plan — proration
invoices aren't credited) and keep subscription *pausing* off. Disabling
plan switching also means a customer can't be upsold into a charge they
didn't initiate — the portal can never create a new charge. Recommended Cloudflare rate-limit rules:
`/pay/checkout`, `/pay/link-begin`, `/pay/challenge` → ~10 req/min per IP;
`/sessions/new` on cic-sfu → ~30/min per IP.

### Speech + AI provider configuration (cic-dsp, cic-ai-gateway)

**cic-dsp `/speech` relay** — `SPEECH_PROVIDER` picks the upstream:

| `SPEECH_PROVIDER` | Upstream | Languages | Extras |
|---|---|---|---|
| `speechmatics` (default) | RT SaaS / `SPEECH_BASE_URL` on-prem | ~50 — `SPEECH_LANG` (default `en`; `auto` = provider LID) | diarization + audio events |
| `assemblyai` | streaming v3 | `SPEECH_LANG` → `language_code`; `auto` → `language_detection` | speaker labels |
| `openai` | Realtime transcription session | **~99, auto per-segment — code-switching works** | no diarization/audio events |

```bash
cd workers/dsp && wrangler deploy
wrangler secret put SPEECH_API_KEY    # openai: sk-… / speechmatics: api key
wrangler deploy --var SPEECH_PROVIDER:openai --var SPEECH_MODEL:gpt-4o-transcribe
```

`SPEECH_MODEL` defaults to `gpt-4o-transcribe` (whisper-class, ~99
languages, auto-detected per segment). `SPEECH_LANG` applies to the
speechmatics + assemblyai lanes. Client-side `VITE_CIC_SPEECH_LANG`
mirrors `SPEECH_LANG` for direct-mode and `caption-update` lang tags.

**On-device packs** — `VITE_CIC_ASR_PACK` selects the local ASR engine:
`whisper` (transformers.js + `onnx-community/whisper-base` q8 on ONNX
Runtime Web — **fully zero-egress, ~99 languages, auto-detects the spoken
language per utterance**, no user config needed; WebGPU→WASM fallback) or
a sherpa WASM pack `en|zh-en|zh-yue-en`. `VITE_CIC_TTS_PACK=en|multi`
(piper / kokoro multi-lang). `fetch-models.sh` fetches the selected sherpa
variants under `FETCH_HEAVY=1`; whisper's model files stream through the
`/ai/hf/<repo>/resolve/...` proxy (HF repo allowlist) and its ONNX runtime
through `/ai/ort/` — both edge-cached, then browser Cache API for repeat
loads. `/ai/pack/<id>` serves every manifest sherpa pack id. `/ai/stt`
→ whisper-large-v3-turbo (~99 languages auto-detected, optional
`language` hint) remains the cloud-fallback STT.

**Language UX contract**: speakers never configure an input language —
every lane auto-detects per utterance (whisper via SOT-token LID, openai
lane natively). The only language a user picks is their *output* language
(`tr-lang`/translation target); the detected source language rides
segments (`lang`) and `tr-segment.originalLang` so translation runs the
real direction, not the speaker's display language.

**cic-ai-gateway `/ai/chat` (cloud Milo)** — `AI_PROVIDER` picks the
upstream (`workers-ai` | `groq` | `openrouter` | `anthropic` | `openai`).
`AI_CHAT_MODEL` + `AI_API_KEY` set the default model; `AI_REASONING_EFFORT`
(`low|medium|high`) is forwarded as `reasoning_effort` on
reasoning-capable models. Callers can override per-request via
`{model, effort}` in the body — the frontend sends operator-configured
`VITE_CIC_MILO_MODEL` / `VITE_CIC_MILO_EFFORT` when set. Client-chosen
models are honored **only** when present in `AI_MODEL_ALLOWLIST` (JSON
array) — `/ai/chat` is unauthenticated, so without the allowlist any
anonymous caller could pick arbitrarily expensive models on the
operator's key; unset means overrides are silently ignored. `effort` is
validated to a fixed set.

**Zero-retention**: all providers are used inference-only; no worker
persists audio or transcripts. Provider ZDR terms still apply on their
side — see docs/COMPLIANCE.md.

### UX telemetry (opt-in analytics + masked replay)

Three pieces: the `/api/ux` Pages Function (bindings in root `wrangler.toml`),
the `cic-ux-replay` R2 bucket, and the vendored Counterscale worker.

1. **Enable Analytics Engine on the account once** — dashboard → Workers →
   Analytics Engine (`/workers/analytics-engine` on the account). This is a
   one-time account toggle; wrangler refuses AE bindings until it's on.
2. **R2 bucket + retention**:
   ```bash
   wrangler r2 bucket create cic-ux-replay
   ```
   Then a lifecycle rule expiring `ux-replay/` at 30 days (keep the default
   multipart-abort rule when PUTting):
   ```bash
   curl -X PUT "$CF_API/accounts/$ACCOUNT_ID/r2/buckets/cic-ux-replay/lifecycle" \
     -H "Authorization: Bearer $CF_TOKEN" -H 'content-type: application/json' -d '{
     "rules":[
       {"id":"expire-replay-30d","enabled":true,"conditions":{"prefix":"ux-replay/"},
        "deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}},
       {"id":"Default Multipart Abort Rule","enabled":true,"conditions":{},
        "abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":604800}}}]}'
   ```
3. **Pages secrets** (project `circle-engine`):
   ```bash
   wrangler pages secret put UX_HMAC --project-name circle-engine   # 64-hex
   wrangler pages secret put UX_ADMIN --project-name circle-engine  # replay viewer bearer
   ```
   `UX_DISABLED=1` as a project var is the kill switch for all collection.
4. **Counterscale worker** (`vendor/counterscale`, MIT — unmodified upstream
   except wrangler name/dataset/bucket):
   ```bash
   cd vendor/counterscale && pnpm install && pnpm --filter @counterscale/server build
   cd packages/server && wrangler deploy
   wrangler secret put CF_ACCOUNT_ID      # regenleadership account id
   wrangler secret put CF_BEARER_TOKEN    # API token with Account Analytics: Read
   wrangler secret put CF_PASSWORD_HASH   # bcrypt of the dashboard password
   wrangler secret put CF_JWT_SECRET      # random hex
   wrangler secret put CF_AUTH_ENABLED    # 'true'
   wrangler r2 bucket create cic-analytics-rollups   # daily rollup storage
   ```
   Dashboard: `https://cic-analytics.regenleadership.workers.dev` — password
   login. The site-id used by the client is `circle-engine`.
5. **Querying funnel events** (Analytics Engine SQL):
   ```bash
   curl -X POST "$CF_API/accounts/$ACCOUNT_ID/analytics_engine/sql" \
     -H "Authorization: Bearer $CF_TOKEN" --data \
     "SELECT blob1 AS event, count() FROM cic_ux_events
      WHERE timestamp > now() - INTERVAL '7' DAY GROUP BY event ORDER BY count() DESC"
   ```
6. **Replay admin viewer**: `https://<pages>/admin/replay` — paste the
   `UX_ADMIN` token; sessions list, click to play masked rrweb.

Privacy contract lives in `docs/SECURITY.md` §UX telemetry — enum-only
events, `•`-masked replay, GPC/DNT double-enforced, 30-day replay retention,
revoke deletes the visit prefix.

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
| UX telemetry | `/api/ux/*` absent → emitters no-op after one failed mint; consent toggles stay but collect nothing (nothing leaves the browser) |

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

`src-tauri/` is a thin native shell that loads the **deployed site**
(`frontendDist` is the production URL, not an embedded bundle) — the
desktop app always matches the website, so frontend changes ship via a
normal Pages deploy with no binary rebuild. P2P media, E2EE, sherpa STT,
wllama Milo all run identically; the shell adds a local speech endpoint
and deep links. `CIC_WEB_URL` overrides the frontend URL at runtime
(preview deploys, local dev).

```bash
pnpm icons          # regenerate src-tauri/icons (no ImageMagick needed)
pnpm tauri:dev      # vite dev + webview window (devUrl → localhost:5173)
pnpm tauri:build    # bundled installers — no frontend build needed
```

The shell needs a rebuild only when `src-tauri/` itself changes (speechd,
deep-link handling, WebRTC flags). `build:native` still exists for
producing a self-contained static build with baked worker endpoints —
it is no longer part of the Tauri build path.

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
