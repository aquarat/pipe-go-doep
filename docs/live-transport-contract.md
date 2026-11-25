# Live browser transport contract

Date: 2026-11-21 (UTC). Follow-up to browser Go/WASM renderer.

## Components

- Engine: `internal/dsp/**`, `internal/engine/**`, `cmd/pipe-go-doep-wasm/**`.
- Transport: `static/live-client.js`, `static/live-worker.js`, `static/live-worklet.js`.
- Gestures: `score-view.js`/`.css` and `rack-view.js`.
- App coordinator: `app.js`, `transport-ui.js`, HTML/styles, native server assets.

## WASM bridge

Preserve existing offline `pipeGoDoepRequest`. Add synchronous worker-only
`pipeGoDoepStream(action, jsonString)` returning an object with `status` and
`error` on failure. One live engine per dedicated worker, independent of export.

- `open`: payload project JSON. Compile fresh, enforce same interactive limits;
  return `{status:200,sampleRate,frames,position:0}` (positions in sample frames).
- `read`: payload `{frames:2048}`; at most 8192 frames. Return
  `{status:200,position,frames,sampleRate,done,body:Float32Array}`. `position` is
  first frame, `frames` actual count, body interleaved stereo clamped [-1,1].
- `seek`: `{frame:N}`. Restore nearest bounded engine-state checkpoint and
  simulate forward; return `{status:200,position}`. Exact deterministic state,
  including sequence, envelope, noise and delay memory. Checkpoints capped by
  memory and count; no all-track PCM allocation.
- `update`: payload new project JSON. Validate before mutation; if topology,
  score/timing/seed/sample-rate unchanged, update parameters preserving current
  DSP state and smoothly ramp continuous numeric controls. Invalidate previous
  checkpoints; future seeks reconstruct the latest project from zero. Otherwise
  compile replacement and fast-forward to current equivalent time (clamped).
  Return `{status:200,position,sampleRate,frames}` (frames total duration).
- `close`: clear retained engine/checkpoints; `{status:200}`.

## Main-thread transport

`createLiveTransport({onState,onTime,onError})` from `live-client.js` returns:

- `setProject(project)` sync method: store clone/snapshot and queue latest update
  if a session is open. Metadata-only callers can skip using soundSignature.
- `play(seconds?)` async; create/resume AudioContext immediately in user gesture,
  lazily start dedicated WASM worker and AudioWorklet, prime bounded queue then play.
- `pause()` sync, `stop()` sync (pause + rewind), `seek(seconds)` async.
- `scrub(seconds)` latest-wins async preview ~80ms faded grain, paused continuous
  stream; `endScrub(seconds,resume)` final seek and optional resume.
- `setLoop({enabled,start,end})` times in seconds; enforce finite valid span.
- `destroy()` closes worker, AudioContext, timers/listeners and pending operations.
- `state` getter `{playing,ready,position,duration,buffering,underruns}` in seconds.

Callbacks onState receives state, onTime seconds, onError readable message.
Maintain epochs so stale blocks/updates cannot play after seek/pause/project
replacement. AudioWorklet consumes transferred bounded PCM blocks (no SAB/COOP
required), resamples if context rate differs, reports consumed transport position,
requests refill via port so hidden-tab timers do not drive playback. Underflow
silences/ramp and reports instead of replaying old blocks. Keep worklet allocation
and messaging outside per-sample loops. Coalesce knob/project updates; errors
must settle operations and allow retry. Loop transitions and scrub grains fade.

## Visual callbacks

Score `createScoreView` adds `onScrub(seconds,{phase:'start'|'move'|'end'|'cancel'})`.
Ruler drag uses pointer capture/current owner window; click and keyboard seek
remain available. Pointer cancel/Escape ends safely. No onSeek duplicate on drag.

Rack adds `onPreviewParameter(change)` on pointer movement (throttled), and
`onCancelParameter(change)` with original value on cancellation. Existing
onEditParameter remains single commit on release; coordinator previews audio only,
not source persistence. Finish/release capture before callbacks can rebuild DOM.

## Native/public hosting

Public Worker serves build output unchanged; no infrastructure architecture change.
Native server can serve synth.wasm/wasm_exec.js from `dist/static` when built, with
WASM CSP. AudioWorklet requires HTTPS or localhost; LAN HTTP retains rendered WAV
playback and seeking with a clear live-mode availability message.
