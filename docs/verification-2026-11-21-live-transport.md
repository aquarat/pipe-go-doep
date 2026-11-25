# Live playback verification

Date: 2026-11-21 (UTC)

## Engine and runtime

- Native Go tests pass, including block/offline output parity, exact forward/back
  seeks across effects and delay wraps, checkpoint eviction/memory bounds,
  state-preserving parameter ramps, invalid-update atomicity and structural updates.
- The actual Go/WASM bridge tests pass under Node using `npm run test:wasm`.
  The test runner passes only required toolchain/path environment variables because
  Go/WASM's startup argv/environment area cannot hold npm/CI's full environment.
- 32 dependency-free JavaScript tests pass, including numerical resampling,
  bounded queues, stale epoch rejection, underrun recovery, grain and loop fades.
- Web build and Wrangler deployment dry-run pass.

## Browser checks

- 12 score/rack component browser scenarios pass, including real pointer scrubs,
  keyboard seeking, popup gestures and cancelled/throttled live parameter previews.
- 10 transport browser scenarios pass against real Go/WASM, including seek/scrub
  races, parameter updates, loops, worker deadlines/crashes and retry.
- Bundled Lantern Duel (49 modules) and Neon Dojo (75 modules) each consumed more
  than 2.2 seconds with zero underruns and a maximum observed 100 ms source queue
  in local Chromium. This is a smoke measurement, not a cross-device guarantee.
- Full-app tests pass against the real Cloudflare preview/CSP: live PCM observed
  with an analyser; independent WAV export during live playback; pause/seek/scrub;
  loops; live rack previews without premature JSON commits; monitor pop-out/pop-in;
  dirty-source pause/cancellation; capture loss on popup close; source-position
  alignment; stale media-event rejection; and rendered-WAV EOF looping.
- Existing project/tree/pane/rack regressions pass in native and Worker modes.

Reproduce the full-app tests with an existing optional Playwright installation:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chrome \
WORKBENCH_URL=http://127.0.0.1:8797 \
node --test internal/workbench/live.browser.mjs internal/workbench/workbench.browser.mjs
```

Use HTTPS or localhost for live mode. Plain LAN HTTP intentionally retains rendered
WAV playback because AudioWorklet requires a secure context. A distant uncached
seek or structural replacement can briefly buffer while the exact state is rebuilt.
Scrubbing auditions forward grains, not backwards/tape-speed playback.

After CI publication, all four full-app scenarios also passed against the public
HTTPS site. See [deployment](deployment.md) for the release process.
