# Deployment

Two fully-supported topologies. The frontend is the same static bundle in
both — only build-time `VITE_CIC_*` env differs.

## A. Cloudflare edge (recommended)

| Piece | Where | Config |
|---|---|---|
| Frontend | Pages / GitHub Pages | `pnpm build:cf` / `pnpm build:pages` |
| Signaling | Trystero lanes (mqtt/nostr/torrent) + optional `/sig` DO bus | `VITE_CIC_LANES`, `VITE_CIC_SIGNAL_WS` |
| ICE | `/api/ice` Pages Function → short-lived TURN creds | `CALLS_*` in Pages env |
| Paid SFU | `/api/sfu` → Cloudflare Realtime | `CALLS_APP_ID`, `CALLS_APP_SECRET` |
| Sealed recording | `/api/rec` → R2 (ciphertext only) | `REC_BUCKET` binding |
| AI gateway | `cic-ai-gateway` worker | `METER`, `GRANT_PUBKEY`, `AI_*` |
| Sensory/DSP | `cic-dsp` worker | `SPEECH_API_KEY` |
| Metering | MeterBus DO on ai-gateway | `METER` binding |
| Admin console | `/admin/*` on ai-gateway | `CF_ACCESS_TEAM`, `CF_ACCESS_AUD`, `GRANT_SECRET` |

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
