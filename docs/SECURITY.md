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
| `/pay/portal`, `/pay/account` | Signed; the Stripe portal session is only ever minted for the key holder |
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
| **cic-pay** | `admin` role — can credit/debit room pools and issue *matched* clawbacks, but wallet debits still need `clawbackOf` a recorded `credit:<id>` or a client signature: it cannot drain pre-existing wallet balances. It does hold the Stripe key — scope it `rk_` restricted (DEPLOYMENT.md) so a leak can't charge saved cards |
| **Webhook secret** (`whsec_`) alone | Nothing — events are re-fetched from Stripe's API before crediting; forged ids 404, tampered payloads mismatch `data.object.id` |
| **Cloudflare account** | Root — redeploys workers, reads env. Mitigate: 2FA on the account, per-purpose scoped API tokens, `METER_ACL` (hashes only) in place, quarterly rotation per AGENTS.md |
| **User device key** | The wallet — but the key never leaves the device and revocation is one signed call |

Ledger details: callers authenticate `x-meter-token` (hashed in
`METER_ACL`), the claimed `inst` is verified against the DO's own id
(`idFromName` — instance names can't be spoofed), and wallet spends take
the amount from the *signed client body*, not the caller's claim. Clawback
debits are capped by the credit they unwind. Every acct money op lands in
the 50-entry server-side audit ring visible on /billing.

## Honest residual risks

- **Active XSS** can invoke signing while on-origin (CSP + non-extractable
  keys bound this: no exfiltration, no offline use, damage limited to the
  live session and the wallet balance).
- **Lost only device** = lost wallet. There is no recovery seed by design;
  link a second device or accept the limit.
- **Room ticket** is a bearer capability — a past member retains it while
  the room pool stays funded.
- **Sponsored-room drain** — a compromised gateway can spend a *sponsoring*
  wallet against that room's name (≤7200s/call, still under the user's cap);
  it cannot touch wallets that aren't sponsoring.
- **cic-pay + real card charges** — a full Stripe key on a compromised pay
  worker can charge saved payment methods; the restricted-key spec above
  removes that capability entirely.
- Liveness of spend relies on clients honestly reporting usage — the paid
  tier is honest-metering, not adversarial billing isolation.
