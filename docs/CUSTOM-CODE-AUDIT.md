# Custom-Code Audit — OSS Disposition

Goal: the ~20k authored LOC contains **no bespoke mechanism where a
commercially-usable OSS equivalent exists**, while preserving all
functionality and protocol compatibility. Copyleft is permitted. Every
remaining hand-rolled mechanism is either protocol-security-sensitive or
product-specific; each has a written disposition below so the claim is
auditable rather than asserted.

License/usage enforcement is automatic: `pnpm licenses:gen`
(`scripts/licenses.mjs`) fails if a declared dependency has no importer in
authored source and no documented `RESERVED` reason. The generated table in
`docs/OSS-LICENSES.md` → "Dependency usage map" is the live evidence.

## Measured footprint (post-refactor)

| Area | Non-test LOC | Test LOC |
|---|---:|---:|
| `src/` | 13,474 | 1,016 |
| `workers/` | 3,090 | 994 |
| `functions/` | 606 | 307 |
| `scripts/` | 675 | — |
| `src-tauri/` | 393 | — |
| root probes/configs | 1,772 | — |
| `e2e/` | — | 251 |
| **Total** | **~20,000** | **~2,600** |

Net LOC is roughly flat versus the pre-refactor ~19,900: removals were
offset by schema declarations and imports. The reduction is in
*bespoke-mechanism surface* — ~10 mechanisms moved to maintained OSS —
not in raw line count, because protocol shapes and product logic remain.

## Swapped to OSS (custom mechanism deleted)

| Mechanism | Was | Now | LOC effect |
|---|---|---|---|
| Yjs doc sync mux | hand-rolled message framing in `src/lib/notes/notes.ts` | `y-protocols` + `lib0` standard sync protocol | −~40 |
| IndexedDB key store | raw `indexedDB` open/transaction boilerplate, `src/lib/crypto/accountKey.ts` | `dexie` typed store | −~25 |
| Base64/base64url | 5 hand-rolled `atob`/`btoa`/`Buffer` shims (`ai/cloud`, `bridge/push`, `bridge/stt`, `crypto/accountKey`, `net/wsRoom`) | `@scure/base` `base64urlnopad`/`base64` | −~20 |
| CF Access JWT verify | hand-rolled JWKS fetch + RS256 verify, `workers/ai-gateway` | `jose` `createRemoteJWKSet`/`jwtVerify` | −~45 |
| VAPID JWT | hand-rolled ES256 JWT assembly, `workers/push` | `jose` `SignJWT` | −~30 |
| Join retry | hand-rolled attempt/sleep loop, `src/lib/net/room.ts` | `exponential-backoff` `backOff` | −~15 |
| User-agent parse | ~18 lines of UA regex | `ua-parser-js` | −~15 |
| Request validation | hand-rolled field checks, `functions/api/feedback.ts`, `functions/api/ux/[[path]].ts` | `zod` schemas | +~40 (schemas cost lines but gain machine-checked validation + types) |
| WebSocket-like event surface | custom listener map, `src/lib/bridge/localSocket.ts` | `extends EventTarget` | −~20 |

## Evaluated → kept custom (with reason)

| Candidate package | Site | Verdict |
|---|---|---|
| `@speechmatics/real-time-client` | `src/lib/speech/sensory.ts` | Only fits direct mode (~20 LOC); default path is our own `cic-dsp` relay contract — SDK would add a dependency while keeping all relay code. Kept custom. |
| `sdp-transform` | SDP canonicalization | Custom regex rewrite is intentionally state-free and protocol-shape-sensitive; parse→serialize round-trip loses canonical control. Kept custom. |
| `p-queue` | `src/lib/bridge/stt.ts` | Finals/partials starvation-avoidance is product-specific, not a generic FIFO. Kept custom. |
| `stripe` SDK | payment workers | Deliberate trust boundary: Payment Links + read-only restricted key mean *no* Stripe API surface is used by design — an SDK would widen the credential's power without shrinking code. |
| `did-jwt-vc` | `workers/ai-gateway` | Needs DID resolution; we verify RS256 against CF Access JWKS. `jose` used instead. |
| `@block65/webcrypto-web-push` | `workers/push` | Implements RFC 8291 payload encryption we don't need (empty-payload pushes). `jose` used instead. |
| `comlink` | speech/AI workers | Evaluated; manual `postMessage` RPC is already thin and type-matched to the worker contract. Kept. |
| `streamsaver` | recording download | Our downloads return playable object URLs and small JSON/ICS blobs — no streaming-to-disk path exists. Removed. |
| `msw` | tests | Function tests use real runtime env stubs; e2e uses Playwright route interception. No gap. Removed. |
| `webrtc-issue-detector` | media adaptation | Our adaptation loop is driven by SFU stats we already compute; the detector targets browser-bug sniffing we don't do. Removed. |
| `wasm-feature-detect` | `@wllama` init | Feature checks are 2 inline `typeof` guards. Removed. |

## Removed (verified unused, zero importers)

`nanoid`, `comlink`, `wasm-feature-detect`, `streamsaver`, `did-jwt-vc`,
`sdp-transform`, `@speechmatics/real-time-client`,
`@block65/webcrypto-web-push`, `bits-ui`, `lucide-svelte`, `svelte-sonner`,
`@tanstack/svelte-virtual`, `@lottiefiles/dotlottie-svelte`,
`typesafe-i18n`, `emoji-picker-element`, `qr-scanner`, `linkify-it`,
`dompurify`, `marked`, `flexsearch`, `msw`, `webrtc-issue-detector`

(`qr-code-styling` retained — referenced by `svelte.config.js` CSP config.)

## Custom code that stays — and why it can't be delegated

These are the mechanism-bearing modules; each is either security-protocol
code where third-party substitution would change trust semantics, or
product logic with no OSS counterpart:

- `src/lib/crypto/*` — Ed25519-signed ops, epoch fencing, SFrame wiring.
  Already on `@noble/*` + `sframe-ratchet`; the *protocol assembly* is the
  security boundary and must stay authored.
- `src/lib/policy/engine.ts` — OPA wasm evaluation glue (already
  `@open-policy-agent/opa-wasm`); the op schema is ours.
- `src/lib/bridge/*` — the zero-server compatibility layer that mimics the
  production bundle's contract. By definition bespoke — it *is* the
  protocol.
- `workers/*` MeterBus/settlement signing — billing trust boundary; the
  signing scheme is our security control.
- `functions/api/*` — thin endpoint shells; remaining lines are route glue
  around `zod` schemas and R2/AE bindings.
- Speech/STT routing (`sensory`, `stt`, `enhance`) — product-specific
  provider abstraction with relay + direct modes.
- `scripts/*` — build/license tooling; `licenses.mjs` is itself the audit
  mechanism.
- Tauri shell + `speechd` — platform glue; already delegates everything it
  can (tauri plugins, system WebKitGTK).

## Re-running the audit

```bash
pnpm licenses:gen   # regenerates inventory + usage map; fails on unused deps
node scripts/licenses.mjs 2>&1 | rg 'unused'  # empty = clean
```

Any future dependency addition that isn't imported in authored source or
justified in `RESERVED` fails generation — zombie deps cannot accumulate.
