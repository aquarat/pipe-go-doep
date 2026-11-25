package dsp

import (
	"math"
	"testing"
)

func TestDelayTimingInterpolationAndFeedback(t *testing.T) {
	for _, tc := range []struct {
		name     string
		samples  float64
		feedback float64
		want     []float64
	}{
		{"integer", 3, 0, []float64{0, 0, 0, 1, 0, 0, 0}},
		{"fractional", 2.5, 0, []float64{0, 0, .5, .5, 0, 0}},
		{"minimum", 0, 0, []float64{0, 1, 0, 0}},
		{"feedback", 2, .5, []float64{0, 0, 1, 0, .5, 0, .25, 0, .125}},
		{"negative feedback", 2, -.5, []float64{0, 0, 1, 0, -.5, 0, .25, 0, -.125}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, in, out := setup(t, "delay", map[string]float64{"time": tc.samples / 8000, "feedback": tc.feedback, "mix": 1}, 8000, 0)
			for i, want := range tc.want {
				in[0] = 0
				if i == 0 {
					in[0] = 1
				}
				m.Tick(in, out)
				closeTo(t, out[0], want, 1e-10)
			}
		})
	}
}

func TestDelayMaximumAndRingWrap(t *testing.T) {
	const sr = 8000
	m, in, out := setup(t, "delay", map[string]float64{"time": 2, "feedback": .5, "mix": 1}, sr, 0)
	for i := 0; i <= 6*sr; i++ {
		in[0] = 0
		if i == 0 {
			in[0] = 1
		}
		m.Tick(in, out)
		want := 0.0
		if i > 0 && i%(2*sr) == 0 {
			want = math.Pow(.5, float64(i/(2*sr)-1))
		}
		closeTo(t, out[0], want, 1e-12)
	}
	if n := len(m.(*delay).buffer); n != 2*sr+2 {
		t.Fatalf("unexpected storage: %d", n)
	}
}

func TestDelayFeedbackIsStableUnderModulation(t *testing.T) {
	m, in, out := setup(t, "delay", map[string]float64{"mix": 1, "feedback": .99}, 8000, 0)
	// For |input| <= 1, |feedback| <= .99, convex interpolation gives
	// an absolute 100-unit bound, including arbitrary changes of read position.
	for i := 0; i < 200000; i++ {
		in[0] = math.Sin(float64(i) * .13)
		in[1] = float64((i*7919)%16001) / 8000
		if i%2 == 0 {
			in[2] = -.99
		} else {
			in[2] = .99
		}
		m.Tick(in, out)
		if math.IsNaN(out[0]) || math.Abs(out[0]) > 100.00001 {
			t.Fatalf("unstable modulated delay at %d: %g", i, out[0])
		}
	}
	// A fixed one-sample feedback loop has the expected long-term decay.
	m, in, out = setup(t, "delay", map[string]float64{"time": 0, "feedback": .99, "mix": 1}, 8000, 0)
	in[0] = 1
	m.Tick(in, out)
	in[0] = 0
	for i := 0; i < 10000; i++ {
		m.Tick(in, out)
	}
	if math.Abs(out[0]) > 1e-40 {
		t.Fatalf("feedback tail did not decay: %g", out[0])
	}
}

func TestLowpassFrequencyResponse(t *testing.T) {
	const sr = 48000
	measure := func(frequency float64) float64 {
		m, in, out := setup(t, "lowpass", map[string]float64{"cutoff": 1000}, sr, 0)
		var energy float64
		for i := 0; i < sr; i++ {
			in[0] = math.Sin(2 * math.Pi * frequency * float64(i) / sr)
			m.Tick(in, out)
			if i >= sr/2 {
				energy += out[0] * out[0]
			}
		}
		return math.Sqrt(energy / (sr / 2) * 2)
	}
	closeTo(t, measure(100), 1, .001)
	closeTo(t, measure(1000), 1/math.Sqrt2, 1e-8)
	if high := measure(10000); high > .01 {
		t.Fatalf("weak stopband attenuation: %g", high)
	}
}

func TestLowpassImpulseDecayAndModulation(t *testing.T) {
	m, in, out := setup(t, "lowpass", nil, 8000, 0)
	var sum float64
	for i := 0; i < 8000; i++ {
		in[0] = 0
		if i == 0 {
			in[0] = 1
		}
		m.Tick(in, out)
		sum += out[0]
	}
	closeTo(t, sum, 1, 1e-12)
	closeTo(t, out[0], 0, 1e-30)
	for i := 0; i < 80000; i++ {
		in[0] = math.Sin(float64(i))
		in[1] = 1
		if i%2 == 0 {
			in[1] = 3600
		}
		m.Tick(in, out)
		if math.IsNaN(out[0]) || math.Abs(out[0]) > 10 {
			t.Fatalf("unstable filter modulation: %g", out[0])
		}
	}
}

func TestBitcrushQuantizationAndClock(t *testing.T) {
	m, in, out := setup(t, "bitcrush", map[string]float64{"bits": 2, "rate": 2000}, 8000, 0)
	for i := 0; i < 12; i++ {
		in[0] = 1
		if i == 0 || i == 8 {
			in[0] = -.8
		}
		m.Tick(in, out)
		want := 1.0
		if i < 4 || i >= 8 {
			want = -1
		}
		closeTo(t, out[0], want, 0)
	}
	m, in, out = setup(t, "bitcrush", map[string]float64{"bits": 2, "rate": 8000}, 8000, 0)
	for _, tc := range []struct{ x, want float64 }{{-100, -1}, {-.3, -1.0 / 3}, {.3, 1.0 / 3}, {100, 1}} {
		in[0] = tc.x
		m.Tick(in, out)
		closeTo(t, out[0], tc.want, 1e-12)
	}
	m, in, out = setup(t, "bitcrush", map[string]float64{"rate": 0}, 8000, 0)
	in[0] = -.8
	m.Tick(in, out)
	held := out[0]
	in[0] = 1
	for i := 0; i < 100; i++ {
		m.Tick(in, out)
		closeTo(t, out[0], held, 0)
	}
}

func TestUtilitiesAndSaturation(t *testing.T) {
	m, in, out := setup(t, "constant", map[string]float64{"value": 3}, 8000, 0)
	m.Tick(in, out)
	closeTo(t, out[0], 3, 0)
	m, in, out = setup(t, "vca", map[string]float64{"in": .5, "gain": -2}, 8000, 0)
	m.Tick(in, out)
	closeTo(t, out[0], -1, 0)
	m, in, out = setup(t, "mixer", map[string]float64{"a": 1, "b": 2, "c": 3, "d": 4, "gain_a": -1, "gain_b": .5, "gain_c": 0, "gain_d": 2}, 8000, 0)
	m.Tick(in, out)
	closeTo(t, out[0], 8, 0)
	m, in, out = setup(t, "pan", map[string]float64{"in": 1}, 8000, 0)
	for _, pan := range []float64{-1, -.5, 0, .5, 1} {
		in[1] = pan
		m.Tick(in, out)
		closeTo(t, out[0]*out[0]+out[1]*out[1], 1, 1e-12)
		if pan == -1 {
			closeTo(t, out[1], 0, 1e-12)
		} else if pan == 1 {
			closeTo(t, out[0], 0, 1e-12)
		}
	}
	m, in, out = setup(t, "drive", nil, 8000, 0)
	for _, x := range []float64{.01, .5, 1, 100} {
		in[0] = x
		m.Tick(in, out)
		positive := out[0]
		in[0] = -x
		m.Tick(in, out)
		closeTo(t, out[0], -positive, 1e-12)
		if positive <= 0 || positive > 1/math.Tanh(2) {
			t.Fatalf("invalid saturation transfer: %g", positive)
		}
		if x == 1 {
			closeTo(t, positive, 1, 1e-12)
		}
	}
	in[0], in[1] = .4, 0
	m.Tick(in, out)
	closeTo(t, out[0], .4, 0)
}
