# Oscilloscope

The workbench oscilloscope shows live probe signals from the Go engine. It
only observes: probes are `_ui.scope` metadata, and the audio, the live engine
topology and offline WAV output stay the same. The integration contract is
[scope-contract.md](scope-contract.md); this page describes the browser side.

## Probe plumbing (`live-client.js`, `live-worker.js`)

`createLiveTransport({..., onProbe})` adds one method:

- `setProbes(list)` stores the list synchronously. Each entry is
  `{channel, node, port, direction}` or `{channel, bus}`; `[]` clears. The newest
  list wins: repeated calls before the worker is free collapse into one bridge
  `probe` request, and an identical list is ignored. Non-array input reports an
  error and leaves the stored list as it was.
- Probes are sent only while an engine is open. They go on the transport's
  single request queue (before the next seek or read), so they never race PCM
  requests. A fresh worker (first open, or a restart after a timeout or fatal
  error) has no probes, so the stored list is sent right after `open`. An empty
  list is never sent to a fresh engine, so a WASM build without the `probe`
  action keeps working until probes are actually used.
- If the bridge rejects a list (status 400, or an older WASM build), the error
  reaches `onError` as `Oscilloscope probes: …` and playback continues. That
  list is not retried; the next different list is sent normally. If the worker
  dies during the request, that is handled like any other transport failure.
- Every `read` that returns `probe` data of the right length calls
  `onProbe({position, frames, sampleRate, channels, unresolved, data})` for the
  current epoch only. Reads from before a seek, pause or structural update are
  dropped with their PCM. `position` is the first engine frame of the block
  (this is ahead of what you hear by up to about 100 ms), and `data` is a
  `Float32Array` interleaved as `frames × channels.length`.
- The worker transfers the probe buffer along with the PCM buffer (each distinct
  buffer once), so probe data is never copied out of the worker.

## Scope view (`scope-view.js`, `scope-view.css`)

```js
import { createScopeView } from './scope-view.js';
const scope = createScopeView(element, { getPosition, onStateChange, onModeChange });
```

`getPosition()` returns `{frame, sampleRate, playing, live}` for the audible
position, in project sample frames. `live: false` means the transport is in
rendered-WAV mode, or live audio is unavailable; the screen then shows
**Live synth only**.

| Method | Purpose |
| --- | --- |
| `push(block)` | Store an `onProbe` payload. Returns false for a malformed block. |
| `reset()` | Drop all stored probe data. Call it when a new live engine is created. |
| `setInputs({mode, inputs, labels, unresolved})` | Mode (`yt`/`xy`) and patched channels from `_ui.scope`. `labels` maps a channel to a short cable label; `unresolved` lists dangling probes. |
| `setView(state)` | Restore display settings. Does not call `onStateChange`. |
| `refresh()` | Re-measure and rebind to the element's current window (call it after pane adoption or docking). |
| `view` | Snapshot of `{mode, ...display settings}`. |
| `destroy()` | Cancel frames, disconnect observers and empty the element. |

Display settings (browser view state, never `_ui`) are flat so a shallow merge
can persist them: `timebase` (ms/div, 0.05–50), `triggerSource` (`''` = first
patched Y channel, then X), `triggerLevel`, `triggerSlope` (`rising`/`falling`),
`triggerMode` (`auto`/`normal`/`free`), `persistence`
(`off`/`short`/`long`/`infinite`, XY only), and `scales` / `offsets`, which are
objects keyed by channel (value per division, and position in divisions,
±8). `onStateChange(partial)` sends only the keys that changed, but `scales` and
`offsets` are always sent as whole objects. The YT/XY buttons call
`onModeChange(mode)`, which lets the coordinator update `_ui.scope.mode`. The
view switches right away and `setInputs` confirms the change.

### Data

A ring holds about one second per channel (a power of two of at least
`sampleRate` frames), indexed by absolute frame (`frame mod size`). Each slot
also records which frame it holds, so:

- a later block overwrites earlier data for the same frames (loops, seeks,
  scrub grains);
- frames that were never written, or that have been pushed out by newer data,
  read as `NaN` and show as gaps;
- channels missing from a block are cleared for that block's frames.

A change of sample rate reallocates the ring. Nothing is allocated per draw.

### Display

- Two stacked canvases: a 10×8 division graticule with centre-axis ticks, and
  the trace. Both are sized in device pixels (HiDPI). Colours are X white, Y1
  yellow, Y2 cyan, Y3 magenta and Y4 green. Small markers show each channel's
  zero level, the trigger level and the trigger point.
- **YT**: every patched channel against time, including X. The window is
  `10 × timebase` and ends at the audible frame. With a trigger, the latest
  crossing in the chosen direction that still fits before the audible frame is
  placed at the centre of the screen, so periodic signals stand still. In
  **auto** mode the scope runs freely when nothing crosses the level. In
  **normal** mode it holds the last triggered trace and shows "Wait". **free**
  never triggers. Dense windows are drawn as a min/max envelope for each pixel
  column.
- **XY**: each patched Y against X over the same window. Persistence fades the
  older trace by a fixed amount per frame (off clears the trace each frame;
  infinite never fades), and only newly audible frames are added.
- The readouts under each channel show the min and max for the window (at
  least 50 ms) and a frequency estimate, from midpoint crossings with 10 %
  hysteresis. They update at most five times a second.
- Status overlays: **No signal** (nothing patched, or no data yet, with
  "Press Play" or "Waiting for audio…"), **Live synth only**, **Probe
  unresolved** (every patched probe is dangling), **No X signal** (XY mode
  without X). Unresolved channels are marked in their row.
- Drawing runs on the current owner window's `requestAnimationFrame`, and only
  redraws when the audible frame, playing/live state, data, settings or size
  change. When playback is paused the frame stops changing, so the last trace
  stays frozen. Hidden documents do not draw.

### Placement

The view adds `.scope-view` to its element and builds everything inside it.
The element can be moved freely: the rack re-parents it on every render, and
pane windows adopt it into popups. On every frame, `push`, `setInputs`,
`setView` and `refresh`, the view checks `element.ownerDocument.defaultView`.
If the window has changed, it cancels the old frame and moves its
`ResizeObserver` and animation frames to the new window. After a popup closes,
call `refresh()` (or wait for the next `push`) to restart drawing in the main
window.

The screen fills the element's width at a 5:4 aspect ratio.
`--scope-screen-max-height` can cap its height. Controls wrap to fit a
~420 px rack faceplate; above 640 px of container width, each channel's
controls fit on a single row. Control styles are specific enough to override
the generic `.rack-view button/select/input` rules.

## Tests

```sh
node --test internal/workbench/static/scope-view.test.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
node --test internal/workbench/static/scope-view.browser.mjs \
  internal/workbench/static/live-probe.browser.mjs
```

- `scope-view.test.mjs`: ring indexing, overwrite, wrap and eviction; channel
  mapping; malformed blocks; trigger slopes and levels; min/max/frequency;
  YT pixel mapping, gaps and dense envelopes; XY circle geometry.
- `scope-view.browser.mjs`: HiDPI canvas, graticule, colours, readouts, stable
  triggered traces versus free run, frozen trace when paused, control
  persistence, the various states, XY geometry, re-parenting, and adoption into
  and back out of a popup window.
- `live-probe.browser.mjs` runs the real `live-client.js`, `live-worker.js` and
  worklet against a fake JS bridge, so it needs no WASM build. It covers:
  probes sent after open, frame-indexed transferred blocks, latest-wins
  coalescing, clearing, a rejected list that does not stop playback, resending
  after a worker restart, and dropping stale-epoch blocks.
