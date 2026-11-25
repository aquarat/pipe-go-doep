# Cloud deployment integration contract

Date: 2026-11-21T19:45:00Z

Public URL: `https://pipe-go-doep.aquarat.co.uk`, Worker `pipe-go-doep`.
Native Go CLI/LAN server remain supported. Public hosting serves static assets
and the same Go engine
compiled to browser WebAssembly, running off the UI thread in a Web Worker.

## Browser backend

`static/render-client.js` exports `synthRequest(action, project): Promise<Response>`.
Action is `validate` or `render`. Local Go `GET /api/runtime` returns
`{"renderer":"server"}`; Cloudflare Worker returns `{"renderer":"wasm"}`.
Native mode POSTs JSON to `/api/<action>`. WASM mode communicates with
`/static/synth-worker.js`, which loads `/static/wasm_exec.js` and
`/static/synth.wasm`. Return Response-compatible HTTP statuses, readable error
text, JSON validate success, or audio/wav bytes with `X-Render-Stats` JSON. Preserve
the existing interactive budgets (2 MiB, <=48 kHz, <=90 seconds, <=128 nodes).
No credentials or remote private host are needed for public rendering.

## Build

`node scripts/build-web.mjs` builds into `dist/` using Go
from PATH, copying only runtime JS/CSS (not tests), HTML and example JSON. It builds
the Go WASM executable and copies the matching toolchain's `wasm_exec.js`. Also
emit `dist/examples/index.json` containing the sorted example filenames.

## Edge Worker

The Worker (`worker/index.js`, configured by `wrangler.jsonc`) serves
GET `/api/runtime`, GET `/api/examples` via `/examples/index.json`,
and GET `/api/example?name=...` via `/examples/<name>` from assets. Other paths are
static assets. `POST /api/render`/validate on the public host can clearly report
that the browser runtime handles these; they need not perform edge synthesis.
Configure appropriate WASM/worker CSP and MIME types, preserve same-origin popup
DOM access, and do not serve source maps, tests or Go source. CI deploys with a
narrowly scoped Cloudflare token, never an account administration token. See
[deployment](deployment.md).
