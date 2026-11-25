// Package score parses, validates, and schedules version 1 synthesizer scores.
package score

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Limits apply to the whole document, including unused patterns and order
// entries after the audible end. This bounds work before rendering begins.
const (
	MaxJSONBytes     = 4 << 20
	MaxTracks        = 32
	MaxNodes         = 128
	MaxConnections   = 1024
	MaxPatterns      = 1024
	MaxSteps         = 65536
	MaxOrderEntries  = 16384
	MaxExpandedSteps = 262144
	MaxEvents        = 131072
	MaxParamsPerNode = 32
	MaxTreeExpanded  = 4096
	MaxTreePathBytes = 1024
)

type Document struct {
	Version     int          `json:"version"`
	ID          string       `json:"id,omitempty"`
	UI          *UIState     `json:"_ui,omitempty"`
	Title       string       `json:"title"`
	SampleRate  int          `json:"sample_rate"`
	BPM         float64      `json:"bpm"`
	Beats       float64      `json:"beats"`
	TailSeconds float64      `json:"tail_seconds"`
	Seed        uint64       `json:"seed"`
	Tracks      []Track      `json:"tracks"`
	Nodes       []Node       `json:"nodes"`
	Connections []Connection `json:"connections"`
	Output      Output       `json:"output"`
}

// UIState travels with the document but does not affect scheduling or DSP.
// TreeExpanded contains JSON Pointers; the empty string identifies the root.
// Missing paths (including when UIState is absent) are collapsed by default.
type UIState struct {
	TreeExpanded []string `json:"tree_expanded,omitempty"`
}

type Track struct {
	ID        string            `json:"id"`
	Patterns  map[string][]Step `json:"patterns"`
	Order     []string          `json:"order"`
	Transpose int               `json:"transpose"`
}

type Step struct {
	Note     string   `json:"note"`
	Beats    float64  `json:"beats"`
	Velocity *float64 `json:"velocity,omitempty"`
	Gate     *float64 `json:"gate,omitempty"`
}

type Node struct {
	ID     string             `json:"id"`
	Type   string             `json:"type"`
	Params map[string]float64 `json:"params,omitempty"`
	Track  string             `json:"track,omitempty"`
}

type Connection struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type Output struct {
	Left  string  `json:"left"`
	Right string  `json:"right"`
	Gain  float64 `json:"gain"`
}

// Event uses absolute sample indices; End is exclusive.
type Event struct {
	Start     int64
	End       int64
	Frequency float64
	Velocity  float64
}

// Parse decodes exactly one JSON object and validates it. The byte cap also
// bounds allocation while decoding untrusted input, before semantic limits run.
func Parse(r io.Reader) (*Document, error) {
	b, err := io.ReadAll(io.LimitReader(r, MaxJSONBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read score: %w", err)
	}
	if len(b) > MaxJSONBytes {
		return nil, fmt.Errorf("score exceeds %d JSON bytes", MaxJSONBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var d *Document
	if err := dec.Decode(&d); err != nil {
		return nil, fmt.Errorf("decode score: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		if err != nil {
			return nil, fmt.Errorf("trailing score data: %w", err)
		}
		return nil, fmt.Errorf("score must contain exactly one JSON object")
	}
	if err := d.Validate(); err != nil {
		return nil, err
	}
	return d, nil
}

var identifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`)
var pitch = regexp.MustCompile(`^([A-Ga-g])([#b]?)(-?[0-9]{1,2})$`)
var uuid = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func validJSONPointer(path string) bool {
	if path != "" && path[0] != '/' {
		return false
	}
	for i := 0; i < len(path); i++ {
		if path[i] == '~' {
			if i+1 == len(path) || (path[i+1] != '0' && path[i+1] != '1') {
				return false
			}
			i++
		}
	}
	return true
}

func bounded(x, low, high float64) bool {
	return !math.IsNaN(x) && !math.IsInf(x, 0) && x >= low && x <= high
}

func noteNumber(note string, transpose int) (int, error) {
	m := pitch.FindStringSubmatch(note)
	if m == nil {
		return 0, fmt.Errorf("invalid scientific pitch %q", note)
	}
	octave, _ := strconv.Atoi(m[3])
	semitone := map[string]int{"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[strings.ToUpper(m[1])]
	if m[2] == "#" {
		semitone++
	} else if m[2] == "b" {
		semitone--
	}
	n := (octave+1)*12 + semitone
	if n < 0 || n > 127 || n+transpose < 0 || n+transpose > 127 {
		return 0, fmt.Errorf("pitch %q with transpose %d is outside MIDI 0..127", note, transpose)
	}
	return n + transpose, nil
}

// Validate checks score-level structure, resource limits, and node references.
// The engine additionally validates module types, parameters, ports, and cycles.
func (d *Document) Validate() error {
	if d == nil {
		return fmt.Errorf("score must be a JSON object")
	}
	if d.Version != 1 {
		return fmt.Errorf("version must be 1")
	}
	if d.ID != "" && !uuid.MatchString(d.ID) {
		return fmt.Errorf("id must be a canonical UUID with version 1..8 and variant 8, 9, a, or b")
	}
	if d.UI != nil {
		if len(d.UI.TreeExpanded) > MaxTreeExpanded {
			return fmt.Errorf("_ui.tree_expanded exceeds %d paths", MaxTreeExpanded)
		}
		seen := make(map[string]bool, len(d.UI.TreeExpanded))
		for i, path := range d.UI.TreeExpanded {
			if len(path) > MaxTreePathBytes || !validJSONPointer(path) {
				return fmt.Errorf("_ui.tree_expanded[%d] must be a JSON Pointer of at most %d bytes", i, MaxTreePathBytes)
			}
			if seen[path] {
				return fmt.Errorf("_ui.tree_expanded[%d] duplicates a path", i)
			}
			seen[path] = true
		}
	}
	if len(d.Title) > 1024 {
		return fmt.Errorf("title exceeds 1024 bytes")
	}
	if d.SampleRate < 8000 || d.SampleRate > 96000 {
		return fmt.Errorf("sample_rate must be in 8000..96000")
	}
	if !bounded(d.BPM, 1, 1000) {
		return fmt.Errorf("bpm must be finite and in 1..1000")
	}
	if !bounded(d.Beats, 0, 5000) || d.Beats == 0 {
		return fmt.Errorf("beats must be finite and in (0,5000]")
	}
	if !bounded(d.TailSeconds, 0, 300) || d.Beats*60/d.BPM+d.TailSeconds > 300 {
		return fmt.Errorf("total duration including tail_seconds must not exceed 300 seconds")
	}
	if math.Round((d.Beats*60/d.BPM+d.TailSeconds)*float64(d.SampleRate)) < 1 {
		return fmt.Errorf("total duration rounds to zero WAV frames; increase beats or tail_seconds")
	}
	if !bounded(d.Output.Gain, 0, 16) {
		return fmt.Errorf("output gain must be finite and in 0..16")
	}
	if len(d.Tracks) > MaxTracks || len(d.Nodes) == 0 || len(d.Nodes) > MaxNodes || len(d.Connections) > MaxConnections {
		return fmt.Errorf("score requires 1..%d nodes, at most %d tracks and %d connections", MaxNodes, MaxTracks, MaxConnections)
	}
	tracks := make(map[string]bool, len(d.Tracks))
	patterns, steps, orders, expanded, events := 0, 0, 0, 0, 0
	for _, t := range d.Tracks {
		if !identifier.MatchString(t.ID) || tracks[t.ID] {
			return fmt.Errorf("invalid or duplicate track id %q", t.ID)
		}
		tracks[t.ID] = true
		if t.Transpose < -127 || t.Transpose > 127 {
			return fmt.Errorf("track %q transpose must be in -127..127", t.ID)
		}
		patterns += len(t.Patterns)
		orders += len(t.Order)
		if len(t.Patterns) == 0 || len(t.Order) == 0 || patterns > MaxPatterns || orders > MaxOrderEntries {
			return fmt.Errorf("track %q requires patterns and order; document limits are %d patterns and %d order entries", t.ID, MaxPatterns, MaxOrderEntries)
		}
		noteCounts := make(map[string]int, len(t.Patterns))
		for name, pattern := range t.Patterns {
			steps += len(pattern)
			if !identifier.MatchString(name) || len(pattern) == 0 || steps > MaxSteps {
				return fmt.Errorf("track %q invalid/empty pattern %q or document exceeds %d stored steps", t.ID, name, MaxSteps)
			}
			for i, s := range pattern {
				if !bounded(s.Beats, 0.000001, 5000) {
					return fmt.Errorf("track %q pattern %q step %d beats must be finite and in 0.000001..5000", t.ID, name, i)
				}
				if s.Velocity != nil && !bounded(*s.Velocity, 0, 1) {
					return fmt.Errorf("track %q pattern %q step %d velocity must be in 0..1", t.ID, name, i)
				}
				if s.Gate != nil && !bounded(*s.Gate, 0, 1) {
					return fmt.Errorf("track %q pattern %q step %d gate must be in 0..1", t.ID, name, i)
				}
				if s.Note != "." {
					if _, err := noteNumber(s.Note, t.Transpose); err != nil {
						return fmt.Errorf("track %q pattern %q step %d: %w", t.ID, name, i, err)
					}
					noteCounts[name]++
				}
			}
		}
		for _, name := range t.Order {
			pattern, ok := t.Patterns[name]
			if !ok {
				return fmt.Errorf("track %q order references missing pattern %q", t.ID, name)
			}
			expanded += len(pattern)
			events += noteCounts[name]
			if expanded > MaxExpandedSteps || events > MaxEvents {
				return fmt.Errorf("order repetition exceeds document limits of %d expanded steps or %d note events", MaxExpandedSteps, MaxEvents)
			}
		}
	}
	nodes := make(map[string]bool, len(d.Nodes))
	for _, n := range d.Nodes {
		if !identifier.MatchString(n.ID) || nodes[n.ID] {
			return fmt.Errorf("invalid or duplicate node id %q", n.ID)
		}
		nodes[n.ID] = true
		if !identifier.MatchString(n.Type) || len(n.Params) > MaxParamsPerNode {
			return fmt.Errorf("node %q has invalid type or more than %d parameters", n.ID, MaxParamsPerNode)
		}
		for name, value := range n.Params {
			if !identifier.MatchString(name) || !bounded(value, -1e9, 1e9) {
				return fmt.Errorf("node %q parameter %q must have a valid name and finite value in -1e9..1e9", n.ID, name)
			}
		}
		if n.Type == "sequence" {
			if !tracks[n.Track] || len(n.Params) != 0 {
				return fmt.Errorf("sequence node %q requires an existing track and no parameters", n.ID)
			}
		} else if n.Track != "" {
			return fmt.Errorf("only sequence nodes may reference a track (node %q)", n.ID)
		}
	}
	checkRef := func(ref string) error {
		parts := strings.Split(ref, ".")
		if len(parts) != 2 || !identifier.MatchString(parts[0]) || !identifier.MatchString(parts[1]) || !nodes[parts[0]] {
			return fmt.Errorf("invalid or unknown node.port reference %q", ref)
		}
		return nil
	}
	inputs := make(map[string]bool, len(d.Connections))
	for _, c := range d.Connections {
		if err := checkRef(c.From); err != nil {
			return err
		}
		if err := checkRef(c.To); err != nil {
			return err
		}
		if inputs[c.To] {
			return fmt.Errorf("multiple connections to input %q", c.To)
		}
		inputs[c.To] = true
	}
	if err := checkRef(d.Output.Left); err != nil {
		return err
	}
	return checkRef(d.Output.Right)
}

// CompileTrack schedules the explicitly ordered patterns. Each boundary is
// rounded from its absolute beat position, never from a rounded step length.
// Emitted onsets must be at least two samples apart so one-sample trigger pulses
// have a low sample between them for rising-edge ADSR/reset inputs.
func (d *Document) CompileTrack(id string) ([]Event, error) {
	if err := d.Validate(); err != nil {
		return nil, err
	}
	var track *Track
	for i := range d.Tracks {
		if d.Tracks[i].ID == id {
			track = &d.Tracks[i]
			break
		}
	}
	if track == nil {
		return nil, fmt.Errorf("unknown track %q", id)
	}
	samplesPerBeat := 60 / d.BPM * float64(d.SampleRate)
	endSample := int64(math.Round(d.Beats * samplesPerBeat))
	result := make([]Event, 0)
	beat, compensation := 0.0, 0.0
	for _, name := range track.Order {
		for _, step := range track.Patterns[name] {
			if beat >= d.Beats {
				return result, nil
			}
			startBeat := beat
			// Compensated summation prevents repeated fractional beats from
			// accumulating avoidable floating-point error across long orders.
			y := step.Beats - compensation
			next := beat + y
			compensation = (next - beat) - y
			beat = next
			if step.Note == "." {
				continue
			}
			gate, velocity := 0.85, 1.0
			if step.Gate != nil {
				gate = *step.Gate
			}
			if step.Velocity != nil {
				velocity = *step.Velocity
			}
			start := int64(math.Round(startBeat * samplesPerBeat))
			endBeat := math.Min(startBeat+step.Beats*gate, beat)
			if gate == 1 {
				// Share the exact compensated boundary with the next onset.
				endBeat = beat
			}
			end := min(int64(math.Round(endBeat*samplesPerBeat)), endSample)
			if end <= start {
				continue
			}
			if len(result) > 0 && start-result[len(result)-1].Start < 2 {
				return nil, fmt.Errorf("track %q note onsets at samples %d and %d must be at least 2 samples apart for distinct triggers; lengthen steps, add a rest, or increase sample_rate", id, result[len(result)-1].Start, start)
			}
			note, _ := noteNumber(step.Note, track.Transpose) // Validated above.
			result = append(result, Event{Start: start, End: end, Frequency: 440 * math.Exp2(float64(note-69)/12), Velocity: velocity})
		}
	}
	return result, nil
}
