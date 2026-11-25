package dsp

import (
	"math"
	"strings"
	"testing"
)

var moduleKinds = []string{"constant", "sine", "pulse", "triangle", "saw", "wavetable", "noise", "adsr", "vca", "mixer", "pan", "lowpass", "delay", "drive", "bitcrush"}

func setup(t *testing.T, kind string, params map[string]float64, sr int, seed uint64) (Module, []float64, []float64) {
	t.Helper()
	m, err := New(kind, params, sr, seed)
	if err != nil {
		t.Fatal(err)
	}
	in := make([]float64, len(m.Inputs()))
	for i, p := range m.Inputs() {
		in[i] = p.Default
	}
	return m, in, make([]float64, len(m.Outputs()))
}

func closeTo(t *testing.T, got, want, tolerance float64) {
	t.Helper()
	if math.IsNaN(got) || math.Abs(got-want) > tolerance {
		t.Fatalf("got %.15g, want %.15g (tolerance %g)", got, want, tolerance)
	}
}

func TestFactoryValidation(t *testing.T) {
	for _, kind := range moduleKinds {
		t.Run(kind, func(t *testing.T) {
			for _, sr := range []int{8000, 44100, 96000} {
				_, _, _ = setup(t, kind, nil, sr, 0)
			}
			if _, err := New(kind, map[string]float64{"typo": 0}, 48000, 1); err == nil || !strings.Contains(err.Error(), "typo") {
				t.Fatalf("unknown parameter was not identified: %v", err)
			}
			m, _, _ := setup(t, kind, nil, 48000, 1)
			for _, p := range m.Inputs() {
				for _, bad := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), math.MaxFloat64, -math.MaxFloat64} {
					if _, err := New(kind, map[string]float64{p.Name: bad}, 48000, 1); err == nil {
						t.Fatalf("accepted invalid %s=%g", p.Name, bad)
					}
				}
			}
		})
	}
	for _, tc := range []struct {
		kind, name string
		value      float64
	}{
		{"adsr", "attack", -1}, {"adsr", "decay", 61}, {"adsr", "sustain", 1.1}, {"adsr", "release", math.NaN()},
		{"wavetable", "bits", 3.5}, {"noise", "short", .5}, {"mixer", "gain_a", math.Inf(1)},
		{"delay", "feedback", 1}, {"delay", "time", 2.1}, {"pulse", "duty", 0},
	} {
		if _, err := New(tc.kind, map[string]float64{tc.name: tc.value}, 48000, 0); err == nil {
			t.Errorf("accepted %s %s=%g", tc.kind, tc.name, tc.value)
		}
	}
	for _, sr := range []int{-1, 0, 7999, 96001} {
		if _, err := New("sine", nil, sr, 0); err == nil {
			t.Errorf("accepted sample rate %d", sr)
		}
	}
	if _, err := New("unknown", nil, 48000, 0); err == nil {
		t.Error("accepted unknown module")
	}
}

func TestPortContract(t *testing.T) {
	wantInputs := map[string]string{
		"constant": "value", "sine": "freq,reset", "pulse": "freq,duty,reset", "triangle": "freq,reset", "saw": "freq,reset", "wavetable": "freq,reset", "noise": "freq,reset", "adsr": "gate,trigger", "vca": "in,gain", "mixer": "a,b,c,d", "pan": "in,pan", "lowpass": "in,cutoff", "delay": "in,time,feedback,mix", "drive": "in,amount", "bitcrush": "in,bits,rate",
	}
	for _, kind := range moduleKinds {
		m, _, _ := setup(t, kind, nil, 48000, 0)
		var names []string
		for _, p := range m.Inputs() {
			names = append(names, p.Name)
		}
		if got := strings.Join(names, ","); got != wantInputs[kind] {
			t.Errorf("%s inputs = %s, want %s", kind, got, wantInputs[kind])
		}
		want := "out"
		if kind == "pan" {
			want = "left,right"
		}
		if got := strings.Join(m.Outputs(), ","); got != want {
			t.Errorf("%s outputs = %s, want %s", kind, got, want)
		}
	}
}

func TestHostileSignalsStayFiniteAndRecover(t *testing.T) {
	for _, kind := range moduleKinds {
		t.Run(kind, func(t *testing.T) {
			m, in, out := setup(t, kind, nil, 8000, 1)
			bad := []float64{math.NaN(), math.Inf(1), math.Inf(-1), math.MaxFloat64, -math.MaxFloat64, 0, 1}
			for n := 0; n < 5000; n++ {
				for i := range in {
					in[i] = bad[(n+i)%len(bad)]
				}
				m.Tick(in, out)
				for _, y := range out {
					if math.IsNaN(y) || math.IsInf(y, 0) || math.Abs(y) > maxSignal {
						t.Fatalf("sample %d is unbounded: %g", n, y)
					}
				}
			}
			for i, p := range m.Inputs() {
				in[i] = p.Default
			}
			for n := 0; n < 1000; n++ {
				m.Tick(in, out)
				for _, y := range out {
					if math.IsNaN(y) || math.IsInf(y, 0) {
						t.Fatalf("failed to recover: %g", y)
					}
				}
			}
		})
	}
}

func TestTickDoesNotAllocate(t *testing.T) {
	for _, kind := range moduleKinds {
		t.Run(kind, func(t *testing.T) {
			m, in, out := setup(t, kind, nil, 48000, 1)
			if got := testing.AllocsPerRun(1000, func() { m.Tick(in, out) }); got != 0 {
				t.Fatalf("allocations per Tick: %g", got)
			}
		})
	}
}
