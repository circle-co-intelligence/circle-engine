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
- `pnpm tauri:dev` / `pnpm tauri:build` — Tauri native shell (src-tauri/).
  The shell serves the deployed site (`frontendDist` is the production URL,
  not an embedded bundle) so the desktop app always matches the website —
  no frontend rebuild needed for releases. `CIC_WEB_URL` overrides the URL
  at runtime (preview deploys, local dev). `remote.urls` in
  src-tauri/capabilities/default.json allowlists the site's domain for
  `invoke`/`deep-link` IPC; add any new *.pages.dev hostname there if the
  site moves. Linux build host needs
  webkit2gtk4.1-devel etc — see docs/DEPLOYMENT.md "Native app" (host may
  lack -devel pkgs: a `circle-native-build` podman image built from
  /tmp/circle-build/Containerfile reproduces them; run cargo inside it with
  --userns=keep-id + ~/.cargo + ~/.rustup mounted). `cargo test
  --manifest-path src-tauri/speechd/Cargo.toml` — speech endpoint tests.
- Linux WebRTC runtime: Fedora's WebKitGTK compiles RTCPeerConnection out
  (verified 2.52.1 — settings API exists but the JS binding stays hidden
  even with webrtcbin/nice/dtls/srtp elements all present).
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
`frontendDist` is a remote URL — the binary never embeds the frontend, so a
plain `cargo build --release` is sufficient and there is no stale-bundle
hazard (`generate_context!` no longer reads `../build`). The
`custom-protocol` feature is retained in Cargo.toml but is now a no-op.
Frontend changes ship by deploying the site; the shell only needs a rebuild
when src-tauri/ itself changes (speechd, deep-link, WebRTC flags).

Build on hosts without -devel packages via the `circle-native-build`
podman image (Containerfile: /tmp/circle-build/Containerfile):
```
podman run --rm --userns=keep-id \
  -v "$PWD:/src:Z" -v ~/.cargo:/cargo-home:Z -v ~/.rustup:/rustup:Z \
  -e CARGO_HOME=/cargo-home -e RUSTUP_HOME=/rustup \
  -e PATH=/cargo-home/bin:/usr/bin:/bin \
  circle-native-build cargo build --release --features custom-protocol \
  --manifest-path /src/src-tauri/Cargo.toml
```

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
`window.__TAURI_INTERNALS__` present, `location.protocol === 'tauri:'`, or
`VITE_CIC_ALWAYS_INITIATE=1`): native
emits a `~`-prefixed sid so it always wins the glare tiebreak, ignores
incoming offers and counter-offers instead (the remote's own tiebreak makes
IT answer), proactively offers on bus `join` frames, and never calls
`pc.close()` — peers are detached and parked (bounded `abandoned` ring)
because closing is itself a crash hazard on this runtime.

Native status: native↔browser production join verified end-to-end via
`probe-native.mjs` (browser + Tauri shell in the same live room —
`ws welcome`/TURN, `sfu conn connected`, peer visible in the mesh, remote
audio+video streams arriving). Test hooks in the shell, all env-gated:
`CIC_WEB_URL` (frontend URL, all platforms), `CIC_AUTOJOIN` (clicks the
join form), `CIC_MOCK_CAPTURE` (synthetic cam/mic), `CIC_SELFTEST`
(logs Tauri-bridge/speechd/RTC probes to stderr),
`WEBKIT_INSPECTOR_SERVER`. Cam/mic permission requests from the loaded
site are auto-allowed in Rust (connect_permission_request →
UserMediaPermissionRequest.allow) — the GTK infobar is bypassed.
libnice hard-caps TURN servers per agent
(NICE_CANDIDATE_MAX_TURN_SERVERS); /api/ice returns 6 turn/turns URLs so
`limitTurnUrls` in net/room.ts trims to one URL per transport family
(TLS/udp/tcp) under the Tauri shell only — the assert that killed the
WebProcess mid-gather is routed around. Remaining caveat: this runtime
can still abort the WebProcess under load — the durable fix is a
WebKitGTK build with ENABLE_WEB_RTC=ON against the host's GStreamer (or
an upstream release that ships it) — the manafishrov image tops out at
2.48.7. Browser↔browser is unaffected by any of this (all quirks are
gated on `alwaysInitiate`/Tauri detection) and re-verified end-to-end.
