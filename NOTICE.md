# NOTICE — Provenance & Licensing

`circle-engine` is a standalone, browser-first build of the Co-Intelligence
Circle experience. Its composition is deliberately layered:

## 1. Vendored production frontend — `static/cic/` — org-owned, AGPL-3.0

The compiled application bundle in `static/cic/` is the real production
frontend of `circle.co-intelligence.online`, vendored here unmodified as
the visual/interaction source of truth for a self-hosted deployment of the
same product. It is org-owned and licensed **AGPL-3.0** (see
`static/cic/LICENSE.txt` + `static/cic/NOTICE.txt`) — commercially usable
under copyleft terms, same as the project license. This is a compiled
artifact; the preferred form for modification is the org's frontend
source repository. Vendored modifications, if any, are documented in
`docs/DISCREPANCIES.md`. Sibling stylesheet chunk: `static/vendor/cic/`
(same license, see `static/vendor/LICENSE.txt`).

## 2. Marketing site — `static/site/` — org-owned, AGPL-3.0

The static marketing page is the verbatim production page of
`www.co-intelligence.online` with scripts removed (hydration + analytics
have no place in a privacy-preserving build). Same licensing as §1 —
AGPL-3.0, see `static/site/LICENSE.txt` + `static/site/NOTICE.txt`.
Bundled fonts keep their own licenses (see §4).

## 3. Open-source runtime — npm dependencies

All direct npm dependencies and the transitive tree are commercially usable:
MIT / Apache-2.0 / ISC / BSD / 0BSD / BlueOak-1.0.0 / CC0, plus weak-copyleft
MPL-2.0 (`mediabunny`, `@axe-core/playwright`, `axe-core`), MPL-2.0 OR
Apache-2.0 (`dompurify` — we elect Apache-2.0), CC-BY-4.0 (`caniuse-lite`),
and Apache-2.0 OR MIT (libp2p/waku transitives pulled by `trystero` but not
loaded at runtime — only the `trystero/mqtt` strategy is used).

**No GPL, SSPL, or CC-BY-NC third-party dependencies exist in this project**
(AGPL-3.0 applies to this project's own code and vendored org bundles —
copyleft is accepted by design). File-level MPL-2.0 obligations apply
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

## 5. Custom code — `src/`, `functions/`, `workers/`, `scripts/`, `e2e/`, probes

Authored adapter/orchestration code (wire bridge, session engine, local
ledger, translation/account pipes, entry pages, edge workers, Pages
Functions) — ~19k runtime LOC (+~44k tests/e2e/probes), i.e. under 5% of
the delivered application measured by authored LOC vs the vendored
frontend + OSS dependency tree + model/runtime assets. Measured by shipped
bytes, **0%** of the deployed bundle is non-OSS — every shipped component
is either third-party OSS or org-owned AGPL-3.0. This code is the
project's own contribution, AGPL-3.0 under the root `LICENSE`.
