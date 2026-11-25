package dsp

import (
	"reflect"
	"testing"
)

func TestCloneEveryModuleExactAndIndependent(t *testing.T) {
	for _, kind := range []string{"constant", "sine", "pulse", "triangle", "saw", "wavetable", "noise", "adsr", "vca", "mixer", "pan", "lowpass", "delay", "drive", "bitcrush"} {
		t.Run(kind, func(t *testing.T) {
			m, err := New(kind, nil, 8000, 12345)
			if err != nil {
				t.Fatal(err)
			}
			in, out := make([]float64, len(m.Inputs())), make([]float64, len(m.Outputs()))
			for i, p := range m.Inputs() {
				in[i] = p.Default
				if p.Name == "gate" || p.Name == "in" {
					in[i] = .8
				}
			}
			for i := 0; i < 2719; i++ {
				m.Tick(in, out)
			}
			copy := Clone(m)
			if StateBytes(copy) <= 0 {
				t.Fatal("missing state accounting")
			}
			want := make([]float64, len(out))
			for i := 0; i < 500; i++ {
				m.Tick(in, out)
				copy.Tick(in, want)
				if !reflect.DeepEqual(out, want) {
					t.Fatalf("clone differs at %d", i)
				}
			}
			if d, ok := m.(*delay); ok {
				clone := copy.(*delay)
				if &d.buffer[0] == &clone.buffer[0] {
					t.Fatal("aliased delay buffer")
				}
				saved := clone.buffer[0]
				d.buffer[0] = 123
				if clone.buffer[0] != saved {
					t.Fatal("delay clone mutated")
				}
				if StateBytes(clone) < int64(len(clone.buffer))*8 {
					t.Fatal("size omits delay memory")
				}
			}
		})
	}
}

func TestFixedControlsRampWithoutStateReset(t *testing.T) {
	m, _ := New("adsr", map[string]float64{"attack": 0, "decay": 0, "sustain": .2}, 8000, 1)
	target, _ := New("adsr", map[string]float64{"attack": .2, "decay": .3, "sustain": .8, "release": .4}, 8000, 1)
	out := make([]float64, 1)
	m.Tick([]float64{1, 0}, out)
	e := m.(*envelope)
	from, to := CaptureParameters(m), CaptureParameters(target)
	for i := 1; i <= 64; i++ {
		RampParameters(m, from, to, float64(i)/64)
		m.Tick([]float64{1, 0}, out)
		if e.stage != sustain || !e.wasGate {
			t.Fatal("envelope restarted")
		}
		want := .2 + .6*float64(i)/64
		if out[0]-want > 1e-12 || want-out[0] > 1e-12 {
			t.Fatal("sustain did not ramp")
		}
	}
	if e.attack != 1600 || e.decay != 2400 || e.release != 3200 {
		t.Fatal("ADSR times not updated")
	}
	mix, _ := New("mixer", nil, 8000, 1)
	next, _ := New("mixer", map[string]float64{"gain_a": .25}, 8000, 1)
	RampParameters(mix, CaptureParameters(mix), CaptureParameters(next), .5)
	mix.Tick([]float64{1, 0, 0, 0}, out)
	if out[0] != .625 {
		t.Fatal("mixer fixed gain did not interpolate")
	}
}
