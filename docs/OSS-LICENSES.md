# OSS Licenses — commercial-use audit

Generated from `pnpm licenses list` (recursive, dev + runtime). Everything
below is permissive or file-level copyleft; **nothing GPL/AGPL/LGPL ships**.
Re-run the audit when dependencies change:

```bash
pnpm licenses list --json | node -e '/* group by license */'
```

## Runtime dependencies (ship in the bundle)

| License | Packages | Notes |
|---|---|---|
| MIT | trystero, sframe-ratchet, sip.js, libarchive.js, denoise-voice-clarity, qr-code-styling, qr-scanner, webrtc-issue-detector, streamsaver, bits-ui, svelte-sonner, typesafe-i18n, @wllama/wllama, @lottiefiles/dotlottie-svelte, @excalidraw/excalidraw, linkify-it, marked, nanoid, yjs, y-protocols, xstate, zod, msw, svelte, @sveltejs/*, @tiptap/*, @sentry/*, @tanstack/*, lucide-svelte, @noble/*, @tauri-apps/api… | permissive; keep notices |
| Apache-2.0 | emoji-picker-element, @mediapipe/tasks-vision, hls.js, flexsearch, dexie, comlink, @open-policy-agent/opa-wasm, wasm-feature-detect | permissive; NOTICE file required by license |
| BSD-3-Clause | @twilio/video-processors, webrtc-adapter | permissive |
| ISC | ics, did-jwt-vc | permissive |
| MPL-2.0 | mediabunny | file-level copyleft — ship license notice; we don't patch it |
| MPL-2.0 OR Apache-2.0 | dompurify | elect Apache-2.0 |
| CC-BY-4.0 | caniuse-lite (browserslist data) | attribution via this file + NOTICE |

Dev-only deps (playwright, eslint, prettier, vitest, @axe-core/playwright,
axe-core MPL-2.0, typescript…) never ship — no action.

## Bundled assets — separate licenses from code

| Asset | Source | License | Obligation |
|---|---|---|---|
| sherpa-onnx VAD pack (silero-vad) | k2-fsa release | MIT | NOTICE attribution |
| sherpa-onnx ASR zipformer en (v1.13.7 wasm) | k2-fsa release | Apache-2.0 | NOTICE attribution |
| sherpa-onnx TTS `vits-piper en_US-libritts_r-medium` | k2-fsa/piper | MIT voice; trained on LibriTTS-R (CC-BY-4.0) | attribution — already in NOTICE |
| `SmolLM2-360M-Instruct` GGUF | bartowski quant of HF model | Apache-2.0 | NOTICE attribution |
| MediaPipe selfie-segmentation tflite (inside @twilio/video-processors) | Google | Apache-2.0 | NOTICE attribution |
| `static/cic/` + `static/vendor/cic/` vendored production bundle | org's own SaaS frontend | org-owned | keep provenance note here |

## Repo license

Root `package.json` is `AGPL-3.0-only`. It's our own code — AGPL is
compatible with charging for the hosted service since we hold copyright.
If dual-licensing is ever wanted, that decision is the owner's and doesn't
block commercial operation.
