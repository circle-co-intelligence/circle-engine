# NOTICE — Provenance & Licensing

`circle-engine` is a standalone, browser-first build of the Co-Intelligence
Circle experience. Its composition is deliberately layered:

## 1. Vendored production frontend — `static/cic/` — PROPRIETARY, NOT OSS

The compiled application bundle in `static/cic/` is the real production
frontend of `circle.co-intelligence.online`, vendored here unmodified as
the visual/interaction source of truth for a self-hosted deployment of the
same product. It is **not open source**. Redistribution or commercial use
outside that context requires authorization from the rights holder.
Vendored modifications, if any, are documented in `docs/DISCREPANCIES.md`.

## 2. Marketing site — `static/site/` — PROPRIETARY, NOT OSS

The static marketing page is the verbatim production page of
`www.co-intelligence.online` with scripts removed (hydration + analytics
have no place in a privacy-preserving build). Same rights note as §1.

## 3. Open-source runtime — npm dependencies

All direct npm dependencies and the transitive tree are commercially usable:
MIT / Apache-2.0 / ISC / BSD / 0BSD / BlueOak-1.0.0 / CC0, plus weak-copyleft
MPL-2.0 (`mediabunny`, `@axe-core/playwright`, `axe-core`), MPL-2.0 OR
Apache-2.0 (`dompurify` — we elect Apache-2.0), CC-BY-4.0 (`caniuse-lite`),
and Apache-2.0 OR MIT (libp2p/waku transitives pulled by `trystero` but not
loaded at runtime — only the `trystero/mqtt` strategy is used).

**No GPL, AGPL, SSPL, or CC-BY-NC dependencies exist in this project.**
Copyleft (weak) is accepted by design; file-level MPL-2.0 obligations apply
only if you modify those packages' own files. Full inventory:
`docs/OSS-LICENSES.md` (regenerate with `pnpm licenses:gen`); vendored license
texts ship in `static/licenses/`.

## 4. Vendored model/runtime assets — `static/models/`, `static/wllama/`

Fetched by `scripts/fetch-models.sh` per `models/manifest.json`:

| Asset | License | Source |
|---|---|---|
| sherpa-onnx wasm runtime + zipformer ASR | Apache-2.0 | k2-fsa/sherpa-onnx |
| Silero VAD | MIT | snakers4/silero-vad |
| Piper `en_US-libritts_r-medium` TTS voice | MIT | rhasspy/piper |
| SmolLM2-360M-Instruct GGUF (Milo + translation) | Apache-2.0 | HuggingFaceTB/SmolLM2, GGUF quantization by bartowski |
| wllama runtime (llama.cpp wasm) | MIT | ngxson/wllama |

Additional asset attributions:

- Piper voice is trained on LibriTTS-R, distributed under CC-BY-4.0
  (corpus: http://www.openslr.org/141/).
- MediaPipe selfie-segmentation model bundled inside
  `@twilio/video-processors` — Apache-2.0 (Google).
- `caniuse-lite` browser data — CC-BY-4.0.
- `static/libarchive/libarchive.wasm` — BSD-2-Clause (libarchive core,
  Tim Kientzle et al.); the JS glue (`libarchive.js`) is MIT.
- `static/dotlottie-player.wasm` — MIT (LottieFiles dotlottie-web).

Font licenses: Lato/EB Garamond/Caveat — OFL-1.1 (text vendored at
`static/licenses/OFL-1.1.txt`); Switzer — Fontshare ITF Free Font License
(see `static/licenses/FONTS.md`).

## 5. Custom code — `src/`

Authored adapter/orchestration code (wire bridge, session engine, local
ledger, translation/account pipes, entry pages) — ~4.5k LOC, i.e. well under
5% of the delivered application (vendored frontend + OSS tree + models).
This code is the project's own contribution.
