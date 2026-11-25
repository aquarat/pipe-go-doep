# ADR: bounded score input and absolute-beat scheduling

- Date: 2026-11-21T18:26:10Z
- Status: accepted
- Scope: `internal/score`, version-1 score JSON

## Context

Scores are editable in a local browser and can reach an offline renderer as
untrusted JSON. The format must support reusable patterns, scientific pitch,
deterministic transposition, and sample-accurate monophonic sequences without
binding the scheduler to particular DSP modules. Repetition can expand a tiny
input into substantial work; rounding every step independently causes timing
drift even at ordinary tempos.

## Decision

Keep the exact public structs and `Parse`, `Validate`, and `CompileTrack`
interfaces from `docs/implementation-contract.md`. Use only the standard library.

`Parse` applies a 4 MiB read cap, `json.Decoder.DisallowUnknownFields`, an explicit
EOF check, and semantic validation. `Validate` also protects direct Go callers.
Validation rejects nonfinite/out-of-range numbers, invalid/duplicate IDs,
unknown pattern/track/node references, and multiple sources for one input. The
DSP factory and graph compiler retain authority over module types, ports,
parameter semantics, and cycles. Ordinary `encoding/json` case-insensitive field
matching and last-duplicate-key-wins semantics remain in place.

Bound render length to 300 seconds including tail and sample rate to 8–96 kHz.
Apply whole-document caps to tracks, nodes, edges, patterns, stored steps, order
entries, expanded steps, and potential events. Validate even unused patterns and
count the full expanded order, not just the audible portion. Count pitched
steps conservatively before gate-zero or clipping elimination. The concrete
limits are recorded in `docs/score-format.md` and package constants.

Represent pitch as MIDI 0–127 with ASCII scientific notation and single sharps
or flats; require the original and transposed pitch to stay in range. Use A4 =
440 Hz equal temperament. Rest `.` advances time without an event. Velocity
defaults to 1 and gate to 0.85, represented as pointers so explicit zero remains
distinct from omission. Gate is limited to 0–1 to ensure monophony.

Compile ordered patterns once, without implicit looping. Accumulate absolute
beats with compensated summation, then round each absolute onset and gate end
to samples (nearest, ties away from zero). Cap note ends at the next step and
the musical endpoint, omit zero-sample notes, and leave the effect tail to the
engine. Events use half-open `[Start, End)` intervals. Keep emitted velocity
even when zero. The engine holds the most recent frequency and velocity over
rests/release, with initial velocity zero; gate and trigger become zero. This
preserves release tails through velocity VCAs.

## Consequences

- Repeated fractional steps do not accumulate integer-sample rounding drift;
  compensated sums reduce binary floating-point accumulation error without a
  rational-number dependency or changing the contract's `float64` beat fields.
- Explicit order repetition is easy to inspect and bounded before compilation.
  Very large scores, even ones whose excess order lies beyond their duration,
  must be simplified to fit the documented budgets.
- Validation can run independently of DSP construction. A score may pass this
  layer and still fail engine validation for a bad port, module, or graph cycle.
- `CompileTrack` validates the complete document on every call. The documented
  small track/work limits bound this cost and avoid a mutable validation cache.
- Tiny gated steps may disappear through sample quantization; events never
  acquire an artificial one-sample duration or overlap their successor.
- Tests cover strict decoding, numerical/reference/resource boundaries,
  repetition amplification, pitch spelling/transposition, rests and defaults,
  explicit order behavior, clipping, and long fractional-beat scheduling.

## Integration review amendment

Reject documents whose total duration (including tail) rounds to zero WAV frames,
using the renderer's `round((beats * 60 / bpm + tail_seconds) * sample_rate)`
formula. This belongs in structural validation so positive sub-frame durations
cannot reach an empty WAV render.

During `CompileTrack`, require at least two samples between emitted note onsets.
Consecutive one-sample trigger pulses would remain continuously high and fail to
retrigger rising-edge ADSR/reset inputs. Preserve the existing trigger protocol
and return an actionable compilation error instead. Only nonzero-length emitted
events participate; rests and gate-zero, quantized-away, or clipped-away notes
do not create triggers. Zero-velocity emitted notes do participate. Structural
validation does not enforce this quantized temporal restriction; engine
compilation obtains it through `CompileTrack`. Regression tests cover consecutive
one-sample notes, a one-sample rest separating them, omitted events, and rounded
duration boundaries including the tail.
