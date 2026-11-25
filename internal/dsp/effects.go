package dsp

import "math"

type utility struct {
	ports
	kind  string
	gains [4]float64
}

func (m *utility) Tick(in, out []float64) {
	switch m.kind {
	case "constant":
		out[0] = signal(in[0])
	case "vca":
		out[0] = signal(signal(in[0]) * bound(in[1], -16, 16))
	case "mixer":
		var sum float64
		for i, gain := range m.gains {
			sum += signal(in[i]) * gain
		}
		out[0] = signal(sum)
	case "pan":
		x := signal(in[0])
		angle := (bound(in[1], -1, 1) + 1) * math.Pi / 4
		out[0], out[1] = x*math.Cos(angle), x*math.Sin(angle)
	case "drive":
		x, amount := signal(in[0]), bound(in[1], 0, 100)
		if amount < 1e-8 {
			out[0] = x
		} else {
			// Normalize so a unit-amplitude input remains unit-amplitude.
			out[0] = signal(math.Tanh(amount*x) / math.Tanh(amount))
		}
	}
}

// lowpass is a topology-preserving-transform state variable filter with a fixed
// Butterworth damping factor. Coefficients can safely change every sample.
type lowpass struct {
	ports
	sampleRate float64
	s1, s2     float64
	lastCutoff float64
	a1, a2, a3 float64
}

func (f *lowpass) Tick(in, out []float64) {
	cutoff := bound(in[1], 1, .45*f.sampleRate)
	if cutoff != f.lastCutoff {
		g := math.Tan(math.Pi * cutoff / f.sampleRate)
		f.a1 = 1 / (1 + g*(g+math.Sqrt2))
		f.a2 = g * f.a1
		f.a3 = g * f.a2
		f.lastCutoff = cutoff
	}
	v3 := signal(in[0]) - f.s2
	v1 := f.a1*f.s1 + f.a2*v3
	v2 := f.s2 + f.a2*f.s1 + f.a3*v3
	f.s1 = signal(2*v1 - f.s1)
	f.s2 = signal(2*v2 - f.s2)
	out[0] = signal(v2)
}

type delay struct {
	ports
	sampleRate float64
	buffer     []float64
	write      int
}

func (d *delay) Tick(in, out []float64) {
	x := signal(in[0])
	samples := bound(in[1], 0, maxDelaySeconds) * d.sampleRate
	samples = math.Max(1, samples)
	position := float64(d.write) - samples
	if position < 0 {
		position += float64(len(d.buffer))
	}
	// A tiny negative position can round to len(buffer) when wrapped.
	if position >= float64(len(d.buffer)) {
		position = 0
	}
	i := int(position)
	j := i + 1
	if j == len(d.buffer) {
		j = 0
	}
	fraction := position - float64(i)
	wet := d.buffer[i] + fraction*(d.buffer[j]-d.buffer[i])
	d.buffer[d.write] = signal(x + wet*bound(in[2], -.99, .99))
	d.write++
	if d.write == len(d.buffer) {
		d.write = 0
	}
	mix := bound(in[3], 0, 1)
	out[0] = signal(x*(1-mix) + wet*mix)
}

type bitcrusher struct {
	ports
	sampleRate, phase, held float64
	first                   bool
}

func (b *bitcrusher) Tick(in, out []float64) {
	// Capture immediately on the first tick, then at the requested clock rate.
	if b.first || b.phase >= 1 {
		if b.phase >= 1 {
			b.phase--
		}
		b.first = false
		bits := math.Round(bound(in[1], 1, 16))
		levels := math.Exp2(bits) - 1
		x := bound(in[0], -1, 1)
		b.held = 2*math.Round((x+1)*.5*levels)/levels - 1
	}
	out[0] = b.held
	b.phase += bound(in[2], 0, b.sampleRate) / b.sampleRate
}
