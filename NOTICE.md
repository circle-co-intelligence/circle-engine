# NOTICE — Provenance & Licensing

`circle-engine` is a standalone, browser-first build of the Co-Intelligence
Circle experience. Its composition is deliberately layered:

## 1. Vendored production frontend — `static/cic/` — PROPRIETARY, NOT OSS

The compiled application bundle in `static/cic/` is the real production
frontend captured from `circle.co-intelligence.online` (see
`site-mirrors/cic-app/`). It is **not open source**. It is vendored here as
the visual/interaction source of truth for a self-hosted deployment of the
same product. Redistribution or commercial use outside that context requires
authorization from the rights holder. The vendored bundle is unmodified
except where documented in `docs/DISCREPANCIES.md`.

## 2. Marketing site — `static/site/` — PROPRIETARY, NOT OSS

The static marketing page is a verbatim capture of
`www.co-intelligence.online` (HTTrack mirror in
`site-mirrors/co-intelligence/`) with scripts removed (hydration + analytics
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
`LICENSES.md`.

## 4. Vendored model/runtime assets — `static/models/`, `static/wllama/`

Fetched by `scripts/fetch-models.sh` per `models/manifest.json`:

| Asset | License | Source |
|---|---|---|
| sherpa-onnx wasm runtime + zipformer ASR | Apache-2.0 | k2-fsa/sherpa-onnx |
| Silero VAD | MIT | snakers4/silero-vad |
| Piper `en_US-libritts_r-medium` TTS voice | MIT | rhasspy/piper |
| SmolLM2-135M-Instruct GGUF (Milo + translation) | Apache-2.0 | HuggingFaceTB/SmolLM2 |
| wllama runtime (llama.cpp wasm) | MIT | ngxson/wllama |

Font licenses: Lato/EB Garamond/Caveat — OFL-1.1; Switzer — Fontshare
free license.

## 5. Custom code — `src/`

Authored adapter/orchestration code (wire bridge, session engine, local
ledger, translation/account pipes, entry pages) — ~4.5k LOC, i.e. well under
5% of the delivered application (vendored frontend + OSS tree + models).
This code is the project's own contribution.
