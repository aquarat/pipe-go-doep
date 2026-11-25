# Architecture

Updated: 2026-11-21

## Three independently evolvable stages

1. **Storage and musical intent** (`score`): strict versioned JSON, reusable ordered
   patterns, pitch conversion and absolute beat-to-sample scheduling. A monophonic
   track compiles to note intervals. A `sequence` graph node exposes frequency in
   Hz, gate, held velocity, and one-sample note-on trigger.
2. **Signal graph** (`dsp`, `engine`): a factory builds module instances, then the
   compiler resolves cable names to integer buffer indices, checks ports and
   single-source inputs, and topologically sorts the graph. Parameters establish
   input defaults or configure static module behaviour. All modules run once per
   sample; cables pass audio-rate floating-point signals. No string lookup or
   allocation happens in the scheduling loop.
3. **Output** (`engine`, CLI, `workbench`): explicit left/right endpoints plus a
   master gain feed peak/RMS metering and PCM16 conversion. Rendering includes a
   separately configured release/effect tail. WAV writes are streamed in 1024-frame
   chunks. The CLI writes a temporary sibling file and renames only on success.
   The workbench returns a WAV and statistics for export, or streams float stereo
   blocks through a browser AudioWorklet for live playback.

Module instances and their state belong to one render or live stream. A new graph resets all
state. Independent noise streams derive from the document seed and node index:
reordering nodes changes noise streams, while rerendering unchanged JSON produces
identical PCM. Output is clamped to [-1, 1], with clipping reported rather than
hidden behind automatic normalisation. Statistics describe samples before clamping.

## Sequencing details

Event start/end positions use absolute musical time. Exclusive end samples define
gate length. Trigger distinguishes consecutive notes even when gate remains high.
Frequency and velocity hold after note-off so oscillator pitch and release tails
remain intact; gate falls to zero. Initial CVs are 440 Hz and zero velocity.
Multiple voices are simply parallel sequence/oscillator/envelope paths.

## Feedback and modulation

The first compiler accepts directed acyclic graphs. A delay owns a bounded circular
buffer and feedback loop internally; wiring its output back to its graph input is
rejected. This keeps sample order unambiguous. A future explicit one-sample delay
edge could support cyclic graphs, but needs a two-phase scheduler and clear
latency semantics.

There is no distinction between audio cables and control-voltage cables. Values
are in documented module-specific units (Hz, seconds, unit gain, normalized pan).
For example, route a sine through three VCAs with gains 10, 10 and 3, then sum it
with a constant 2000 using a mixer to sweep a cutoff around 2 kHz. Individual VCA
and mixer gains are bounded to ±16, so large unit conversions currently require
cascading gains (the Neon patch demonstrates this). Bipolar modulation must be
scaled/offset to fit the destination's units. DSP modules clamp bounded controls
to supported ranges; they do not infer musical units.

## Workbench

The Go binary embeds the page and native JavaScript/CSS modules. Example scores remain external editable
files selected with `-examples`. The server defaults to loopback; `-addr 0.0.0.0:8080`
enables LAN access. Host checks accept loopback/private IPs and localhost, and
browser requests must be same-origin. It permits one render/validation request at
a time. HTTP scores are
limited to 2 MiB, 48 kHz, 90 seconds including tail and 128 nodes, with a 90-second
render deadline. Batch rendering uses the score format's larger limits. No file
save API is exposed: JSON and WAV saves are browser downloads. The draft is saved
in that browser origin's local storage.

The workbench uses the browser as the playback device. A tracker/piano-roll
view displays ordered musical events; a virtual rack displays actual module
controls, mixer channels and cable routing. Both can reveal corresponding fields
in the editable JSON tree. Rack controls edit numeric parameters and cable-end
gestures reconnect existing routes; proposals are checked by the Go compiler.
Known constructor defaults are made explicit in the browser document so control
links always point at actual JSON fields. Source mode supports structural edits. Rendered audio
is an export snapshot; live synthesis follows compatible edits while preserving
DSP state and smoothing continuous control values.

Optional project `id` UUID and `_ui.tree_expanded` JSON Pointer metadata are
accepted by the score parser and ignored by DSP. The browser assigns IDs to legacy
documents and saves drafts, pane visibility and visual preferences per UUID.
Tree branches default collapsed; the expansion paths travel in exported JSON.
Pane/view preferences stay browser-local. The component boundaries are described
in [workbench components](workbench-components.md).

Pane windows move existing DOM content between same-origin browser windows. The
main app retains stable element references and owns the single document model,
draft writer and renderer. Components resolve their current owner window for
pointer handling and animation. This avoids duplicating state/transport across
multiple full application instances. Closing/redocking returns the same controls.

## Live browser output

`engine.Stream` incrementally runs the same scheduler and DSP used by WAV export.
Its bounded deep-copy checkpoints preserve all DSP and sequencer state; seeking
restores and simulates forward. Parameter edits preserve compatible running state,
then ramp continuous controls over 8 ms. Structural edits validate a replacement
and reconstruct at equivalent playback time. See [live engine](live-engine.md).

The browser's dedicated live worker runs Go/WASM separately from offline export.
Bounded transferred float blocks feed an AudioWorklet that resamples to the device
rate and reports consumed playback position. Worklet messages request refill;
the UI's animation frame is not the audio clock. No SharedArrayBuffer or browsing
context isolation is required. The monitor controls and score ruler use the same
transport across popup windows. See [live transport](live-transport.md).

## Growth toward a modern instrument

- **New modules:** implement `Inputs`, `Outputs`, `Tick`; register in `dsp.New`.
  Keep port names stable and extend the module reference and focused DSP tests.
- **New score frontends:** produce a `score.Document` from a tracker text language,
  MIDI file, or visual editor; retain the versioned JSON representation for storage.
- **Polyphony:** introduce a voice allocator around a subgraph template with
  explicit voice stealing and envelope ownership, rather than duplicating music
  parsing inside oscillators.
- **Native audio devices:** adapt the incremental engine to an OS audio backend
  with fixed-size buffers and sample-timestamped control events. Do not put HTTP,
  JSON parsing, allocations or locks on its audio callback.
- **Efficient processing:** benchmark real patches, fuse/block-process compatible
  nodes, and add control-rate interpolation without changing signal units or
  note timing. Current scalar dispatch prioritises clarity and arbitrary modulation.
- **Higher fidelity:** band-limited tables, oversampled distortion, smoother
  parameter automation, higher-order filters, richer waveforms and reverb fit
  behind the existing interface. Current effects deliberately stay small.

Keep compatibility explicit: a change to storage semantics should increment the
format version or provide a migration, with a new timestamped decision record.
