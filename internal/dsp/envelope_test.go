package dsp

import "testing"

func TestADSRTiming(t *testing.T) {
	m, in, out := setup(t, "adsr", map[string]float64{"attack": .0005, "decay": .0005, "sustain": .25, "release": .0005}, 8000, 0)
	m.Tick(in, out)
	closeTo(t, out[0], 0, 0)
	in[0] = 1
	for _, want := range []float64{.25, .5, .75, 1, .8125, .625, .4375, .25, .25, .25} {
		m.Tick(in, out)
		closeTo(t, out[0], want, 1e-12)
	}
	in[0] = 0
	for _, want := range []float64{.1875, .125, .0625, 0, 0} {
		m.Tick(in, out)
		closeTo(t, out[0], want, 1e-12)
	}
}

func TestADSRRetriggerFromCurrentLevel(t *testing.T) {
	m, in, out := setup(t, "adsr", map[string]float64{"attack": .0005, "decay": 0, "sustain": .25, "release": .0005}, 8000, 0)
	in[0] = 1
	for i := 0; i < 8; i++ {
		m.Tick(in, out)
	}
	closeTo(t, out[0], .25, 0)
	in[1] = 1
	// A sustained trigger causes one retrigger, not one on every sample.
	for _, want := range []float64{.4375, .625, .8125, 1, .25} {
		m.Tick(in, out)
		closeTo(t, out[0], want, 1e-12)
	}
	in[0], in[1] = 0, 0
	m.Tick(in, out)
	closeTo(t, out[0], .1875, 1e-12)
	in[0] = 1
	m.Tick(in, out)
	closeTo(t, out[0], .1875+(1-.1875)/4, 1e-12)
}

func TestADSRZeroTimesAndEarlyRelease(t *testing.T) {
	m, in, out := setup(t, "adsr", map[string]float64{"attack": 0, "decay": 0, "sustain": .6, "release": 0}, 8000, 0)
	in[0] = 1
	m.Tick(in, out)
	closeTo(t, out[0], .6, 0)
	in[0] = 0
	m.Tick(in, out)
	closeTo(t, out[0], 0, 0)
	in[1] = 1
	m.Tick(in, out)
	closeTo(t, out[0], 0, 0) // An ADSR trigger is qualified by gate.

	m, in, out = setup(t, "adsr", map[string]float64{"attack": .001, "release": .00025}, 8000, 0)
	in[0] = 1
	m.Tick(in, out)
	m.Tick(in, out)
	closeTo(t, out[0], .25, 0)
	in[0] = 0
	m.Tick(in, out)
	closeTo(t, out[0], .125, 0)
	m.Tick(in, out)
	closeTo(t, out[0], 0, 0)
}
