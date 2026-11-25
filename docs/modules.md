# DSP modules

`internal/dsp` implements a small, deterministic synthesis palette using only
the Go standard library. The pulse, wavetable and noise voices are inspired by
handheld chip music. **This is not a hardware emulator:** there are no emulated
registers, hardware clock dividers, sweep units, or cycle-accurate audio channels.

## Calling convention

```go
type Port struct { Name string; Default float64 }
type Module interface {
    Inputs() []Port
    Outputs() []string
    Tick(inputs, outputs []float64)
}
func New(kind string, params map[string]float64, sampleRate int, seed uint64) (Module, error)
```

- Sample rates are integer **8000–96000 Hz**. Names are case-sensitive.
- Every input name is also an optional constructor parameter that sets its
  unconnected default. Additional static parameters are listed below. Omitted
  parameters use the documented defaults; explicit zero is not treated as absent.
- Constructors reject unknown names, NaN, infinities, out-of-range values, and
  fractional values for parameters marked integer. Validation does not mutate
  the caller's parameter map.
- Allocate input/output buffers once, in exactly the order listed below.
  Initialize inputs from `Inputs()[i].Default`, then overwrite connected inputs
  each sample. `Tick` does not allocate, retain buffers, or restore defaults.
- Metadata slices belong to the module and must be treated as read-only.
  A module instance is stateful and must have a single ticking owner. Make a
  new instance for an independent voice/render; new instances have cleared state.
- All controls can be modulated at audio rate except explicitly static parameters.
  Real-time values are clamped to their ranges; nonfinite values become zero
  before clamping. Ordinary signal inputs/outputs have a generous ±1,000,000
  numerical guard, not a musical limiter. Typical audio amplitude is ±1.
- Outputs are mono `out`, except `pan`, whose outputs are `left`, `right`.
- Sequencing is an engine responsibility, not a DSP module. Oscillators do not
  track notes or gates; connect `freq`, `reset`, and an ADSR/VCA as desired.

In the tables, `SR` means sample rate in Hz. Times are seconds. Ranges include
both endpoints. `in`, mixer `a`–`d`, and `value` accept ±1,000,000.

## Module reference

| Type | Ordered inputs with defaults | Static parameters | Operation |
| --- | --- | --- | --- |
| `constant` | `value=0` | — | Emit a constant or pass through a connected value. |
| `sine` | `freq=440`, `reset=0` | — | Unit-amplitude sine. |
| `pulse` | `freq=440`, `duty=0.5`, `reset=0` | — | PolyBLEP pulse; duty controls positive portion. |
| `triangle` | `freq=440`, `reset=0` | — | Continuous, piecewise-linear triangle. |
| `saw` | `freq=440`, `reset=0` | — | Rising saw with polyBLEP edge correction. |
| `wavetable` | `freq=440`, `reset=0` | `bits=4` | 32-step quantized triangle-like table. |
| `noise` | `freq=8000`, `reset=0` | `short=0` | Clocked, bipolar LFSR noise. |
| `adsr` | `gate=0`, `trigger=0` | `attack=0.01`, `decay=0.1`, `sustain=0.7`, `release=0.2` | Linear gate-controlled envelope. |
| `vca` | `in=0`, `gain=1` | — | Multiply input by gain. |
| `mixer` | `a=0`, `b=0`, `c=0`, `d=0` | `gain_a=1`, `gain_b=1`, `gain_c=1`, `gain_d=1` | Weighted sum, with no automatic normalization. |
| `pan` | `in=0`, `pan=0` | — | Equal-power stereo pan. |
| `lowpass` | `in=0`, `cutoff=2000` | — | Two-pole Butterworth low-pass. |
| `delay` | `in=0`, `time=0.25`, `feedback=0.3`, `mix=0.25` | — | Fractional delay with internal feedback. |
| `drive` | `in=0`, `amount=2` | — | Normalized hyperbolic-tangent saturation. |
| `bitcrush` | `in=0`, `bits=8`, `rate=8000` | — | Quantization followed by sample-and-hold. |

### Oscillators

- `freq`: **0–0.45 × SR** Hz. Negative/reverse frequency is not supported.
  Zero holds the current phase. Each sample is evaluated at the current phase
  before the frequency increment is applied.
- `reset`: **0–1**. A crossing from ≤0.5 to >0.5 resets phase to zero on that
  sample. Holding reset high does not freeze or continuously restart a voice.
- `pulse.duty`: **0.01–0.99**. At runtime this is narrowed further to
  `[max(0.01, freq/SR), min(0.99, 1-freq/SR)]`, keeping corrected edges separated.
  Thus narrow-duty pulses become less narrow at high pitches.
- `wavetable.bits`: integer **1–16**. Its 32 values are sampled from the
  triangle `1 - 4*abs(phase-0.5)`, then quantized to `2^bits` uniformly spaced
  levels including ±1. Playback uses nearest lower table index, with no
  interpolation, to retain the stepped character.
- New sine voices start at zero. Triangle and wavetable start at −1. PolyBLEP
  pulse and saw start at the midpoint of the corrected edge when frequency is
  positive. Pulse and saw have reduced aliasing, not perfect band limitation.
  Triangle corners, table steps, hard resets, and abrupt modulation can alias.
  There is no oversampling or automatic frequency/duty smoothing.

### Noise and reproducibility

- `freq`: **0–SR** Hz, the register clock rate rather than a pitch in musical
  notation. The output holds between clock updates; zero freezes the register.
- `reset`: **0–1**, rising-edge behavior as above. It restores both the original
  seeded register and clock phase, so a reset reproduces the initial sequence.
- `short`: integer **0 or 1**. Zero selects a 15-bit register; one selects a
  7-bit register. XOR taps are bit 0 and bit 1, shifted into the top bit. The
  maximal periods are 32767 and 127 register clocks respectively. Output is
  `1 - 2*(register & 1)`, evaluated before that sample's clock update.
- The supplied 64-bit seed is mixed once using SplitMix64's integer mixer,
  masked to the selected register width, and replaced by 1 if the result is
  zero. Seed zero is valid. Different seeds can map to the same finite register
  state; identical seeds/configurations produce identical noise. Independent
  streams require different seeds supplied by the caller.
- Other modules ignore the seed and have deterministic initial state. Integer
  noise is bit-reproducible; floating-point transcendental results should not be
  assumed bit-identical across every Go platform/toolchain.

### ADSR

- `gate`, `trigger`: **0–1**, high above 0.5.
- `attack`, `decay`, `release`: static **0–60 seconds**. Each nonzero duration
  is rounded up to `ceil(seconds × SR)` samples. `sustain`: static **0–1**.
- A rising gate starts attack from the current level toward 1. A rising trigger
  while gate is high restarts attack from the current level, allowing adjacent
  notes to retrigger without a gate gap or a discontinuous drop to zero.
  Holding trigger high does not repeatedly restart attack; trigger with gate
  low does nothing.
- Attack is followed by decay to sustain, which holds while the gate is high.
  A falling gate starts release from the current level, even during attack or
  decay. A new gate during release attacks from that release level.
- A nonzero segment takes its first step on the initiating sample and reaches
  its target on step N. Its target is emitted before a following segment starts
  on the next sample. Zero-length segments are skipped when reached; an all-zero
  attack/decay reaches sustain immediately, and zero release silences immediately.
- Retriggers take the full configured attack duration from the current level.
  The output is always 0–1. This is a gate envelope, not a one-shot percussion
  envelope; short gate notes or low/zero sustain can produce percussive sounds.

### Gain, mixing, and panning

- `vca.gain` and static mixer gains: **−16–16**; negative gains invert polarity.
  Mixer defaults sum all four inputs directly, so set gains or output gain to
  preserve headroom.
- `pan.pan`: **−1–1**, left to right. Gains are
  `cos((pan+1)*pi/4)` and `sin((pan+1)*pi/4)`. Center sends approximately 0.7071
  to each channel; the sum of their squared gains is 1.

### Low-pass filter

- `cutoff`: **1–0.45 × SR** Hz. The filter is a topology-preserving-transform
  state-variable filter with fixed Butterworth damping (`sqrt(2)`), approximately
  −3 dB at cutoff and 12 dB/octave attenuation above it.
- Coefficients update on cutoff changes, including audio-rate modulation. States
  start at zero. There is no resonance control, key tracking, or cutoff smoothing.
  Extreme signal levels encounter the shared numerical guard.

### Delay

- `time`: **0–2 seconds**, clamped during processing to at least **one sample**.
  Zero therefore means a one-sample wet delay, not an instantaneous feedback loop.
- `feedback`: **−0.99–0.99**. `mix`: **0–1**, linear dry/wet blend.
  `out = in*(1-mix) + wet*mix`; the ring stores `in + wet*feedback`.
- Reads use linear interpolation. An impulse at sample 0 with a delay of 2.5
  samples appears half-amplitude at samples 2 and 3. Feedback recirculates the
  wet value, including interpolation. Negative feedback alternates echo polarity.
- Storage is allocated once: `2*SR + 2` float64 values, at most **1,536,016 bytes**
  (about 1.47 MiB) per instance at 96 kHz, excluding object/metadata overhead.
  It never grows from a control signal. The buffer begins silent.
- Feedback magnitude below one and convex interpolation bound the feedback
  loop; the shared signal guard also caps extreme inputs/state. The maximum
  feedback can still produce a very long tail, so choose render tail accordingly.
- There is no time smoothing or crossfade: rapid changes can click or produce
  Doppler-like pitch shifts. Linear interpolation attenuates high frequencies
  during fractional-delay feedback. This is a mono delay, not a reverb.

### Drive and bitcrush

- `drive.amount`: **0–100**. Transfer is `tanh(amount*in)/tanh(amount)`;
  amounts below `1e-8` use identity to avoid division by zero. Unit inputs map to
  unit outputs. Small positive amounts can output above ±1 for inputs above ±1;
  this is saturation, not a final-output limiter. No oversampling is performed.
- `bitcrush.bits`: **1–16**, rounded to the nearest integer during processing.
  `rate`: **0–SR** Hz. Input is clipped to ±1 and rounded to `2^bits` uniformly
  spaced levels including ±1. Those even level counts have no exact zero level;
  silence quantizes to a small positive DC offset (particularly large at 1 bit).
- Bitcrush captures on its first sample, then on a phase-accumulator clock;
  noninteger rate ratios alternate hold lengths. Zero rate holds the last sample
  indefinitely (a clock update already due when rate changes is still consumed).
  Depth and input changes take effect at the next capture. Sample-rate reduction
  has no anti-alias prefilter; its aliasing and stair steps are intentional.

## Verification

Run `go test ./internal/dsp` using the repository's Go toolchain. Tests cover
constructor/port contracts, invalid and hostile controls, allocation-free ticks,
sine pitch/amplitude, oscillator fundamentals and reset edges, reduced saw alias
energy, table quantization, both LFSR periods and reproducibility, envelope
timing/retrigger/release, integer/fractional/max delay timing, modulated feedback
stability, filter response/stability, sample-and-hold timing, equal-power pan,
gain/mixing, and the saturation transfer.
