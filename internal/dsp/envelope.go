package dsp

import "math"

type envelopeStage uint8

const (
	idle envelopeStage = iota
	attack
	decay
	sustain
	release
)

type envelope struct {
	ports
	attack, decay, release int
	sustain                float64
	stage                  envelopeStage
	remaining              int
	level, increment       float64
	wasGate, wasTrigger    bool
}

func frames(seconds, sampleRate float64) int {
	return int(math.Ceil(seconds * sampleRate))
}

func (e *envelope) enter(stage envelopeStage, duration int, target float64) {
	e.stage = stage
	e.remaining = duration
	e.increment = 0
	if duration > 0 {
		e.increment = (target - e.level) / float64(duration)
	}
}

func (e *envelope) next() {
	switch e.stage {
	case attack:
		e.level = 1
		e.enter(decay, e.decay, e.sustain)
	case decay:
		e.level = e.sustain
		e.stage = sustain
	case release:
		e.level = 0
		e.stage = idle
	}
}

func (e *envelope) Tick(in, out []float64) {
	gate := bound(in[0], 0, 1) > .5
	trigger := bound(in[1], 0, 1) > .5
	if gate && (!e.wasGate || (trigger && !e.wasTrigger)) {
		// Restart from the current value, avoiding a discontinuous drop to zero.
		e.enter(attack, e.attack, 1)
	} else if !gate && e.wasGate {
		e.enter(release, e.release, 0)
	}
	e.wasGate, e.wasTrigger = gate, trigger
	// Zero-time stages are skipped immediately, with at most three transitions.
	for e.stage != idle && e.stage != sustain && e.remaining == 0 {
		e.next()
	}
	if e.remaining > 0 && e.stage != idle && e.stage != sustain {
		e.level += e.increment
		e.remaining--
		if e.remaining == 0 {
			e.next()
		}
	}
	out[0] = bound(e.level, 0, 1)
}
