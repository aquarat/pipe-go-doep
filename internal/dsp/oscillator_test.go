package dsp

import (
	"math"
	"testing"
)

func TestSineFrequencyAndAmplitude(t *testing.T) {
	const sr = 48000
	for _, frequency := range []float64{55, 440, 997, 11000} {
		m, in, out := setup(t, "sine", map[string]float64{"freq": frequency}, sr, 0)
		var energy, previous float64
		crossings := 0
		for i := 0; i < sr; i++ {
			m.Tick(in, out)
			closeTo(t, out[0], math.Sin(2*math.Pi*frequency*float64(i)/sr), 1e-8)
			if previous <= 0 && out[0] > 0 {
				crossings++
			}
			previous = out[0]
			energy += out[0] * out[0]
		}
		if math.Abs(float64(crossings)-frequency) > 1 {
			t.Fatalf("frequency %g: got %d positive crossings", frequency, crossings)
		}
		closeTo(t, math.Sqrt(energy/sr), 1/math.Sqrt2, 1e-10)
	}
}

func TestOscillatorFundamentalsAndReset(t *testing.T) {
	const sr, count = 48000, 4800
	for _, kind := range []string{"sine", "pulse", "saw", "triangle", "wavetable"} {
		t.Run(kind, func(t *testing.T) {
			m, in, out := setup(t, kind, map[string]float64{"freq": 1000}, sr, 123)
			var real, imaginary, energy float64
			first := make([]float64, 100)
			for i := 0; i < count; i++ {
				m.Tick(in, out)
				if i < len(first) {
					first[i] = out[0]
				}
				if math.Abs(out[0]) > 1+1e-12 {
					t.Fatalf("out of range: %g", out[0])
				}
				angle := 2 * math.Pi * 1000 * float64(i) / sr
				real += out[0] * math.Cos(angle)
				imaginary += out[0] * math.Sin(angle)
				energy += out[0] * out[0]
			}
			amplitude := 2 * math.Hypot(real, imaginary) / count
			if amplitude < .5 || energy/count < .1 {
				t.Fatalf("missing 1000 Hz fundamental: amplitude=%g energy=%g", amplitude, energy/count)
			}
			// Holding reset high must restart only on its rising edge.
			in[len(in)-1] = 1
			for i := range first {
				m.Tick(in, out)
				closeTo(t, out[0], first[i], 1e-12)
			}
			in[len(in)-1] = 0
			m.Tick(in, out)
			in[len(in)-1] = 1
			m.Tick(in, out)
			closeTo(t, out[0], first[0], 0)
		})
	}
}

func TestPolyBLEPReducesFoldedHarmonics(t *testing.T) {
	// At 5 kHz / 48 kHz the saw's tenth harmonic folds to 2 kHz. A
	// coherent measurement isolates that unwanted component and its aliases.
	const sr, count = 48000, 4800
	m, in, out := setup(t, "saw", map[string]float64{"freq": 5000}, sr, 0)
	var naiveReal, naiveImag, blepReal, blepImag, phase float64
	for i := 0; i < count; i++ {
		m.Tick(in, out)
		naive := 2*phase - 1
		angle := 2 * math.Pi * 2000 * float64(i) / sr
		c, s := math.Cos(angle), math.Sin(angle)
		naiveReal += naive * c
		naiveImag += naive * s
		blepReal += out[0] * c
		blepImag += out[0] * s
		phase += 5000.0 / sr
		if phase >= 1 {
			phase--
		}
	}
	naive := math.Hypot(naiveReal, naiveImag)
	corrected := math.Hypot(blepReal, blepImag)
	if corrected >= naive*.15 {
		t.Fatalf("folded harmonic insufficiently reduced: BLEP=%g naive=%g", corrected, naive)
	}
}

func TestWavetableQuantization(t *testing.T) {
	m, in, out := setup(t, "wavetable", map[string]float64{"freq": 250, "bits": 2}, 8000, 0)
	seen := map[float64]bool{}
	for i := 0; i < 32; i++ {
		m.Tick(in, out)
		seen[out[0]] = true
		q := (out[0] + 1) * 1.5
		closeTo(t, q, math.Round(q), 1e-12)
	}
	if len(seen) != 4 {
		t.Fatalf("2-bit wavetable uses %d levels, want 4", len(seen))
	}
}

func TestNoiseSeedResetAndPeriods(t *testing.T) {
	for _, short := range []float64{0, 1} {
		params := map[string]float64{"freq": 8000, "short": short}
		a, ai, ao := setup(t, "noise", params, 8000, 0x123456789abcdef)
		b, bi, bo := setup(t, "noise", params, 8000, 0x123456789abcdef)
		c, ci, co := setup(t, "noise", params, 8000, 42)
		period := 32767
		if short == 1 {
			period = 127
		}
		sequence := make([]float64, period)
		different, positive := false, 0
		for i := 0; i < 2*period; i++ {
			a.Tick(ai, ao)
			b.Tick(bi, bo)
			c.Tick(ci, co)
			if ao[0] != bo[0] {
				t.Fatal("same seed produced different noise")
			}
			different = different || ao[0] != co[0]
			if ao[0] != -1 && ao[0] != 1 {
				t.Fatalf("invalid noise level %g", ao[0])
			}
			if i < period {
				sequence[i] = ao[0]
				if ao[0] > 0 {
					positive++
				}
			} else if ao[0] != sequence[i-period] {
				t.Fatalf("short=%g: sequence did not repeat after %d samples", short, period)
			}
		}
		if !different || math.Abs(float64(2*positive-period)) != 1 {
			t.Fatalf("degenerate noise: different=%v positive=%d period=%d", different, positive, period)
		}
		for i := 0; i < 23; i++ {
			a.Tick(ai, ao)
		}
		ai[1] = 1
		for i := 0; i < 100; i++ {
			a.Tick(ai, ao)
			closeTo(t, ao[0], sequence[i], 0)
		}
	}
}

func TestNoiseClockAndZeroSeed(t *testing.T) {
	m, in, out := setup(t, "noise", map[string]float64{"freq": 2000}, 8000, 0)
	first := 0.0
	for i := 0; i < 32; i++ {
		m.Tick(in, out)
		if i%4 == 0 {
			first = out[0]
		} else {
			closeTo(t, out[0], first, 0)
		}
	}
	in[0] = 0
	m.Tick(in, out)
	first = out[0]
	for i := 0; i < 100; i++ {
		m.Tick(in, out)
		closeTo(t, out[0], first, 0)
	}
	if m.(*noise).register == 0 {
		t.Fatal("zero seed locked up register")
	}
}
