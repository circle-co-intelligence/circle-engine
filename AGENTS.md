# circle-engine — Co-Intelligence Circle

Zero-server, client-only P2P video circle app. SvelteKit (adapter-static, `ssr=false`)
+ Trystero (WebRTC/DC via public relays) + XState (stick machine) + zod (wire protocol)
+ OPA-Wasm (policies) + sframe-ratchet (E2EE) + sherpa-onnx (speech) + wllama (Milo)
+ mediabunny (recording) + Yjs/TipTap (notes) + Dexie (OPFS journal).

## Commands
- `pnpm install` — pnpm 11; `pnpm-workspace.yaml` `allowBuilds` must stay (esbuild/msw/protobufjs).
- `pnpm check` / `pnpm test` / `pnpm build` — must all pass before done.
- `pnpm build:pages` — GitHub Pages deploy build (CIC_BASE=/circle-engine).
- `pnpm build:cf` — Cloudflare Pages deploy build (root base; _headers/_redirects
  + functions/ Pages Functions for /api/ice and /api/sfu are picked up
  automatically).
- `pnpm policy:build` — recompile `src/lib/policy/cic.rego` → `static/policy/cic.wasm` (needs `opa` CLI at ~/.local/bin/opa).
- `pnpm test:e2e` — Playwright, all three engines pass.
  Fedora WebKit workaround (Playwright ships Ubuntu-built WebKit): missing libs
  (icu74, libbacktrace0, libjxl 0.11→symlinked as 0.8, libjpeg.so.8) are extracted into
  `~/.cache/ms-playwright/webkit-*/minibrowser-wpe/lib/` — its wrapper script overwrites
  LD_LIBRARY_PATH, so libs MUST live there, not in a custom path. Run with
  `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`. If Playwright updates webkit-*, re-copy
  libs into the new dir.
  NOTE: browsers may live under `~/.local/share/ms-playwright` (playwright's default
  durable path) — probes run with `PLAYWRIGHT_BROWSERS_PATH=$HOME/.local/share/ms-playwright`.
- `pnpm probe` / `pnpm probe:pw` — multi-page UI probes driving the real production
  frontend (probe-flows.mjs covers captions/recording/breakouts/translation/
  force-mute/account-link/lobby/remove/recordings/password; probe-pw.mjs is the
  focused lobby+password lane). Dev server must be running (`pnpm dev`).
  Probe seams: `window.__cicSend(code, frame)` injects a prod-protocol frame
  through the real RoomSocket dispatch; `window.__cicDebug(code)` returns the
  session's debugView (authority/lobby/waiting + stick/consents/recording/
  streamKeys/epoch) — use it to find the authority page (`self === auth`)
  since manager ops are policy-gated. `window.__cicSession(code)` returns the
  live RoomSession — call engine methods (requestStick/askQuestion/eraseSelf/
  announceStream…) to exercise the real apply/broadcast path. Used by
  e2e/room-real.spec.ts (two-browser real-room convergence tests).
  Prod's Lobby & access UI is gated on canManageRoom (drawer → Options tab).
- `pnpm tauri:dev` / `pnpm tauri:build` / `pnpm build:native` — Tauri native
  shell (src-tauri/). Linux build host needs webkit2gtk4.1-devel etc — see
  docs/DEPLOYMENT.md "Native app". `cargo test --manifest-path
  src-tauri/speechd/Cargo.toml` — local RT speech endpoint tests.
  IMPORTANT: always `pnpm build:native` before `cargo build` so the embedded
  bundle carries VITE_CIC_SIGNAL_WS (the ws signaling lane silently no-ops
  when it's absent — `joinLane` returns null with no warning).
- Linux WebRTC runtime: Fedora's WebKitGTK compiles RTCPeerConnection out.
  The machine-level workaround is a WebRTC-enabled WebKitGTK build at
  `~/webkit-webrt` (prebuilt from manafishrov's webkitgtk-webrtc OCI image,
  install prefix binary-patched from /usr/lib/Manafish/webkit to
  /home/terex/webkit-webrt — equal-length path substitution) plus missing
  deps in `~/webkit-webrtc/deps` (icu74, jpeg8, jxl→0.7 symlinks, woff2) and
  `~/webkit-webrtc/gst-plugins/libgstnice.so` (nicesink/nicesrc — without
  them webrtcbin closes and ICE negotiation dies). Launch via
  `~/bin/circle-webrtc` which sets LD_LIBRARY_PATH + GST_PLUGIN_PATH;
  `~/.local/bin/circle` symlinks to it. Release builds also need
  `cargo build --features custom-protocol`.

## Invariants (do not violate)
- No server code in `cic-core`. Static bundle only.
- `effectiveMuted = selfMuted OR autoMuted OR remotelyMuted` — no remote unmute, ever.
- E2EE is default-on via SFrame; unsupported browser → visible "not E2EE" badge, no silent downgrade.
- Room secret lives in URL `#fragment` — never sent to relays/servers.
- Ops are Ed25519-signed + epoch-fenced; policy denials (cic.rego) reject application.
- Recording/mic capture ends only on explicit ops or last-peer-leave.
- Message/state names must stay compatible with the deployed production bundle — see docs/PROTOCOL.md.

## Verification
`pnpm check && pnpm test && pnpm build && pnpm test:e2e` + gitleaks/semgrep clean.

## Native (Tauri) release builds
Plain `cargo build --release` in `src-tauri/` does NOT embed the frontend —
Cargo.toml's `custom-protocol` feature (`tauri/custom-protocol`) is normally
auto-enabled by the `tauri` CLI; a raw `cargo build` serves `devUrl`/nothing
and the app shows "asset not found: index.html" even though compilation
succeeds cleanly. Always build with:
```
cargo build --release --features custom-protocol
```
Also: `tauri::generate_context!()` embeds `frontendDist` (`../build`) via a
proc-macro file read that Cargo's incremental system does not track —
rebuilding the frontend (`pnpm build:native`) and then `cargo build` again can
silently keep serving the previous frontend snapshot. Force re-embedding by
touching `src-tauri/src/lib.rs` (or `cargo clean -p circle`) before rebuilding
whenever `build/` changed.

### Known WebKitGTK caveat: this runtime is not stable (native parked)
The WebRTC-enabled WebKitGTK 2.48.7 build (`scripts/setup-webkit-webrtc.sh`)
has multiple webrtcbin failure modes, all outside app code:

- Applying a remote offer can stall webrtcbin's `_set_description_task`
  (observed both wedging permanently AND succeeding — timing-dependent).
- `pc.close()` on a PLAYING webrtcbin joins an rtpsession thread that may
  never exit — deadlocks the main thread; >10s → WebKit IPC watchdog
  `crashAfter10Seconds` SIGABRTs the whole WebProcess.
- `addIceCandidate` → `descriptionsFromWebRTCBin` synchronously queries the
  element and can block the same way.
- Its offerer path IS healthy: offers negotiate, ICE/DTLS complete, media
  flows (verified: browser↔native `connected`, inbound audio RTP bytes).

`src/lib/net/wsRoom.ts` therefore carries ALWAYS_INITIATE mode (activated by
`location.protocol === 'tauri:'` or `VITE_CIC_ALWAYS_INITIATE=1`): native
emits a `~`-prefixed sid so it always wins the glare tiebreak, ignores
incoming offers and counter-offers instead (the remote's own tiebreak makes
IT answer), proactively offers on bus `join` frames, and never calls
`pc.close()` — peers are detached and parked (bounded `abandoned` ring)
because closing is itself a crash hazard on this runtime.

Native status: NOT demo-ready. Even with all hazards routed around, the
WebProcess still intermittently aborts under load. The durable fix is a
WebKitGTK build with ENABLE_WEB_RTC=ON built against the host's GStreamer
(or an upstream release that ships it) — the manafishrov image tops out at
2.48.7. Browser↔browser is unaffected by any of this (all quirks are
gated on `alwaysInitiate`) and re-verified end-to-end.
