# Implementation contract — 2026-11-21T18:21:13Z

Go module: `pipe-go-doep` (now `github.com/aquarat/pipe-go-doep`), standard library only, Go 1.23+.

## DSP package (`internal/dsp`)

```go
type Port struct { Name string; Default float64 }
type Module interface {
    Inputs() []Port
    Outputs() []string
    Tick(inputs, outputs []float64)
}
func New(kind string, params map[string]float64, sampleRate int, seed uint64) (Module, error)
```

Fixed ports, allocated once, scalar/audio-rate graph execution. Inputs start at constructor defaults and connected inputs are overwritten each sample. Factory validates unknown/nonfinite parameters. Module output ports: mono `out`; pan `left`,`right`. Types: constant, sine, pulse, triangle, saw, wavetable, noise, adsr, vca, mixer, pan, lowpass, delay, drive, bitcrush. Oscillator inputs `freq`, `duty` (pulse only), `reset`; noise inputs `freq` and `reset`; ADSR inputs `gate`, `trigger`; VCA `in`, `gain`; mixer `a`,`b`,`c`,`d` with static gain parameters `gain_a` etc.; pan `in`,`pan`; lowpass `in`,`cutoff`; delay `in`,`time`,`feedback`,`mix`; drive `in`,`amount`; bitcrush `in`,`bits`,`rate`; constant input `value`. ADSR static seconds `attack`, `decay`, `release` and `sustain`. Oscillators default freq 440, pulse duty 0.5. Noise LFSR `short` parameter 0/1. Wavetable is a 32-step quantized triangle-like waveform with `bits` param. Sequence is implemented in engine, not DSP.

## Score package (`internal/score`)

```go
type Document struct {
 Version int `json:"version"`
 Title string `json:"title"`
 SampleRate int `json:"sample_rate"`
 BPM float64 `json:"bpm"`
 Beats float64 `json:"beats"`
 TailSeconds float64 `json:"tail_seconds"`
 Seed uint64 `json:"seed"`
 Tracks []Track `json:"tracks"`
 Nodes []Node `json:"nodes"`
 Connections []Connection `json:"connections"`
 Output Output `json:"output"`
}
type Track struct { ID string `json:"id"`; Patterns map[string][]Step `json:"patterns"`; Order []string `json:"order"`; Transpose int `json:"transpose"` }
type Step struct { Note string `json:"note"`; Beats float64 `json:"beats"`; Velocity *float64 `json:"velocity,omitempty"`; Gate *float64 `json:"gate,omitempty"` }
type Node struct { ID string `json:"id"`; Type string `json:"type"`; Params map[string]float64 `json:"params,omitempty"`; Track string `json:"track,omitempty"` }
type Connection struct { From string `json:"from"`; To string `json:"to"` }
type Output struct { Left string `json:"left"`; Right string `json:"right"`; Gain float64 `json:"gain"` }
type Event struct { Start int64; End int64; Frequency float64; Velocity float64 }
func Parse(r io.Reader) (*Document, error)
func (d *Document) Validate() error
func (d *Document) CompileTrack(id string) ([]Event, error)
```

JSON version 1. Steps use scientific pitch notation or `.` for rest; beat durations accumulate across ordered patterns. Default velocity 1, gate .85. Events are sample offsets, End exclusive, clipped to document beat duration; rests produce no events. Validate finite bounded values, duplicate IDs, missing patterns, note syntax, document duration <=300s total, sample rate 8000..96000, references where possible. Graph handles DSP ports and cycles. No implicit track looping: repeat pattern names in order explicitly. Note events cannot overlap within a monophonic track.

## Graph and output

Connections are `node.port` references; one source per input. Compile a DAG (reject cycles, even through delay; delay has internal feedback). Sequence node has no inputs, outputs `freq`, `gate`, `velocity`, `trigger`. Frequency and velocity hold over rests (initial values 440 Hz and zero), gate drops to zero; trigger is one sample on note-on. Held velocity preserves ADSR release when patched into a VCA. Sequence sees exact global sample index via internal counter. Stereo output refs are explicit. Engine renders samples including release/effect tail, reports peak/RMS/clipped sample count; WAV PCM16 stereo with bounded output. CLI validate/render/graph/serve. Browser UI is a local score editor and offline render/player, not a live audio callback synth. New DSP modules extend the factory without changing the scheduler.
