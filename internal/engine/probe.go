package engine

import (
	"fmt"
	"math"

	"github.com/aquarat/pipe-go-doep/internal/score"
)

// MaxProbes is the number of oscilloscope channels (x, y1..y4).
const MaxProbes = 5

// Probe observes one signal on an oscilloscope channel. Probes never change
// the patch or its audio output.
type Probe struct {
	Channel string `json:"channel"`
	score.ProbeRef
}

type probeKind uint8

const (
	probeUnresolved probeKind = iota
	probeInput
	probeOutput
	probeLeft
	probeRight
)

type resolvedProbe struct {
	kind       probeKind
	node, port int
}

// ValidateProbes checks channel names, uniqueness, count and reference shape.
// References to missing nodes or ports are valid (they stay unresolved).
func ValidateProbes(probes []Probe) error {
	if len(probes) > MaxProbes {
		return fmt.Errorf("at most %d probes", MaxProbes)
	}
	seen := make(map[string]bool, len(probes))
	for i, p := range probes {
		if !score.ValidScopeChannel(p.Channel) {
			return fmt.Errorf("probes[%d]: channel must be one of x, y1, y2, y3, y4", i)
		}
		if seen[p.Channel] {
			return fmt.Errorf("probes[%d]: duplicate channel %q", i, p.Channel)
		}
		seen[p.Channel] = true
		if err := p.ProbeRef.Validate(); err != nil {
			return fmt.Errorf("probes[%d]: %w", i, err)
		}
	}
	return nil
}

func (p *Patch) resolveProbe(ref score.ProbeRef) resolvedProbe {
	switch ref.Bus {
	case "left":
		return resolvedProbe{kind: probeLeft}
	case "right":
		return resolvedProbe{kind: probeRight}
	}
	for i := range p.units {
		u := &p.units[i]
		if u.id != ref.Node {
			continue
		}
		if ref.Direction == "input" {
			for j, port := range u.module.Inputs() {
				if port.Name == ref.Port {
					return resolvedProbe{probeInput, i, j}
				}
			}
		} else {
			for j, port := range u.module.Outputs() {
				if port == ref.Port {
					return resolvedProbe{probeOutput, i, j}
				}
			}
		}
		break
	}
	return resolvedProbe{}
}

func (s *Stream) resolveProbes() {
	for i, p := range s.probes {
		s.resolved[i] = s.patch.resolveProbe(p.ProbeRef)
	}
}

// SetProbes validates and installs probes, replacing any previous set; an empty
// list clears them. On error nothing changes. It returns the channels whose
// node or port does not exist in the current patch, in probe order. Those
// channels read NaN. Probes persist across Seek and Update (re-resolved).
func (s *Stream) SetProbes(probes []Probe) ([]string, error) {
	if err := ValidateProbes(probes); err != nil {
		return nil, err
	}
	s.probeFrames = 0
	if len(probes) == 0 {
		s.probes, s.resolved, s.probeBuffer = nil, nil, nil
		return []string{}, nil
	}
	s.probes = append([]Probe(nil), probes...)
	s.resolved = make([]resolvedProbe, len(probes))
	if cap(s.probeBuffer) < MaxBlockFrames*len(probes) {
		s.probeBuffer = make([]float32, MaxBlockFrames*len(probes))
	}
	s.probeBuffer = s.probeBuffer[:MaxBlockFrames*len(probes)]
	s.resolveProbes()
	return s.Unresolved(), nil
}

// Probes returns a copy of the installed probes in channel order of the last
// accepted SetProbes call.
func (s *Stream) Probes() []Probe { return append([]Probe(nil), s.probes...) }

// Unresolved lists probe channels that currently resolve to nothing.
func (s *Stream) Unresolved() []string {
	out := []string{}
	for i, r := range s.resolved {
		if r.kind == probeUnresolved {
			out = append(out, s.probes[i].Channel)
		}
	}
	return out
}

// ProbeData returns the probe values recorded by the last successful Read,
// interleaved per frame (frames * len(Probes())). Values are unclamped;
// unresolved channels are NaN. The slice is reused: it is valid only until
// the next Read, Seek, Update or SetProbes, and is empty after those.
func (s *Stream) ProbeData() []float32 {
	return s.probeBuffer[:s.probeFrames*len(s.probes)]
}

func (s *Stream) captureProbes(frame int, left, right float64) {
	row := s.probeBuffer[frame*len(s.resolved) : (frame+1)*len(s.resolved)]
	for i, r := range s.resolved {
		var v float64
		switch r.kind {
		case probeInput:
			v = s.patch.units[r.node].inputs[r.port]
		case probeOutput:
			v = s.patch.units[r.node].outputs[r.port]
		case probeLeft:
			v = left
		case probeRight:
			v = right
		default:
			v = math.NaN()
		}
		row[i] = float32(v)
	}
}
