package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"unsafe"

	"github.com/aquarat/pipe-go-doep/internal/dsp"
	"github.com/aquarat/pipe-go-doep/internal/score"
)

const (
	MaxBlockFrames           = 8192
	MaxCheckpoints           = 16
	MaxCheckpointBytes int64 = 32 << 20
)

type checkpoint struct {
	position int64
	patch    *Patch
	bytes    int64
}

type unitRamp struct {
	from, to           []float64
	fixedFrom, fixedTo dsp.Parameters
	connected          []bool
}

type parameterRamp struct {
	units            []unitRamp
	fromGain, toGain float64
	step, frames     int
}

// Stream is a single-owner incremental stereo engine. It retains DSP state, not
// a recording. Checkpoints are exact and bounded by both count and retained bytes.
type Stream struct {
	document         *score.Document
	patch            *Patch
	position, frames int64
	checkpoints      []checkpoint
	checkpointBytes  int64
	interval         int64
	canonical        bool
	ramp             *parameterRamp
}

func snapshotDocument(d *score.Document) (*score.Document, error) {
	if err := d.Validate(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	var copy score.Document
	if err := json.Unmarshal(data, &copy); err != nil {
		return nil, err
	}
	return &copy, nil
}

func NewStream(d *score.Document) (*Stream, error) {
	d, err := snapshotDocument(d)
	if err != nil {
		return nil, err
	}
	p, err := Compile(d)
	if err != nil {
		return nil, err
	}
	return &Stream{document: d, patch: p, frames: int64(math.Round((d.Beats*60/d.BPM + d.TailSeconds) * float64(d.SampleRate))), interval: int64(d.SampleRate / 2), canonical: true}, nil
}

func (s *Stream) Position() int64 { return s.position }
func (s *Stream) Frames() int64   { return s.frames }
func (s *Stream) SampleRate() int { return s.document.SampleRate }
func (s *Stream) CheckpointUsage() (count int, bytes int64) {
	return len(s.checkpoints), s.checkpointBytes
}

func (p *Patch) clone() *Patch {
	c := *p
	c.units = make([]unit, len(p.units))
	for i, u := range p.units {
		c.units[i] = u
		c.units[i].inputs = append([]float64(nil), u.inputs...)
		c.units[i].outputs = append([]float64(nil), u.outputs...)
		if seq, ok := u.module.(*sequence); ok {
			copy := *seq
			c.units[i].module = &copy
		} else {
			c.units[i].module = dsp.Clone(u.module)
		}
	}
	return &c
}

func (p *Patch) stateBytes() int64 {
	n := int64(unsafe.Sizeof(*p)) + int64(len(p.order))*int64(unsafe.Sizeof(int(0))) + 256
	for _, u := range p.units {
		n += int64(unsafe.Sizeof(u)) + int64(len(u.id)) + int64(len(u.inputs)+len(u.outputs))*8 + int64(len(u.cables))*int64(unsafe.Sizeof(cable{})) + 256
		if seq, ok := u.module.(*sequence); ok {
			n += int64(unsafe.Sizeof(*seq)) + int64(len(seq.events))*int64(unsafe.Sizeof(score.Event{})) + 64
		} else {
			n += dsp.StateBytes(u.module)
		}
	}
	return n
}

func (s *Stream) saveCheckpoint() {
	if !s.canonical || s.position == 0 || s.position%s.interval != 0 {
		return
	}
	for _, cp := range s.checkpoints {
		if cp.position == s.position {
			return
		}
	}
	n := s.patch.stateBytes() + int64(unsafe.Sizeof(checkpoint{})) + 64
	if n > MaxCheckpointBytes {
		return
	}
	// Evict before cloning so even the transient new checkpoint fits the budget.
	for len(s.checkpoints) >= MaxCheckpoints || s.checkpointBytes+n > MaxCheckpointBytes {
		s.checkpointBytes -= s.checkpoints[0].bytes
		copy(s.checkpoints, s.checkpoints[1:])
		s.checkpoints[len(s.checkpoints)-1] = checkpoint{}
		s.checkpoints = s.checkpoints[:len(s.checkpoints)-1]
	}
	s.checkpoints = append(s.checkpoints, checkpoint{s.position, s.patch.clone(), n})
	s.checkpointBytes += n
}

func (s *Stream) tick() (float64, float64, error) {
	if r := s.ramp; r != nil {
		r.step++
		fraction := float64(r.step) / float64(r.frames)
		for i, ramp := range r.units {
			u := &s.patch.units[i]
			for j := range u.inputs {
				if !ramp.connected[j] {
					u.inputs[j] = ramp.from[j] + (ramp.to[j]-ramp.from[j])*fraction
				}
			}
			dsp.RampParameters(u.module, ramp.fixedFrom, ramp.fixedTo, fraction)
		}
		s.patch.gain = r.fromGain + (r.toGain-r.fromGain)*fraction
		if r.step == r.frames {
			s.ramp = nil
		}
	}
	left, right := s.patch.tick()
	if !finite(left) || !finite(right) {
		return 0, 0, fmt.Errorf("non-finite output at frame %d", s.position)
	}
	s.position++
	s.saveCheckpoint()
	return left, right, nil
}

// Read returns at most frames interleaved stereo float32 frames, clamped [-1,1].
// Empty output at EOF is successful. Invalid block sizes do not advance state.
func (s *Stream) Read(ctx context.Context, frames int) ([]float32, error) {
	if frames < 1 || frames > MaxBlockFrames {
		return nil, fmt.Errorf("frames must be in 1..%d", MaxBlockFrames)
	}
	if remaining := s.frames - s.position; int64(frames) > remaining {
		frames = int(remaining)
	}
	out := make([]float32, frames*2)
	for i := 0; i < frames; i++ {
		if i%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		left, right, err := s.tick()
		if err != nil {
			return nil, err
		}
		out[i*2] = float32(math.Max(-1, math.Min(1, left)))
		out[i*2+1] = float32(math.Max(-1, math.Min(1, right)))
	}
	return out, nil
}

// Seek restores the closest preceding checkpoint then simulates without PCM
// allocation. After a live parameter edit, only latest-project-from-zero states
// qualify as checkpoints; the historical live trajectory is deliberately not used.
func (s *Stream) Seek(ctx context.Context, frame int64) error {
	if frame < 0 || frame > s.frames {
		return fmt.Errorf("frame must be in 0..%d", s.frames)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var nearest *checkpoint
	for i := range s.checkpoints {
		cp := &s.checkpoints[i]
		if cp.position <= frame && (nearest == nil || cp.position > nearest.position) {
			nearest = cp
		}
	}
	if !(s.canonical && s.position <= frame && (nearest == nil || s.position >= nearest.position)) {
		if nearest != nil {
			s.patch = nearest.patch.clone()
			s.position = nearest.position
		} else {
			p, err := Compile(s.document)
			if err != nil {
				return err
			}
			s.patch = p
			s.position = 0
		}
	}
	s.ramp = nil
	s.canonical = true
	for s.position < frame {
		if s.position%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		if _, _, err := s.tick(); err != nil {
			return err
		}
	}
	return nil
}

func sameStructure(a, b *score.Document) bool {
	if a.Version != b.Version || a.SampleRate != b.SampleRate || a.BPM != b.BPM || a.Beats != b.Beats || a.TailSeconds != b.TailSeconds || a.Seed != b.Seed || a.Output.Left != b.Output.Left || a.Output.Right != b.Output.Right || len(a.Nodes) != len(b.Nodes) || !reflect.DeepEqual(a.Connections, b.Connections) || !reflect.DeepEqual(a.Tracks, b.Tracks) {
		return false
	}
	for i, n := range a.Nodes {
		other := b.Nodes[i]
		if n.ID != other.ID || n.Type != other.Type || n.Track != other.Track {
			return false
		}
	}
	return true
}

// Update validates a private replacement before touching the live state. Graph,
// timing, score or seed changes reconstruct at equivalent wall-clock time;
// parameter-only changes preserve history and ramp continuous controls over 8ms.
func (s *Stream) Update(ctx context.Context, d *score.Document) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	replacement, err := NewStream(d)
	if err != nil {
		return err
	}
	if !sameStructure(s.document, replacement.document) {
		frame := int64(math.Round(float64(s.position) * float64(replacement.SampleRate()) / float64(s.SampleRate())))
		if frame > replacement.frames {
			frame = replacement.frames
		}
		if err := replacement.Seek(ctx, frame); err != nil {
			return err
		}
		*s = *replacement
		return nil
	}
	r := &parameterRamp{units: make([]unitRamp, len(s.patch.units)), fromGain: s.patch.gain, toGain: replacement.patch.gain, frames: int(math.Round(float64(s.SampleRate()) * .008))}
	for i, u := range s.patch.units {
		target := replacement.patch.units[i]
		ramp := unitRamp{from: append([]float64(nil), u.inputs...), to: append([]float64(nil), target.inputs...), fixedFrom: dsp.CaptureParameters(u.module), fixedTo: dsp.CaptureParameters(target.module), connected: make([]bool, len(u.inputs))}
		for _, c := range u.cables {
			ramp.connected[c.input] = true
		}
		r.units[i] = ramp
	}
	s.document = replacement.document
	s.checkpoints = nil
	s.checkpointBytes = 0
	s.canonical = false
	s.ramp = r
	return nil
}
