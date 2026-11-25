# Cloud deployment

Public instance: <https://pipe-go-doep.aquarat.co.uk>, served by the Cloudflare
Worker `pipe-go-doep`.

## Architecture and build

The public application uses Workers Static Assets plus a small edge discovery API.
The Go synthesis engine is compiled to WebAssembly and runs in dedicated browser
Web Workers. Live playback streams bounded PCM into an AudioWorklet; offline WAV
export uses an independent renderer. Live playback requires HTTPS or localhost;
plain LAN HTTP retains rendered-WAV playback. Projects and rendered audio stay in
the browser. The native Go CLI and LAN server remain supported independently.
There is no server-side synthesis service, database or user data storage.

`node scripts/build-web.mjs` builds `dist/` using Go from `PATH`: HTML, runtime
JS/CSS, example JSON and its sorted index, `synth.wasm`, and the matching Go
toolchain's `wasm_exec.js`. Tests, source maps and Go source are excluded.
CI uses Node 24 and Go 1.27.3. Wrangler is pinned in `package-lock.json`.

```sh
npm ci
npm run check          # Go/JS/actual-WASM bridge tests, build and Wrangler dry-run
npm run dev            # build and local Cloudflare preview on port 8797
```

The edge API in `worker/index.js` provides:

- `GET /api/runtime`: `{"renderer":"wasm"}`.
- `GET /api/examples`: built example index.
- `GET /api/example?name=...`: a single example JSON, with filename validation.
- `POST /api/render` and `/api/validate`: explanatory 501 response; the interface
  performs these operations through the browser worker instead.

All responses pass through the Worker so CSP and cache headers apply consistently.
WASM uses `application/wasm`; CSP permits same-origin worker scripts and WebAssembly
compilation. Stable asset names revalidate. Blob audio playback and same-origin
popup DOM adoption are supported; no COOP browsing-context isolation is enabled.
Missing assets return 404 rather than the app shell. This small Worker-first
middleware means static requests also invoke the Worker.

## Deploying your own copy

1. Change `routes` in `wrangler.jsonc` to a hostname on a zone in your Cloudflare
   account (or remove `routes` and set `"workers_dev": true` for a `workers.dev`
   URL). Wrangler creates the custom domain's DNS record and certificate. Keep the
   entry on later deploys: removing it detaches the domain.
2. Create a Cloudflare API token with **Workers Scripts: Edit** and **Account
   Settings: Read** on the account, plus **Workers Routes: Edit** and **Zone: Read**
   on the zone. Cloudflare's Scripts permission is account-wide.
3. Export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the account ID is
   deliberately not committed), then:

```sh
npm run check
npm exec wrangler deploy
DEPLOYMENT_URL=https://your.host.example npm run verify:deployment
```

Roll back with `npm exec wrangler versions list` and
`npm exec wrangler rollback -- <version-id>`. A lasting rollback should also
revert the source commit and publish that revision.

`npm run verify:deployment` checks the public runtime, CSP, WASM MIME, example APIs,
source exclusions and SHA-256 equality of every static/example asset with `dist/`.
It resolves the host through public DNS (1.1.1.1) to avoid stale local negative
caching immediately after a new domain is created. Browser behaviour is covered by
the optional Playwright suites described in [workbench](workbench.md).

## Continuous integration

Two workflow directories serve different hosts:

- `.github/workflows/ci.yml` (GitHub) runs `npm run check` on pushes and pull
  requests. It needs no secrets and never deploys.
- `.forgejo/workflows/deploy.yml` (the maintainer's Forgejo instance, which
  mirrors `main` to GitHub) runs the same checks, then publishes `main` pushes and
  manual runs when the repository variable `DEPLOY_ENABLED` is `true`. Pull
  requests never publish. It uses the secret `CLOUDFLARE_API_TOKEN` (only in the
  publish step) and the variable `CLOUDFLARE_ACCOUNT_ID`, then runs
  `verify:deployment` against the public URL. Runs for a branch serialize without
  interrupting an in-progress upload. Set `DEPLOY_ENABLED=false` to pause
  publishing, for example before an emergency rollback.

Forgejo uses `.forgejo/workflows` and ignores `.github/workflows` when both
exist, so each host runs only its own workflow.
