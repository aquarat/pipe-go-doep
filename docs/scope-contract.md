# Oscilloscope, compact rack and cable labels: integration contract

Date: 2026-11-25 (UTC)

The oscilloscope observes signals without changing the sound. Probe cables are
project UI metadata (`_ui.scope`), so the audio signature, live engine topology
and offline WAV output never change when the scope is patched.

## Components

- Engine: `internal/score/**` (`_ui.scope` schema), `internal/engine/**`,
  `cmd/pipe-go-doep-wasm/**`, `docs/live-engine.md`, `docs/score-format.md`.
- Scope: `static/scope-view.js`/`.css` (new), probe plumbing in
  `static/live-client.js` and `static/live-worker.js`, `docs/scope.md`.
- Rack: `static/rack-view.js`/`.css`, `static/rack-model.js`,
  `docs/rack-visualisation.md`.
- App coordinator: `app.js`, `transport-ui.js`, `index.html`, `workbench.css`,
  `project-state.js`, integration tests and overall docs.

## Probe references and `_ui.scope`

Channels: `x`, `y1`, `y2`, `y3`, `y4`. A probe reference is either

- `{"node": "<node id>", "port": "<port>", "direction": "input" | "output"}`, or
- `{"bus": "left" | "right"}` (stereo output after master gain, before clamping).

An input probe reads the value the module actually used for that sample (patched
signal, or base/default value including live ramps). An output probe reads the
value the module produced.

```json
"_ui": {
  "tree_expanded": ["/nodes"],
  "scope": { "mode": "yt", "inputs": { "y1": {"node": "lead", "port": "out", "direction": "output"}, "x": {"bus": "left"} } }
}
```

`mode` is `yt` (time on X; Y1-Y4 plotted against time) or `xy` (each connected
Y channel plotted against X). Both fields are optional. Go validates shape
strictly (unknown fields rejected, as elsewhere in `_ui`), but a reference to a
missing node/port is **not** a document error: it is a dangling probe, shown as
unresolved, so deleting a module never invalidates a saved project. Display
settings (timebase, scales, trigger, persistence) are browser view state, not
`_ui`.

## Engine and WASM bridge

`Stream.SetProbes(probes)` resolves up to 5 probes (channel + reference) by node
id and port name, returning which channels are unresolved. Probes survive
parameter updates, structural updates (re-resolved against the new patch) and
seeks. Reads record probe values for every produced frame with no per-sample
allocation; seeks produce no probe data.

Bridge `pipeGoDoepStream` additions:

- `probe`: payload `{"probes": [{"channel": "y1", "node": "lead", "port": "out", "direction": "output"}, {"channel": "x", "bus": "left"}]}`.
  Empty list clears. Returns `{status:200, channels:["y1","x"], unresolved:[...]}`.
  Invalid shape/duplicate channel/>5 probes returns 400 without changing state.
- `read`, when probes are set, additionally returns `channels` (same order as the
  last accepted probe call), `probe: Float32Array` interleaved per frame
  (`frames * channels.length`, unclamped finite values; unresolved channels are
  `NaN`), and `unresolved`.
- `open`/`update` keep existing probes (re-resolved); their results include
  `unresolved`.

## Live client

`createLiveTransport({..., onProbe})`:

- `setProbes(list)` (sync) stores the latest list `[{channel, ...ref}]` and sends
  it to the worker immediately if open, and again after every (re)open or worker
  restart. Latest wins; failure reaches `onError` and must not break playback.
- `onProbe({position, frames, sampleRate, channels, unresolved, data})` is called
  for each block read from the engine (ahead of audible playback), only for the
  current epoch. `position` is the first engine frame; `data` is interleaved.
- `state.position` (seconds, consumed/audible) remains the time reference.

## Scope view

`createScopeView(root, { getPosition, onStateChange, onModeChange })` where
`getPosition()` returns `{ frame, sampleRate, playing }` for the audible
position. Returns:

- `push(block)` (the `onProbe` payload): keep a bounded ring (about 1 s per
  channel) indexed by absolute frame; later blocks overwrite earlier blocks for
  the same frames (loops, seeks, grains).
- `reset()`, `setInputs({mode, inputs, labels, unresolved})` where `labels` maps
  channel to a short cable label, `setView(state)`, `refresh()`, `destroy()`.

Behaviour: canvas display with graticule, drawn each animation frame of the
current owner window (works after adoption into popup windows; HiDPI aware).
YT mode: timebase (ms/div), per-channel scale and offset, trigger on a chosen
channel/level/slope with auto/normal/free-run; the window ends at the audible
position. XY mode: each Y against X with phosphor persistence. Channel colours:
X white, Y1 yellow, Y2 cyan, Y3 magenta, Y4 green. Show "No signal" or
"Live synth only" states when nothing is patched, playback is paused before
any data exists, or the transport is in rendered-WAV/insecure-HTTP mode.
`onStateChange(partial)` persists display settings; `onModeChange(mode)` asks
the coordinator to update `_ui.scope.mode`.

## Rack

`createRackView(root, {..., scopeScreen, onProbe})`:

- When `scopeScreen` (an element) is provided, render an **Oscilloscope**
  faceplate (first in the rack, wider than ordinary modules) and move that same
  element into it on every render, so the canvas survives rebuilds. Jacks: X,
  Y1-Y4 inputs, coloured as above.
- Probe cables come from `project._ui.scope.inputs`; draw them distinctly
  (channel colour, dashed) from any module jack (input or output) or the stereo
  output bus jacks to the scope jack. Dangling refs are listed as unresolved.
- Patch by dragging from a scope jack to any module/bus jack, or by dragging an
  existing probe cable's module end to another jack. Dropping on empty space,
  a Remove/Unplug action and Delete/Backspace on a selected probe cable unplug.
  Commit through `onProbe({channel, ref | null})` (boolean or promise, like
  `onReconnect`). Escape cancels. Never mutate `project`.

Compact modules: width is dynamic (Eurorack-style HP derived from controls and
jack counts) and inputs, outputs and controls stack to use space efficiently.
Cable end positions, zoom, focus, popups and existing gestures keep working.

Cable labels: every cable (patch, output bus and probe) carries a short label
following the cable path (SVG `textPath`), kept upright (reverse the label path
for right-to-left cables), for example
`out lead [Pulse oscillator] → in lead_filter [Low-pass]` or
`out lead [Pulse oscillator] → Y1 [Oscilloscope]`. Fit the label to the cable
length (shorten to ports and ids, or hide if still too long); give it a dark
halo for legibility. Selected/hovered cables show labels at full opacity.
