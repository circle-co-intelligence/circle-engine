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

## Honest residual risks

- **Active XSS** can invoke signing while on-origin (CSP + non-extractable
  keys bound this: no exfiltration, no offline use, damage limited to the
  live session and the wallet balance).
- **Lost only device** = lost wallet. There is no recovery seed by design;
  link a second device or accept the limit.
- **Room ticket** is a bearer capability — a past member retains it while
  the room pool stays funded.
- Liveness of spend relies on clients honestly reporting usage — the paid
  tier is honest-metering, not adversarial billing isolation.
