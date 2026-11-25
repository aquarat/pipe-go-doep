// Package dsp supplies deterministic, scalar synthesizer building blocks.
// Modules are stateful and intended to be ticked by one goroutine at a time.
package dsp

import (
	"fmt"
	"math"
	"sort"
)

// Port is an input's name and its unconnected value.
type Port struct {
	Name    string
	Default float64
}

// Module processes one sample. The caller supplies buffers in the order exposed
// by Inputs and Outputs, with exactly those lengths. Treat port metadata as
// read-only. Tick neither retains the buffers nor allocates memory.
type Module interface {
	Inputs() []Port
	Outputs() []string
	Tick(inputs, outputs []float64)
}

type ports struct {
	inputs  []Port
	outputs []string
}

func (p *ports) Inputs() []Port    { return p.inputs }
func (p *ports) Outputs() []string { return p.outputs }

const (
	maxSignal       = 1e6
	maxDelaySeconds = 2.0
)

// bound also neutralizes invalid graph signals before they can poison state.
func bound(x, lo, hi float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		x = 0
	}
	return math.Max(lo, math.Min(hi, x))
}

func signal(x float64) float64 { return bound(x, -maxSignal, maxSignal) }

type parameter struct {
	name          string
	value, lo, hi float64
	integer       bool
	input         bool
}

func input(name string, value, lo, hi float64) parameter {
	return parameter{name: name, value: value, lo: lo, hi: hi, input: true}
}

func fixed(name string, value, lo, hi float64, integer bool) parameter {
	return parameter{name: name, value: value, lo: lo, hi: hi, integer: integer}
}

// New constructs a module with validated defaults. Unknown, nonfinite, and
// out-of-range parameters are errors. sampleRate must be 8000..96000 Hz. Only
// noise currently consumes seed; all other modules begin at a fixed phase/state.
func New(kind string, params map[string]float64, sampleRate int, seed uint64) (Module, error) {
	if sampleRate < 8000 || sampleRate > 96000 {
		return nil, fmt.Errorf("dsp: sample rate must be 8000..96000, got %d", sampleRate)
	}
	sr := float64(sampleRate)
	var spec []parameter
	outputs := []string{"out"}
	switch kind {
	case "constant":
		spec = []parameter{input("value", 0, -maxSignal, maxSignal)}
	case "sine", "pulse", "triangle", "saw", "wavetable":
		spec = []parameter{input("freq", 440, 0, .45*sr)}
		if kind == "pulse" {
			spec = append(spec, input("duty", .5, .01, .99))
		}
		spec = append(spec, input("reset", 0, 0, 1))
		if kind == "wavetable" {
			spec = append(spec, fixed("bits", 4, 1, 16, true))
		}
	case "noise":
		spec = []parameter{input("freq", math.Min(8000, sr), 0, sr), input("reset", 0, 0, 1), fixed("short", 0, 0, 1, true)}
	case "adsr":
		spec = []parameter{input("gate", 0, 0, 1), input("trigger", 0, 0, 1), fixed("attack", .01, 0, 60, false), fixed("decay", .1, 0, 60, false), fixed("sustain", .7, 0, 1, false), fixed("release", .2, 0, 60, false)}
	case "vca":
		spec = []parameter{input("in", 0, -maxSignal, maxSignal), input("gain", 1, -16, 16)}
	case "mixer":
		for _, name := range []string{"a", "b", "c", "d"} {
			spec = append(spec, input(name, 0, -maxSignal, maxSignal), fixed("gain_"+name, 1, -16, 16, false))
		}
	case "pan":
		spec = []parameter{input("in", 0, -maxSignal, maxSignal), input("pan", 0, -1, 1)}
		outputs = []string{"left", "right"}
	case "lowpass":
		spec = []parameter{input("in", 0, -maxSignal, maxSignal), input("cutoff", 2000, 1, .45*sr)}
	case "delay":
		spec = []parameter{input("in", 0, -maxSignal, maxSignal), input("time", .25, 0, maxDelaySeconds), input("feedback", .3, -.99, .99), input("mix", .25, 0, 1)}
	case "drive":
		spec = []parameter{input("in", 0, -maxSignal, maxSignal), input("amount", 2, 0, 100)}
	case "bitcrush":
		spec = []parameter{input("in", 0, -maxSignal, maxSignal), input("bits", 8, 1, 16), input("rate", math.Min(8000, sr), 0, sr)}
	default:
		return nil, fmt.Errorf("dsp: unknown module %q", kind)
	}

	values := make(map[string]float64, len(spec))
	known := make(map[string]bool, len(spec))
	for _, p := range spec {
		known[p.name] = true
	}
	// Sorting makes errors reproducible even when several map keys are invalid.
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !known[key] {
			return nil, fmt.Errorf("dsp %s: unknown parameter %q", kind, key)
		}
	}
	p := ports{outputs: outputs}
	for _, s := range spec {
		v := s.value
		if provided, ok := params[s.name]; ok {
			v = provided
		}
		if math.IsNaN(v) || math.IsInf(v, 0) || v < s.lo || v > s.hi || (s.integer && math.Trunc(v) != v) {
			return nil, fmt.Errorf("dsp %s: parameter %q must be finite in [%g, %g]%s", kind, s.name, s.lo, s.hi, integerSuffix(s.integer))
		}
		values[s.name] = v
		if s.input {
			p.inputs = append(p.inputs, Port{Name: s.name, Default: v})
		}
	}

	switch kind {
	case "sine", "pulse", "triangle", "saw", "wavetable":
		o := &oscillator{ports: p, kind: kind, sampleRate: sr}
		if kind == "wavetable" {
			levels := math.Exp2(values["bits"]) - 1
			for i := range o.table {
				x := 1 - 4*math.Abs(float64(i)/32-.5)
				o.table[i] = 2*math.Round((x+1)*.5*levels)/levels - 1
			}
		}
		return o, nil
	case "noise":
		width := uint(15)
		if values["short"] == 1 {
			width = 7
		}
		// SplitMix64's integer mixer lets every seed bit influence even the
		// short register. It runs only at construction, not at audio rate.
		mixed := seed + 0x9e3779b97f4a7c15
		mixed = (mixed ^ (mixed >> 30)) * 0xbf58476d1ce4e5b9
		mixed = (mixed ^ (mixed >> 27)) * 0x94d049bb133111eb
		mixed ^= mixed >> 31
		initial := uint16(mixed & ((1 << width) - 1))
		if initial == 0 {
			initial = 1
		}
		return &noise{ports: p, sampleRate: sr, initial: initial, register: initial, width: width}, nil
	case "adsr":
		return &envelope{ports: p, attack: frames(values["attack"], sr), decay: frames(values["decay"], sr), release: frames(values["release"], sr), sustain: values["sustain"]}, nil
	case "lowpass":
		return &lowpass{ports: p, sampleRate: sr}, nil
	case "delay":
		return &delay{ports: p, sampleRate: sr, buffer: make([]float64, int(maxDelaySeconds*sr)+2)}, nil
	case "bitcrush":
		return &bitcrusher{ports: p, sampleRate: sr, first: true}, nil
	default:
		m := &utility{ports: p, kind: kind}
		for i, name := range []string{"a", "b", "c", "d"} {
			m.gains[i] = values["gain_"+name]
		}
		return m, nil
	}
}

func integerSuffix(integer bool) string {
	if integer {
		return " and integer-valued"
	}
	return ""
}
