# Interactive rack and cloud-build verification

Date: 2026-11-21 (UTC)

## Checked before publication

- `go test ./...` and `go vet ./...` passed.
- `npm run check` passed: Go tests, 27 dependency-free JS tests, static Go/WASM
  build and Wrangler 4.166.0 deployment dry-run.
- Rack component: 7 Chromium scenarios passed, including precise parameter reveal,
  drag/keyboard editing, cancellation, source/destination rewiring, fan-out,
  stereo output routing, full rack extent and popup adoption.
- Pane component: 5 Chromium scenarios passed; 8 score unit tests passed.
- Browser renderer: 8 Chromium scenarios passed, including native-identical WAV
  bytes, actual app rendering, off-main-thread responsiveness, interactive budgets,
  concurrency limits and timeout/crash recovery.
- Full app regression passed against native preview `127.0.0.1:8081` and actual
  Wrangler preview `127.0.0.1:8797` with the production CSP. Both full-app scenarios
  passed in WASM mode: identity/view/tree persistence and both musical examples;
  draggable controls, explicit defaults, two-way JSON/rack editing in separate
  windows, valid reconnection, occupied/cyclic rejection, audio preservation,
  close/redock and reload persistence. No page errors or popup CSP violations.
- `git diff --check` passed.

Browser checks use the optional external Playwright installation and Chromium
1234. `internal/workbench/workbench.browser.mjs` accepts `WORKBENCH_URL`,
`PLAYWRIGHT_MODULE` and `CHROMIUM_PATH`. A short `TMPDIR` symlink into the session
directory avoids Chromium's Unix socket pathname limit.

## Interaction boundaries

Cable reconnection is pointer-driven and changes one selected existing route.
Drag endpoints must be visible: automatic edge-scrolling is not implemented.
Rack zoom helps fit distant endpoints; source mode supports arbitrary structural
edits. Numeric dials also support keyboard arrows, Shift fine adjustment and
Escape cancellation. Audio changes become audible after rendering.

After publication, both full-app scenarios also passed against the public HTTPS
site. See [deployment](deployment.md) for the release process.
