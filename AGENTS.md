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
  session's authority/lobby/password/waiting view — use it to find the
  authority page (`self === auth`) since manager ops are policy-gated.
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
