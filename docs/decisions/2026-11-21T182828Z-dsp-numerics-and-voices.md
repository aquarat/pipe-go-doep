# Deterministic scalar DSP voices and bounded controls

Date: 2026-11-21T18:28:28Z
Status: accepted

## Context

The offline modular core needs musically useful chip-inspired sources and modern
effects with predictable CPU/memory use, repeatable renders, and sample-level
control. The implementation contract fixes a scalar `Module` interface and a
seeded constructor. Audio-rate patch cables can supply arbitrary floating-point
values, including values outside a destination control's useful range.

## Decision

Implement the contracted fifteen module kinds in `internal/dsp`, using only the
standard library. Constructor schemas reject unknown, nonfinite, and out-of-range
parameters. Static discrete controls must be integer-valued; the audio-rate
bit-depth control is explicitly rounded. Port defaults are constructor values.
Tick functions use preallocated state, consume one sample, and allocate nothing.
Module instances have single-owner mutable state and read-only port metadata.

Clamp runtime controls to documented musical/numerical ranges, replacing NaN
and infinities with zero before clamping. Bound ordinary signal/state values to
±1,000,000 so malformed graph values cannot permanently poison recursive effects.
This guard is intentionally outside normal audio levels; output gain and WAV
clipping remain engine concerns.

Use analytic sine/triangle, polyBLEP-corrected saw/pulse, a 32-step quantized
triangle table, and 15-bit/7-bit XOR LFSRs. Oscillator and noise resets are
rising-edge events. Seed noise with a stable integer mixer and a nonzero register;
do not use package-global randomness. This is an original synthesis palette,
not cycle-accurate handheld hardware emulation.

Use linear ADSR segments with sample-count durations, gate-qualified rising-edge
retriggers, and retrigger/release from the current level. Use an equal-power pan,
fixed-damping two-pole TPT low-pass, normalized tanh saturation, and clocked
uniform quantization/sample-and-hold.

Give delay a fixed two-second ring, linear fractional reads, a minimum one-sample
delay, and feedback bounded to ±0.99. Allocate at construction only. Interpolated
read positions are normalized even at floating-point wrap boundaries. Internal
feedback does not add graph-level cycles or change the scheduler contract.

## Consequences

- DSP construction and processing remain independent of scores and scheduling.
- Hard bounds, interpolation, explicit edge semantics, and deterministic state
  initialization make malformed-control and sample-exact tests practical.
- Every delay instance costs at most approximately 1.47 MiB at the maximum
  supported 96 kHz rate. Longer delays need a future explicit storage policy.
- PolyBLEP improves discontinuous waveforms without the cost of oversampling.
  Table steps, triangle corners, hard resets, quantization and saturation can
  still alias. Abrupt controls are not smoothed automatically.
- Uniform endpoint-inclusive bitcrushing has no exact zero quantization level;
  its DC offset and deliberately unfiltered decimation are documented effects.
- Gate-qualified triggers support adjacent sequenced notes; trigger-only one-shot
  envelopes are a separate future feature.
- Regression tests verify audible behavior (pitch, response, timing and alias
  reduction), deterministic noise, memory/allocation behavior and recursive
  stability rather than relying on opaque audio snapshots.

See [modules](../modules.md) for all defaults, ranges, units and limitations.
