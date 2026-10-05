# Compliance Evidence

Compliance certifications (SOC 2, ISO 27001, HIPAA BAA) cannot be shipped in
code — this file is the evidence package an auditor or procurement review
actually reads. It maps what the system *does* to what auditors ask.

## Data flows (what leaves the device, where, under what protection)

| Flow | Protection | Where it lands |
|---|---|---|
| Room media (mesh) | SFrame E2EE, epoch-fenced | peer browsers only |
| Room media (paid SFU) | TLS hop; ciphertext unless edge lane opted in | Cloudflare SFU — never stored |
| Edge denoise (opt-in) | PLAINTEXT by design — visible `edge-processed, not E2EE` badge | cic-dsp DO, frame-scoped only, zero persistence |
| Sensory lane (opt-in) | PLAINTEXT PCM → Speechmatics/AssemblyAI/OpenAI (`SPEECH_PROVIDER`) | provider ZDR terms; worker retains nothing. Deployment modes: SaaS relay (default), SaaS direct (60 s temp JWT — the long-lived key never reaches a browser), on-prem appliance or Speechmatics On-Device local service in a native shell (`SPEECH_BASE_URL` / `VITE_CIC_SPEECH_URL` — same RT protocol, zero third-party egress). The `openai` relay uses the Realtime transcription session (server VAD); the key rides `Sec-WebSocket-Protocol` outbound, never the browser |
| Cloud AI (paid) | ZDR provider terms (ai-gateway stores nothing) | Workers AI default — same CF boundary |
| Recordings | XChaCha20-Poly1305 sealed client-side | R2 ciphertext; key never leaves the room |
| Room secret | URL `#fragment` only — never transmitted | nowhere |
| UX funnel events (opt-in) | enum-only schema, no identity/IP/content; consent + GPC/DNT double-enforced | Analytics Engine `cic_ux_events` (~90d, immutable) |
| Masked session replay (opt-in, in-room only) | all text `•`-masked, inputs/media/transcript/names blocked client-side | R2 `cic-ux-replay`, 30-day lifecycle, admin-gated, revoke deletes |
| Traffic pageview (opt-in) | cookieless Counterscale; sanitized paths (`/room/{code}`→`/room`) | `cic-analytics` worker → AE `cic_web_metrics` + rollups R2 |
| Exit-screen feedback (explicit submit) | user-authored free text + 1–5 rating; permit = attendee's sessionToken | R2 `cic-ux-replay` `feedback/`, 90-day lifecycle, admin-gated |

## Access control

- Ops are Ed25519-signed, epoch-fenced; OPA `cic.rego` evaluates every op
  before application (`src/lib/ops/`).
- `effectiveMuted = selfMuted OR autoMuted OR remotelyMuted` — remote unmute
  is structurally impossible.
- Lobby/admission: `lobby-set` op + `gateView()` waitlist; members only
  admit via signed ops.
- Paid features: `paidEntitled()` — metered D1 account pool when bound
  (paid = `balance_seconds > 0`), purchased-credits ledger locally
  otherwise. Spend heartbeats debit atomically (`/ai/usage`); the pool
  floors at 0 — no over-billing — and depletion stops client-owned paid
  lanes mid-session. Top-ups are Ed25519-signed grants verified against
  `GRANT_PUBKEY` with nonce replay-blocked; the payment rail that mints
  them is operator-decoupled and not yet integrated (no real settlement
  exists today).

## Audit

- Every room state mutation is an entry in the signed op-log;
  `audit/export.ts` produces a verifiable bundle (op list + signatures +
  policy hash) a third party can check without running the app.
- Push/deploy history: wrangler deploys pass a TruffleHog+Trivy+Semgrep
  gate; git pushes pass a Gitleaks pre-push hook (machine-level).

## Zero-retention posture

- ai-gateway: no KV/DO/logging of request bodies; streams through.
- cic-dsp: DO holds only filter coefficients between frames; hibernation-
  compatible, no writes.
- Default cloud providers must be configured for ZDR/no-training.

## Supply chain

- `pnpm licenses:gen` regenerates `docs/OSS-LICENSES.md` (the canonical
  inventory) from the dependency tree — run it on every dependency change
  (verification gate).
- New dependencies require a commercially-usable license listed in
  `docs/OSS-LICENSES.md` and ≥7-day-published versions.
- Project code is AGPL-3.0 — serving the app over the network requires
  offering source; satisfied by the public repo linked in the deployed
  site footer (github.com/circle-co-intelligence/circle-engine). Keep
  that link reachable in any fork/rebrand.

## Remaining gaps (honest)

- SSO/SCIM for *participants* is intentionally absent — room identity is
  pseudonymous by design. Org *admin* surfaces can front Cloudflare Access
  (customer IdP SAML/OIDC) — see DEPLOYMENT.md.
- No formal certification is claimed; this document is the evidence trail.
