package dsp

import (
	"math"
	"unsafe"
)

// Clone copies every mutable sample-processing field. Port metadata is immutable
// and shared; delay history must never alias a running module or another clone.
func Clone(m Module) Module {
	switch m := m.(type) {
	case *oscillator:
		c := *m
		return &c
	case *noise:
		c := *m
		return &c
	case *envelope:
		c := *m
		return &c
	case *utility:
		c := *m
		return &c
	case *lowpass:
		c := *m
		return &c
	case *delay:
		c := *m
		c.buffer = make([]float64, len(m.buffer))
		copy(c.buffer, m.buffer)
		return &c
	case *bitcrusher:
		c := *m
		return &c
	default:
		panic("dsp: unsupported state clone")
	}
}

// StateBytes conservatively accounts for a clone, including immutable metadata
// even though clones share it. Keep this switch in step with Clone and New.
func StateBytes(m Module) int64 {
	var n uintptr
	switch m := m.(type) {
	case *oscillator:
		n = unsafe.Sizeof(*m) + uintptr(len(m.kind))
	case *noise:
		n = unsafe.Sizeof(*m)
	case *envelope:
		n = unsafe.Sizeof(*m)
	case *utility:
		n = unsafe.Sizeof(*m) + uintptr(len(m.kind))
	case *lowpass:
		n = unsafe.Sizeof(*m)
	case *delay:
		// Clone's exact-capacity buffer still has allocator page rounding.
		n = unsafe.Sizeof(*m) + (uintptr(len(m.buffer))*8+8191)/8192*8192
	case *bitcrusher:
		n = unsafe.Sizeof(*m)
	default:
		panic("dsp: unsupported state size")
	}
	n += uintptr(len(m.Inputs()))*unsafe.Sizeof(Port{}) + uintptr(len(m.Outputs()))*unsafe.Sizeof("")
	for _, p := range m.Inputs() {
		n += uintptr(len(p.Name))
	}
	for _, p := range m.Outputs() {
		n += uintptr(len(p))
	}
	// Include allocation headers/rounding, conservatively, for these small objects.
	return int64(n) + 256
}

// Parameters is a small value snapshot of fixed controls, without DSP history.
// Input-port controls are ramped by the graph scheduler. Discrete controls switch
// immediately; continuous fixed controls interpolate without resetting state.
type Parameters struct {
	attack, decay, release int
	sustain                float64
	gains                  [4]float64
	table                  [32]float64
	width                  uint
	initial                uint16
}

func CaptureParameters(m Module) Parameters {
	switch m := m.(type) {
	case *envelope:
		return Parameters{attack: m.attack, decay: m.decay, release: m.release, sustain: m.sustain}
	case *utility:
		return Parameters{gains: m.gains}
	case *oscillator:
		return Parameters{table: m.table}
	case *noise:
		return Parameters{width: m.width, initial: m.initial}
	default:
		return Parameters{}
	}
}

// RampParameters applies validated snapshots of the same module type. fraction
// is in (0,1]. Neither snapshot contains oscillator phase, noise state, envelope
// stage, filter state, or delay memory, so none of those can be reset here.
func RampParameters(m Module, from, to Parameters, fraction float64) {
	lerp := func(a, b float64) float64 { return a + (b-a)*fraction }
	switch m := m.(type) {
	case *envelope:
		m.attack = int(math.Round(lerp(float64(from.attack), float64(to.attack))))
		m.decay = int(math.Round(lerp(float64(from.decay), float64(to.decay))))
		m.release = int(math.Round(lerp(float64(from.release), float64(to.release))))
		previous := m.sustain
		m.sustain = lerp(from.sustain, to.sustain)
		if previous != m.sustain {
			if m.stage == sustain {
				m.level = m.sustain
			} else if m.stage == decay && m.remaining > 0 {
				m.increment = (m.sustain - m.level) / float64(m.remaining)
			}
		}
	case *utility:
		for i := range m.gains {
			m.gains[i] = lerp(from.gains[i], to.gains[i])
		}
	case *oscillator:
		m.table = to.table
	case *noise:
		if m.width != to.width {
			m.width, m.initial = to.width, to.initial
			m.register &= uint16((1 << m.width) - 1)
			if m.register == 0 {
				m.register = 1
			}
		}
	}
}
