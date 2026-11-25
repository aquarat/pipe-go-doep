# Live browser transport

`internal/workbench/static/live-client.js` exports
`createLiveTransport({onState, onTime, onError})` using the exact methods and state
shape in [the integration contract](live-transport-contract.md).

## API behavior

- `setProject(project)` synchronously snapshots JSON; subsequent caller mutation
  cannot change the queued score. Equal snapshots are ignored. Metadata-only
  callers can avoid this call using their sound signature.
- `play(seconds?)` and `scrub(seconds)` create/resume the AudioContext directly on
  the calling gesture stack, before any asynchronous work. `endScrub(t, true)` also
  resumes synchronously. Call these directly from the pointer/keyboard handler.
- `play`, `seek`, `scrub`, and `endScrub` return promises resolving **true** when
  applied/primed, **false** when superseded, destroyed, or failed. They do not
  reject. Errors, including asynchronous `setProject` errors, reach `onError`.
- `pause()` and `stop()` synchronously invalidate queued audio; stop also sets the
  position to zero. A five-millisecond output tail prevents abrupt clicks. These
  methods, `seek`, and `setLoop` are safe before the first play; seeking stores the
  position without starting a worker. Sample quantization may adjust a paused
  position by at most half a project sample when the engine acknowledges a seek.
- `scrub(t)` pauses continuous playback and primes an approximately 80ms faded
  grain. `playing` remains false during this preview. Consumed position advances
  through the grain, then returns to its requested anchor. `endScrub(t, resume)`
  performs the final seek and optionally resumes continuous playback.
- `setLoop({enabled,start,end})` uses seconds, clamps the upper boundary to the
  track, and requires a finite positive span of at least a project sample frame.
  Identical loop settings are no-ops, including repeated disabled settings.
  Continuous playback outside an enabled region starts at the loop start. Scrub
  previews can inspect positions outside the loop.
- `state` is a fresh snapshot: `{playing,ready,position,duration,buffering,underruns}`.
  Position and duration are seconds. `ready` means a project has been opened;
  `buffering` covers startup, seeks/replacements, preview priming, and underflow.
  `onTime` follows consumed PCM, not the engine's ahead-of-playback render cursor.
- `destroy()` settles outstanding calls, terminates the worker, disconnects and
  closes the worklet port, and closes its AudioContext. The instance is terminal.

Invalid projects pause and report an error. Supplying a valid project and playing
again recovers. Worker startup and operation deadlines are 30 and 90 seconds;
timeouts/fatal errors terminate that worker, and a later play starts a fresh one.

## Pipeline and bounds

The classic dedicated `live-worker.js` loads `/static/wasm_exec.js` and
`/static/synth.wasm`, then uses only `pipeGoDoepStream`. It has a separate Go runtime
from `synth-worker.js` and the offline renderer. PCM is a transferred, JS-owned
interleaved stereo `Float32Array`, never a view into mutable Go memory.

The client serializes bridge requests, reading at most 2048 source frames per
request. It primes about **100ms** before starting playback and refills below
55ms. `live-worklet.js` imposes an independent **120ms** PCM ceiling and a 32-slot
block ring; the producer also limits outstanding blocks to 24. Tiny loops can
therefore never accumulate unbounded block metadata. The worklet performs stereo
linear interpolation at `projectSampleRate / audioContextSampleRate`, preserving
fractional source phase across block boundaries. This is interpolation rather
than an anti-aliasing filter; ordinary 8–48kHz projects typically upsample into a
48kHz context.

Progress reports contain monotonically consumed source-frame/block counters and
the current block's absolute project position. Reports every 512 output frames
drive refill through the MessagePort, including in hidden tabs; window animation
or polling timers do not drive audio. Timers are used only for failure deadlines.
Underflow emits silence after a short tail, increments a counter once per episode,
and never replays exhausted blocks. Restart, seek, grain edges and loop seams fade
over approximately five milliseconds. Samples are clamped to [-1,1].

Seek, pause, stop, structural replacement and new preview gestures advance an
epoch and flush immediately. Both pending worker results and worklet messages are
checked against the current intent. Only one bridge request can be in flight;
newer gestures coalesce while an exact checkpoint seek is busy. A slow seek shows
buffering rather than permitting old PCM to play.

Parameter-only previews use the same conservative structural comparison as the
engine. They retain already queued audio (at most about 100ms latency) and update
the running engine without seeking, preserving phase, delay/envelope history and
the engine's 8ms parameter ramps. Updates coalesce before subsequent PCM reads;
an older in-flight update cannot generate new PCM after a newer update is pending.
Structural edits instead flush and seek to the consumed position. Invalid updates
flush and pause. See [engine behavior](live-engine.md) for checkpoint invalidation
and exact-seek costs after a parameter edit.

No SharedArrayBuffer, COOP or COEP is used. Same-origin popout panes remain usable.
AudioWorklet requires HTTPS or localhost; the client reports an availability error
on insecure LAN HTTP so the UI can retain its rendered-WAV fallback.

## Verification

After `node scripts/build-web.mjs` has produced `dist/static`:

```sh
node --test internal/workbench/static/live-worklet.test.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chrome \
node --test internal/workbench/static/live-transport.browser.mjs
```

The browser suite serves source transport modules and the existing `dist/static`
WASM/runtime pair on an ephemeral loopback server, under a CSP allowing WASM but
not inline scripts or ordinary eval. It adds no deployed dependency. Tests cover
real gesture unlock, streaming before full-track rendering, 44.1→48kHz playback,
pause/seek/play races, scrub/resume, loop position, invalid edits and recovery,
coalesced state-preserving parameter previews, identical loop no-ops, deliberately
delayed in-flight responses, destroy settlement and fresh-worker retry after
startup hangs, operation hangs and fatal messages. Numerical worklet tests cover
five sample-rate ratios (including 8→48kHz), stereo/phase/block seams, bounded queues, stale epochs,
underflow, grain EOF and discontinuity fades.

Verified in Chromium 1234 on 2026-11-21: **10 browser tests and 5 numerical tests
passed**. Bundled Lantern Duel (49 modules) consumed 2.229s / 91 blocks and Neon
Dojo (75 modules) consumed 2.219s / 97 blocks, both with **zero underruns** and a
maximum observed **100ms** queue. Each then sought backward across retained
checkpoints. These are local smoke measurements, not a cross-device performance
guarantee. The separate full-app test (`internal/workbench/live.browser.mjs`) covers actual analyser output,
controls, and popup adoption.
