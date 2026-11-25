# Incremental DSP engine

`internal/engine.Stream` owns a private project snapshot and one running patch.
`Read(ctx, frames)` emits up to 8192 interleaved stereo float32 frames, clamped to
[-1, 1]. It uses the same sample scheduler and concrete DSP modules as `Render`;
the offline PCM16 WAV renderer and its pre-clamp statistics are unchanged.

## Exact seeking and bounds

The engine saves a checkpoint every half second of canonical playback. A
checkpoint includes all module state, port values, sequence sample/event cursors,
oscillator phase/reset edges, envelope stage/remaining/increment, noise register
and clock, filter integrators/coefficient cache, bitcrusher hold/phase, and delay
write index/history. Concrete type-switch clones deep-copy delay buffers. Only
immutable graph/port/event metadata is shared.

At most **16 checkpoints and 32 MiB of conservatively accounted checkpoint
storage** are retained. Accounting includes delay samples, module structs,
input/output arrays, graph/event metadata (even when shared), and allocation
rounding allowances. Old checkpoints are evicted before a new clone is made;
patches larger than the byte budget simply run without checkpoints. The budget
is for retained checkpoints, not the active patch, validated replacement, project
JSON, or Go heap/GC overhead. No whole-track PCM buffer is allocated.

`Seek` restores the nearest preceding checkpoint, or compiles from zero, then
simulates forward without allocating audio output. A canonical current state can
also satisfy forward seeks. Positions are integer sample frames, including EOF;
out-of-range requests fail. Cancellation is checked at least every 1024 frames.

## Updates

Every update validates and compiles a private replacement first. Invalid graph,
parameter, or score edits leave playback and checkpoints intact. Graph/timing,
score, seed, or sample-rate changes simulate the replacement to the current
wall-clock time, clamped to its duration, before swapping it in atomically.

When node identity/type/order, cables/output routing, tracks, timing, seed and
sample rate match, parameter updates retain the running modules and their state.
Unconnected input controls, output gain, mixer gains and ADSR controls ramp over
**8 ms**. A newer update starts its ramp at the current interpolated values.
Wavetable resolution and noise register width are discrete; changing them retains
phase/register history (with width masking). ADSR duration changes apply to future
stage transitions; a running stage keeps its remaining duration, and sustain
changes smoothly retarget decay/sustain without retriggering the envelope.
Cabled inputs remain driven by their source modules.

Parameter updates invalidate all old checkpoints. Live history after an edit is
not canonical history of the latest project, so it is not checkpointed. The next
seek reconstructs the latest project from zero; canonical checkpointing resumes.
Title/ID/UI metadata does not force graph reconstruction.

## Oscilloscope probes

`Stream.SetProbes([]Probe)` installs up to five probes, one per scope channel
(`x`, `y1`..`y4`, unique). Each references a module port
(`node`, `port`, `direction` `input`|`output`) or a stereo bus (`left`|`right`).
The whole list is validated before anything changes; an empty list clears.
References are resolved by node id and port name against the running patch.
A missing node or port is not an error: the channel is reported by
`Unresolved()` and reads `NaN`.

Every frame produced by `Read` records one value per probe into a buffer
allocated once by `SetProbes`, so capture adds no per-sample or per-block
allocation. `ProbeData()` returns the last read's values interleaved per frame
(`frames * len(probes)`), valid until the next `Read`, `Seek`, `Update` or
`SetProbes` (each of which empties it; seeks produce no probe data).

- Output probes read the value the module produced for that frame.
- Input probes read the value the module consumed: the cabled signal, or the
  base/default value including live 8 ms ramps.
- Bus probes read the output after master gain and before the `[-1, 1]` clamp.

Probes are observers only: PCM, checkpoints and offline WAV output are
identical with or without them. They persist across `Seek` and both kinds of
`Update`; structural updates re-resolve them against the new patch (so they
follow node ids when indices change, and dangle when a node is deleted). A
failed update leaves them untouched.

## Browser bridge

`cmd/pipe-go-doep-wasm` retains `pipeGoDoepRequest` and adds synchronous
`pipeGoDoepStream(action, jsonString)` exactly as described in
[`live-transport-contract.md`](live-transport-contract.md). `open`, `read`, `seek`,
`update`, and `close` manage one live stream per worker. `read.body` is a JS-owned
`Float32Array`, copied in bulk and safe to transfer without retaining a view into
Go memory. Offline rendering is independent of the live engine. Both APIs use the
same interactive limits: 2 MiB source, 48 kHz, 90 seconds including tail, 128 nodes.

The bridge adds a `probe` action (see [`scope-contract.md`](scope-contract.md)):
payload `{"probes":[{"channel":"y1","node":"lead","port":"out","direction":"output"},{"channel":"x","bus":"left"}]}`
returns `{status:200, channels:[...], unresolved:[...]}`; malformed JSON, unknown
fields, a missing or `null` `probes`, invalid channels/references, duplicate
channels or more than five probes return 400 and change nothing. The accepted
list belongs to the worker, not one stream: `open`, `update` and `close` keep it,
and `open`/`update` results include `unresolved`. With no open stream the list is
stored and node probes are reported unresolved. While probes are set, `read`
also returns `channels`, `unresolved` and `probe`, a JS-owned `Float32Array` of
`frames * channels.length` values copied out of Go memory like `body`.

## Verification

- `go test ./...`
- `GOOS=js GOARCH=wasm go build ./cmd/pipe-go-doep-wasm`
- `GOOS=js GOARCH=wasm go test -exec "$(go env GOROOT)/lib/wasm/go_js_wasm_exec" ./cmd/pipe-go-doep-wasm`

Tests cover exact block/sample scheduler parity and WAV quantization, stereo
effects/noise/sequence/envelope state, repeated forward/backward seeks across
checkpoint eviction and delay wraps, parameter ramps/retargeting without phase
reset, atomic invalid updates, equivalent-time replacements, delay-memory caps,
all DSP clone types, probe values against independently computed module
inputs/outputs and pre-clamp bus values, probes across seeks and both update
kinds, dangling probes, atomic invalid probe lists, zero added allocations, and
the actual WASM bridge lifecycle/typed buffers including `probe`.
