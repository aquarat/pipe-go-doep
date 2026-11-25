package dsp

import "math"

type oscillator struct {
	ports
	kind              string
	sampleRate, phase float64
	wasReset          bool
	table             [32]float64
}

// polyBLEP corrects a unit discontinuity over the samples on either side of it.
func polyBLEP(phase, increment float64) float64 {
	if increment <= 0 {
		return 0
	}
	if phase < increment {
		x := phase / increment
		return 2*x - x*x - 1
	}
	if phase > 1-increment {
		x := (phase - 1) / increment
		return x*x + 2*x + 1
	}
	return 0
}

func (o *oscillator) Tick(in, out []float64) {
	resetIndex := 1
	if o.kind == "pulse" {
		resetIndex = 2
	}
	reset := bound(in[resetIndex], 0, 1) > .5
	if reset && !o.wasReset {
		o.phase = 0
	}
	o.wasReset = reset
	dt := bound(in[0], 0, .45*o.sampleRate) / o.sampleRate
	phase := o.phase
	var y float64
	switch o.kind {
	case "sine":
		y = math.Sin(2 * math.Pi * phase)
	case "saw":
		y = 2*phase - 1 - polyBLEP(phase, dt)
	case "pulse":
		// Keeping edges at least one increment apart avoids overlapping BLEPs
		// at narrow duties/high pitches. The effective duty narrows toward .5.
		duty := bound(in[1], math.Max(.01, dt), math.Min(.99, 1-dt))
		y = -1
		if phase < duty {
			y = 1
		}
		edge := phase - duty
		if edge < 0 {
			edge++
		}
		y += polyBLEP(phase, dt) - polyBLEP(edge, dt)
	case "triangle":
		y = 1 - 4*math.Abs(phase-.5)
	case "wavetable":
		y = o.table[int(phase*32)]
	}
	out[0] = y
	o.phase += dt
	if o.phase >= 1 {
		o.phase--
	}
}

type noise struct {
	ports
	sampleRate, phase float64
	initial, register uint16
	width             uint
	wasReset          bool
}

func (n *noise) Tick(in, out []float64) {
	reset := bound(in[1], 0, 1) > .5
	if reset && !n.wasReset {
		n.register = n.initial
		n.phase = 0
	}
	n.wasReset = reset
	out[0] = 1 - 2*float64(n.register&1)
	n.phase += bound(in[0], 0, n.sampleRate) / n.sampleRate
	if n.phase >= 1 {
		n.phase--
		feedback := (n.register ^ (n.register >> 1)) & 1
		n.register = (n.register >> 1) | (feedback << (n.width - 1))
	}
}
