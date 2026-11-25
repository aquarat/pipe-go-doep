# Streaming browser playback and state-aware navigation

Date: 2026-11-21T20:25:31Z
Status: accepted

## Context

The maintainer approved live playback, draggable seeking, live controls and audible
scrubbing. The previous browser runtime rendered a complete WAV before playback.
Keep the Go synthesis engine, existing native/offline export and same-origin
detachable panes.

## Decision

Run a separate incremental Go/WASM engine in a dedicated worker. Transfer bounded
stereo float blocks to an AudioWorklet, which resamples to the device rate and
reports the consumed position. Refill from worklet messages rather than relying
on main-window animation/timer frequency. No shared-memory or cross-origin
isolation requirement is introduced, preserving popup DOM access.

The live engine owns sequence and DSP state, supports block reads and stores
bounded deep-copy checkpoints. Seek restores a checkpoint and simulates forward;
it does not approximate active envelopes or discard effect history. Missing
checkpoints require replay from an earlier state. Parameter changes preserve
compatible state and smooth continuous values; structural changes reconstruct a
validated replacement at the current time. Past checkpoints are invalid after
musical edits. The latest project defines the sound when seeking backwards.

A common monitor transport chooses Live synth or Rendered WAV. The position
slider, waveform and score ruler support dragging; live scrub previews use short
faded forward grains at the requested time. They are not reverse tape playback.
Release resumes only if playback was active before the gesture. Loop boundaries
are editable in beats. Rack drag previews affect live audio without persisting
every intermediate value; release commits and cancellation restores the project.

## Consequences

Playback can start without generating a full-track PCM/WAV buffer. Offline export
remains deterministic and uses a separate worker/server request, independent of
live preview. Live changes incur the bounded playback queue's latency. Far seeks
without checkpoints or structural edits can briefly buffer while Go reconstructs
state. A device that cannot synthesize fast enough may underrun; report that state
instead of repeating stale audio.

AudioWorklet needs HTTPS or localhost and a user gesture to start audio. Plain
LAN HTTP retains the rendered-WAV transport. Native localhost live mode serves
the matching generated WASM/runtime pair from `dist/static` after the web build.
