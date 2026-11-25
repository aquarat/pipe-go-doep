# Browser Go renderer

This page describes offline WAV export. Live playback uses a separate worker and
the incremental bridge in the same binary; see [live engine](live-engine.md) and
[live transport](live-transport.md). Export and live playback retain independent
engine state.

The static workbench renders entirely in a dedicated Web Worker using the same
`internal/score.Parse`, `internal/engine.Compile` and `internal/engine.Render`
as the native CLI and LAN server. There is no JavaScript synthesizer or remote
render service. Edits stay responsive while Go runs off the main browser thread.

## Build and assets

```sh
node scripts/build-web.mjs
```

Requires Node.js and Go (module minimum Go 1.23) on `PATH`. The script recreates
`dist/`, copies the workbench HTML, runtime JS/CSS and example JSON, and emits a
sorted `examples/index.json`. Test scripts and source maps are excluded. It builds
`cmd/pipe-go-doep-wasm` with `GOOS=js GOARCH=wasm` and copies the **same toolchain's**
`GOROOT/lib/wasm/wasm_exec.js`, falling back to `misc/wasm/wasm_exec.js` for Go 1.23.
Publish the WASM and runtime JavaScript together. The command's `js && wasm` build
constraint leaves native `go test ./...` and CLI builds unaffected.

Serve `static/synth.wasm` as `application/wasm`, JS as JavaScript and CSS as CSS.
The worker uses ArrayBuffer instantiation, so a development server's incorrect
WASM MIME does not itself prevent loading. Static hosting also supplies the API
routes in [the deployment contract](cloud-deployment-contract.md).

## Editor interface

```js
import { synthRequest } from './render-client.js';
const response = await synthRequest('render', project);
if (!response.ok) throw new Error(await response.text());
const stats = JSON.parse(response.headers.get('X-Render-Stats'));
const wav = await response.blob();
```

`synthRequest(action, project): Promise<Response>` accepts `validate` or `render`.
Its first call fetches `GET /api/runtime`; successful detection is cached for the
page. `{"renderer":"server"}` preserves JSON HTTP POSTs to `/api/<action>`.
`{"renderer":"wasm"}` lazily starts `/static/synth-worker.js`. Failed detection
can be retried. Validation returns `{"valid":true}`; rendering returns stereo
PCM16 `audio/wav`, `X-Render-Stats` and a WAV attachment filename. Invalid scores
return readable 400 response bodies. Runtime/worker failures reject the Promise.

The browser accepts at most 2 MiB of UTF-8 JSON, 48 kHz, 90 seconds including tail,
and 128 nodes. Go rechecks the byte cap and interactive budgets before compiling
or rendering, in addition to every existing score/graph validation rule. Only one
operation per page runtime is accepted, including startup; concurrent requests
receive 429 rather than retaining an unbounded score queue.

Runtime discovery and worker startup each have a 30-second deadline. An operation
has a 90-second main-thread deadline. A timeout, worker error, message decoding
failure or Go exit terminates the worker and rejects the pending Promise; the
next call creates a fresh worker. This main-thread watchdog remains effective
even if synchronous Go work prevents the worker's own timers from firing. Go's
render context also has its native 90-second deadline. Score errors leave the
healthy worker available for reuse.

## Worker protocol and ownership

The classic worker imports `wasm_exec.js`, instantiates the WASM binary and starts
Go. Go retains exactly one `js.Func` for its lifetime and publishes the synchronous
worker-local bridge `pipeGoDoepRequest(action, jsonString)`. The worker sends
`{type:'ready'}` only after that bridge exists. The UI sends
`{type:'request', id, action, json}`; replies are
`{type:'result', id, status, contentType, body, stats?, error?}`. Fatal runtime
failure uses `{type:'fatal', error}`.

Go copies WAV bytes from its linear memory into a fresh `Uint8Array`; the worker
transfers that array's `ArrayBuffer` to the page. No detached Go-memory view or
per-render callback is retained. Request timers and Promise callbacks are cleared
when settled. The Go heap is reused between requests; terminating the worker
reclaims its complete runtime. A maximum-size WAV is about 17.3 MB, with additional
temporary Go/JS copies and DSP graph storage during rendering.

## CSP

At minimum, add these directives to the application's existing policy, including
the response serving the worker script:

```text
script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'
```

No JavaScript `unsafe-eval`, blob workers, cross-origin isolation or third-party
origins are required. Existing audio playback needs `media-src 'self' blob:`.
Existing dynamically positioned controls need the application's inline-style
allowance. Preserve same-origin popup access for detachable panes. The browser
checks run with a CSP that disallows inline scripts and ordinary eval.

## Verification

```sh
go test ./...
node scripts/build-web.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chrome \
node --test scripts/browser-renderer.test.mjs
```

The optional browser suite uses an existing Playwright installation and transient
loopback HTTP servers. It compares a real Chromium worker's WAV byte-for-byte with
native CLI output for a shortened bundled composition; checks stats, readiness,
UI timer responsiveness, budgets, concurrency and cached backend selection;
exercises the built application's check/render controls; and injects startup
hangs, infinite worker loops, crashes and fatal messages to verify rejection and
fresh-worker recovery. Injected deadlines are shortened only in test-served JS.
On Linux, keep `TMPDIR` short enough for Chromium's Unix-domain socket pathname;
a short symlink to a longer temporary directory works without moving its data.
