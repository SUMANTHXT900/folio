# Vendored scanic-ml assets

Self-hosted (same-origin, no CDN) ML detector assets for the scanic integration
(`docs/DECISIONS.md` D33). These files are **byte-identical copies** from the npm
packages pinned below — never edited or rebuilt in this repository. To update,
bump the exact pins in `app/package.json`, reinstall, and re-copy from
`node_modules/scanic-ml/dist/`; update this file in the same change.

## Vendored files (copied from `node_modules/scanic-ml/dist/`)

| file                        |     bytes | SHA-256                                                            |
| --------------------------- | --------: | ------------------------------------------------------------------ |
| `doccornernet_lean.ort`     | 1,925,824 | `732eb8d02d83cc63efb3f9467f01e0c458205a89b2547de3870bc6db1a80c8b3` |
| `ort-wasm-simd-threaded.wasm` | 1,523,774 | `8acb4d26fe0537379e83478e52b20e681035ca70a3eca45f2a147c19e1241f87` |
| `ort-wasm-simd-threaded.mjs`  |    19,531 | `d6841aca121bba413020e1de9009c9e557cc8b424cc4b5d3ebfd8c5e0fec4fce` |

Served at `/assets/scanic-ml/` and precached with the PWA at install
(`app/vite.config.ts`: `globPatterns` includes `ort`; `maximumFileSizeToCacheInBytes`
raised to 10 MB per D33). Load via `scanDocument(image, { detector: 'ml',
ml: { assetBaseUrl: '/assets/scanic-ml/' } })`.

## Versions

- **scanic 1.6.0** — exact pin (`"scanic": "1.6.0"` in `app/package.json`).
  Classical detection + perspective warp + corner editor; its ESM build bundles
  the ONNX Runtime Web JS used to run these assets.
- **scanic-ml 0.2.0** — exact pin (`"scanic-ml": "0.2.0"` in `app/package.json`).
  Source of the three files above (npm tarball contains only `dist/`, `README.md`,
  `MODEL_CARD.md`, and `package.json`).
- **Model** — DocCornerNet LEAN, channel-slimmed SimCC corner detector
  (456K params, 2.3 px median error / 0.892 IoU on the 200-image `dcd_test`
  set per `MODEL_CARD.md`; architecture from DocCornerNet-CoordClass).
- **ONNX Runtime / ABI note** — two upstream facts must both be recorded because
  they do not agree:
  - The vendored wasm was compiled from **ONNX Runtime v1.23.2** (stated in
    scanic-ml 0.2.0's README; the `1.23.2` version string is also embedded in
    `ort-wasm-simd-threaded.wasm`). The same README declares the
    `onnxruntime-web` JS peer ABI as **1.23.x** ("the JS/wasm ABI is
    version-locked").
  - `scanic` 1.6.0's bundled ONNX Runtime JS reports **1.27.0**
    (`env.versions.common` in `dist/scanic-ort.wasm.min.js`); the ESM build
    bundles that JS, so the shipping pairing is ORT JS 1.27.0 + this 1.23.2-built
    wasm. **Verified 2026-10-04** with the vendored bytes (Node smoke test):
    ORT JS 1.27.0 initialized the 1.23.2-built wasm, created an
    `InferenceSession` from `doccornernet_lean.ort`, and ran 1-thread inference
    (~19 ms); `scanDocument(image, { detector: 'ml' })` completed with corners
    and score through scanic's public API. The version skew is benign at the
    session/inference level; browser + real-device validation still pending
    (canonical E2E and the field gate).
- **Threading** — the wasm is pthread-capable but runs on **1 thread** by default
  with no COOP/COEP headers (the Folio default; ~13 ms inference). Requesting
  `threaded: true` needs cross-origin isolation and is a later optional decision
  (D33), never a blocker.

## License notice (vendored copies)

MIT License — Copyright (c) 2025 marquaye.
`scanic-ml` 0.2.0 declares `"license": "MIT"` in its `package.json` but ships no
standalone LICENSE file; the text below is copied **verbatim** from the
repository's `LICENSE` file as published in `scanic` 1.6.0 (`node_modules/scanic/LICENSE`),
which covers the `scanic` and `scanic-ml` packages at
<https://github.com/marquaye/scanic>. Keep this notice with the vendored copies.

```text
MIT License

Copyright (c) 2025 marquaye

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
