# Security Model — Billing & Client Identity

Circle Engine's billing identity is cryptographic, not credential-based.
There is no account database, no password, no session cookie — the account
*is* a public key.

## Identity

- `accountId = sha256(SPKI)` — a 64-hex public identifier. Knowing it proves
  nothing and spends nothing.
- The private key is a **non-extractable WebCrypto P-256 CryptoKey** in
  IndexedDB. It cannot be exported by any script — XSS, extensions, and
  logs can see the accountId but can never steal the key itself.
- Credential-bearing requests carry `x-cic-pub/ts/nonce/sig` headers —
  an ECDSA signature over `accountId\nmethod\npath\nsha256(body)\nts\nnonce\nkeyHash`,
  verified by the workers with a ±5-minute window and single-use nonces
  (MeterBus `claim`).

## What a stolen accountId buys an attacker: nothing

| Surface | Defense |
|---|---|
| `/ai/usage`, `/ai/entitlement` | Unsigned `account` params are ignored — the wallet lane never opens without a valid signature |
| `/pay/convert`, `/pay/sponsor` | Signed only; a forged or replayed request is rejected (401/409) |
| `/pay/portal`, `/pay/account` | Signed; the hosted Stripe portal link is only ever returned to the key holder (customers authenticate to Stripe by email OTP) |
| `sessions/new` (SFU) | Signed account OR a room-membership ticket (`sha256('sfu:'+roomSecret+':'+roomCode)`) + funded pool — a bare room code is public and authorizes nothing |
| Stripe webhook | HMAC-SHA256 + event dedupe; settlement is never client-redirect-driven |

## Multi-device

Additional device keys register as signed delegates: the new device parks
its pubkey behind a short code (`/pay/link-begin`), an existing device
approves it (`/pay/link-approve`), and any device key can be revoked
(`/pay/revoke`). The account keeps one wallet across all its devices.

## Optional passkey step-up

Enrolling a platform passkey (Touch ID / Windows Hello) on /billing makes
high-risk ops — portal sessions, device approval/revocation, spend-cap
changes, large conversions — additionally require a WebAuthn assertion
against a one-time server challenge. Hardware-bound and origin-bound:
a phished user cannot be tricked into signing on a foreign origin, and a
cloned key cannot sign at all.

## Optional spend cap

`/pay/limits` (signed) sets a per-UTC-day spend ceiling on the wallet;
MeterBus enforces it inside the Durable Object at debit time. Off by
default — the user's choice.

## What we never hold

- Card numbers, CVCs, billing addresses — Stripe Checkout/Portal only.
- Passwords, emails, session tokens — none exist.
- Room secrets — they live in URL fragments and never reach any server.
- Signing keys — non-extractable; they literally cannot leave the device.

## If the platform itself is compromised

Signatures are verified at the public boundary *and* again inside the
ledger, so hostile infrastructure is bounded:

| Broken layer | What the attacker gets |
|---|---|
| **cic-sfu** | Its MeterBus token is `probe` role — balance reads only, no money ops |
| **cic-ai-gateway** | `spend` role — can debit room pools and *sponsored* rooms on wallets (bounded by the user's opt-in cap), but `acct:*` debits/transfers need the client's own signature and credits need `admin` — it cannot drain or inflate wallets |
| **cic-pay** | `admin` MeterBus role + **no Stripe credential**. Can credit/debit room pools and issue *matched* clawbacks, but wallet debits still need `clawbackOf` a recorded `credit:<id>` or a client signature, and privileged wallet records (`key:*` device keys, `passkey:*`, `sponsored:*`, `limits`) require the *client's own signature* verified inside the DO — it cannot drain wallets or inject an attacker device key |
| **cic-pay-hook** | The only Stripe secrets: a **read-only `rk_`** (Events/Charges/Sessions read — cannot charge, refund, create sessions, or pay out) and `whsec_`; the portal is Stripe's hosted email-OTP link, not an API call. Compromise = fabricated credits (free service) — the `settle` role cannot drain wallets or forge clawback bases |
| **Webhook secret** (`whsec_`) alone | Nothing — events are re-fetched from Stripe's API before crediting; forged ids 404, tampered payloads mismatch `data.object.id` |
| **Cloudflare account** | Root — redeploys workers, reads env. Mitigate: 2FA on the account, per-purpose scoped API tokens, `METER_ACL` (hashes only) in place, quarterly rotation per AGENTS.md |
| **User device key** | The wallet — but the key never leaves the device and revocation is one signed call |

Ledger details: callers authenticate `x-meter-token` (hashed in
`METER_ACL`), the claimed `inst` is verified against the DO's own id
(`idFromName` — instance names can't be spoofed), and wallet spends take
the amount from the *signed client body*, not the caller's claim. Clawback
debits are capped by the credit they unwind. Privileged-record writes on
`acct:*` derive their stored value from the signed body (`key:*` must hash
to the carried pubkey, `sponsored:*` carries the signed budget, `limits`
comes from the signed cap); internal keys (`balance`, `spent`, `credit:*`,
`clawed:*`, `nonce:*`, `dauth:*`, `spendDay:*`, `sponsor`, `audit`) are
unwritable via `kvput` for every role — a forged `credit:` record can't be
manufactured to fake a clawback base. `cust:*` account bindings are
first-write-wins inside the DO. Every acct money op lands in the 50-entry
server-side audit ring visible on /billing **and** mirrors append-only to
Analytics Engine — an attacker can stop writing but can't erase history.

## Honest residual risks

- **Active XSS** can invoke signing while on-origin (CSP + non-extractable
  keys bound this: no exfiltration, no offline use, damage limited to the
  live session and the wallet balance).
- **Lost only device** = lost wallet. There is no recovery seed by design;
  link a second device or accept the limit.
- **Room ticket** is a bearer capability — a past member retains it while
  the room pool stays funded.
- **Sponsored-room drain** — bounded by the host's committed per-room
  budget (default 4h, max 24h) *and* ≤7200s/call *and* the user's optional
  daily cap; a compromised gateway can only spend what the host already
  authorized for that room.
- **Compromised cic-pay-hook** can fabricate wallet credits (service
  credit, not money) and unwind its own credits — debits beyond recorded
  credits still need a device signature or live sponsorship.
- **Cloudflare account / Stripe Dashboard compromise** remains root — the
  credential design means even that can't charge cards *through our keys*,
  but a hostile redeploy could start signing as the workers. Defense is
  procedural (2FA, scoped tokens, rotation) plus the append-only AE audit.
- Liveness of spend relies on clients honestly reporting usage — the paid
  tier is honest-metering, not adversarial billing isolation.

## UX telemetry (opt-in)

Product analytics + session replay exist **only behind explicit per-visit
consent** (`cic.uxConsent.v1`, written by the room's consent toggle). Design:

- **Consent gate**: nothing initializes until `analytics:true`; replay
  additionally requires `replay:true`. `navigator.globalPrivacyControl` /
  `doNotTrack` force both off client-side, and the Pages Function refuses
  collection again server-side on `Sec-GPC`/`DNT` headers — a tampered
  client still can't emit.
- **Session**: `POST /api/ux/session` mints an HMAC-signed token carrying
  only `{visitId, exp}` — a per-load UUID in sessionStorage. No account,
  IP, room code, or device identifier exists in the token, so tokens can't
  be correlated across loads or tied to a person.
- **Funnel events** → Analytics Engine (`cic_ux_events`). The event schema
  is a fixed enum vocabulary (page/step/target/role/browser/device) —
  unknown field values are dropped server-side, free text is impossible,
  and room-code paths are normalized to `/room` before any write
  (`/room/803351` never reaches a blob). The only request-derived field is
  coarse `request.cf.country`; IPs are never persisted. AE datapoints are
  immutable for their retention window (~90d), so nothing written may
  identify a person — that is the deletion strategy.
- **Traffic** → `cic-analytics` worker (vendored MIT Counterscale):
  cookieless If-Modified-Since visitor counting, no identifiers, no IP
  storage; our client sends the sanitized path only.
- **Replay** → R2 `cic-ux-replay`, only when `replay:true` **and** inside a
  room. The vendored masked rrweb recorder (`static/cic/chunks/`):
  all text → `•`, all inputs masked (every input type), media/images/
  canvas/iframes/fonts/CSS-images blocked, `[data-message]`/
  `[data-transcript]`/participant-name/avatar selectors blocked,
  `data-ux-static` resolves to a fixed dictionary of ~22 canned labels —
  never DOM text. `meta.href` is synthetic (`replay.invalid/{page}`), so
  URLs — and therefore room codes — cannot appear in a recording.
  Hard caps: 10min / 5MB / 32 chunks per visit. `patch-pages.mjs` fails
  the build if the masking anchors or label dictionary change.
- **Revocation**: `POST /api/ux/revoke` deletes the visit's whole R2
  prefix (indistinguishable 204 — no existence oracle); AE datapoints are
  unlinkable so there is nothing person-scoped to delete. R2 lifecycle
  also expires `ux-replay/` at 30 days.
- **Admin access**: `GET /api/ux/admin/replay/*` requires the `UX_ADMIN`
  bearer (constant-ish comparison over a high-entropy secret); objects are
  never public. The viewer at `/admin/replay` shows anonymous visit ids
  only — there is no identity column to display.

Residuals: replay shows interaction geometry (where people click); the
If-Modified-Since scheme is "tracking" under GDPR but sits behind the same
consent; a compromised `cic-analytics`/Pages origin could accept forged
datapoints (bounded: enum vocabulary only, no exfil target).
