# Operating Cost Model — Cloudflare Edge Stack

What it actually costs to run this app on Cloudflare, at each scale.
Bottom line: hobby/demo usage is **$0** (free tiers absorb it); at real usage
the bill is almost entirely one line item — **SFU/TURN data egress at
$0.05/GB**, which scales quadratically with room size.

## What meters

| Service | Free tier | Paid | What we use it for |
|---|---|---|---|
| Pages static hosting | unlimited | unlimited | the site itself — always free |
| Workers/Pages Fn requests | 100k/day (hard stop) | $5/mo base; 10M/mo incl, +$0.30/M | `/api/ice`, `/api/sfu`, `/api/ai`, `/api/push`, `/sig` upgrades — a few per join |
| Durable Objects — requests (incl. **every WS message**) | 100k/day (hard stop) | 1M/mo incl, +$0.15/M | signaling bus relay — every op/realtime frame on the `ws` lane counts once |
| DO duration | 13k GB-s/day | 400k GB-s/mo incl, +$12.50/M | ~0 — `ctx.acceptWebSocket` hibernates; only message-processing time bills |
| Workers AI | 10k neurons/day (hard stop) | $0.011/1k neurons | gateway only — on-device sherpa/wllama is the default |
| Realtime SFU + TURN egress | **1 TB/month shared** | **$0.05/GB** | all proxied media — this is the whole bill |
| Web Push | — | — | free (browser push services carry it) |

## Per-room-hour math (SFU mode)

Each publisher sends ~1 Mbps video + ~0.1 Mbps audio; every seat downloads
every other seat's stream. Billed egress = `seats × (seats−1) × 1.1 Mbps` —
quadratic in room size:

| Seats | GB/hour | Cost/hour (post-free-tier) |
|---|---|---|
| 2 | ~1.0 | $0.05 |
| 4 | ~5.9 | $0.30 |
| 6 | ~14.9 | $0.74 |
| 10 | ~44.6 | $2.23 |
| 15 | ~104 | $5.20 |

Note: the CF build bakes `VITE_CIC_SFU_ENDPOINT=/api/sfu`, so **every** room
uses the SFU today — even a 2-person call burns ~1 GB/hr. Mesh (loopback
SFU, true P2P) costs $0 in media because bytes never touch Cloudflare.

## Monthly totals (mixed video+audio circles)

| Scale | Assumption | SFU egress/mo | Bill |
|---|---|---|---|
| Hobby/demo | ~10 rooms/wk, 4 seats, 45 min | ~180 GB | **$0** (inside 1TB) |
| ~100 DAU | 25 rooms/day, ~6 seats, 45 min, ~60% cam-on | ~5 TB | **~$230/mo** ($200 SFU + $5 Workers Paid + ~$10 AI + ~$3 DO + requests) |
| ~500 DAU | 150 rooms/day | ~25 TB | **~$1,200/mo** |
| ~1,000 DAU | 300 rooms/day | ~50 TB | **~$2,450/mo** |

Workers AI detail (paid): Whisper captions `$0.0005/min` → 60-min captioned
room = $0.03; Milo chat ≈ $0.0001/turn; Aura TTS ≈ $0.003/reply. Daily free
quota ≈ ~3.5 hrs captions OR ~1,200 Milo turns/day.

## The two real cliffs

1. **Free-plan DO cap** — every `ws`-lane WS message counts toward 100k/day.
   An active room sends ~5–15 msgs/s → free tier covers ~3–6 room-hours/day,
   then the lane hard-fails until UTC reset. Mitigation exists: `mqtt` runs
   in parallel, so rooms degrade to mqtt rather than die — keep `ws` a
   *secondary* lane on the free plan.
2. **Host-pricing economics** — at ~$0.5–0.7/room-hour for a 6-seat video
   circle, a host running daily hour-long circles costs ~$20/mo in egress
   alone. Casual hosts are profitable at $8/mo; heavy ones aren't — which is
   why the levers below matter.

## Customer-facing metering (room seconds pool)

Paid rooms aren't a flag — they're a metered `accounts` row in D1
(`balance_seconds` / `spent_seconds`). Clients heartbeat usage to
`/ai/usage` (~every 30 s while lanes run): each active lane-second debits
1 s from the pool; each `/ai/chat|stt|tts` call debits 5 s
(`CALL_COST`). At zero the room reverts to free/device-side; the pool
floors at 0 so nothing can over-bill. Top-ups are Ed25519-signed grants
(`/ai/topup`) minted post-settlement by `scripts/grant.mjs` — rail-
agnostic, and small sequential top-ups are the streaming-payment model.
Suggested pricing: pool seconds ≈ blended paid-lane cost + margin —
a 6-seat SFU room-hour costs ~$0.74 egress, so $0.001/s pool ≈ $3.60/hr
covers egress + AI with margin.

## Customer-facing billing (cic-pay + Stripe)

Money settles through Stripe; the `cic-pay` worker converts settlements
into wallet/pool seconds (verified webhook → MeterBus credit). Wallets are
keyed by the user's bearer `accountId`; spend attribution is sponsor
wallet → participant wallet → room pool (`/pay/sponsor` = host covers the
circle). Suggested retail defaults (set via `PAY_PACKAGES`/`PAY_SUB`
worker vars, Stripe prices carry the real amounts):

| Offer | Price | Seconds | ≈ $/participant-hour |
|---|---|---|---|
| Subscription | $8/mo | 20,000/mo | $1.44 |
| Pack | $5 | 8,000 | $2.25 |
| Pack | $10 | 18,000 | $2.00 |
| Pack | $20 | 40,000 | $1.80 |

Stripe takes ~2.9% + $0.30 per charge — pack margins above absorb it.

## Cost levers

| Lever | Effect |
|---|---|
| Mesh-first policy (rooms ≤4 seats stay P2P) | 2-seat rooms → $0/hr; cuts the most common case |
| Seat-count bitrate ladder | 10-seat room at 400kbps/sender → ~60% less egress |
| Audio-only mode | ~0.9 GB/hr for 6 seats vs ~14.9 — ~94% cut |
| `DAILY_GB_BUDGET` fail-closed cap on `/api/sfu` + `/api/ice` | hard ceiling — can't be surprised |
| `ws` lane quota backoff | stops retry-spam after free-tier exhaustion (mqtt carries on) |
| CF billing notifications (account alerts API) | early warning before the invoice |
