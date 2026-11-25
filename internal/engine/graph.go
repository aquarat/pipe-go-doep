// Package engine compiles patch cables into a sample-accurate signal graph.
package engine

import (
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/aquarat/pipe-go-doep/internal/dsp"
	"github.com/aquarat/pipe-go-doep/internal/score"
)

type cable struct{ source, output, input int }
type unit struct {
	id              string
	module          dsp.Module
	inputs, outputs []float64
	cables          []cable
}
type endpoint struct{ node, port int }

// Patch owns all mutable module state. Construct a fresh Patch for each render.
// No allocations or string lookups occur in the per-sample scheduling loop.
type Patch struct {
	units       []unit
	order       []int
	left, right endpoint
	gain        float64
}

// Compile validates ports and cables and rejects algebraic loops. Internal
// feedback (for example a delay's feedback knob) belongs to the module itself.
func Compile(d *score.Document) (*Patch, error) {
	if err := d.Validate(); err != nil {
		return nil, err
	}
	p := &Patch{gain: d.Output.Gain}
	ids := make(map[string]int, len(d.Nodes))
	for i, n := range d.Nodes {
		var m dsp.Module
		var err error
		if n.Type == "sequence" {
			if len(n.Params) != 0 {
				return nil, fmt.Errorf("node %q: sequence has no parameters", n.ID)
			}
			var events []score.Event
			events, err = d.CompileTrack(n.Track)
			m = &sequence{events: events, frequency: 440}
		} else {
			if n.Track != "" {
				return nil, fmt.Errorf("node %q: only sequence nodes accept track", n.ID)
			}
			// Node-index-derived seeds make identical patches reproducible while
			// keeping separate noise generators decorrelated.
			m, err = dsp.New(n.Type, n.Params, d.SampleRate, d.Seed+uint64(i+1)*0x9e3779b97f4a7c15)
		}
		if err != nil {
			return nil, fmt.Errorf("node %q: %w", n.ID, err)
		}
		u := unit{id: n.ID, module: m, inputs: make([]float64, len(m.Inputs())), outputs: make([]float64, len(m.Outputs()))}
		for j, port := range m.Inputs() {
			u.inputs[j] = port.Default
		}
		ids[n.ID] = i
		p.units = append(p.units, u)
	}
	resolve := func(ref string, input bool) (endpoint, error) {
		name, port, ok := strings.Cut(ref, ".")
		i, exists := ids[name]
		if !ok || !exists {
			return endpoint{}, fmt.Errorf("unknown endpoint %q (use node.port)", ref)
		}
		if input {
			for j, candidate := range p.units[i].module.Inputs() {
				if candidate.Name == port {
					return endpoint{i, j}, nil
				}
			}
		} else {
			for j, candidate := range p.units[i].module.Outputs() {
				if candidate == port {
					return endpoint{i, j}, nil
				}
			}
		}
		direction := "output"
		if input {
			direction = "input"
		}
		return endpoint{}, fmt.Errorf("unknown %s port %q", direction, ref)
	}
	indegree := make([]int, len(p.units))
	children := make([][]int, len(p.units))
	occupied := make(map[endpoint]bool)
	for _, c := range d.Connections {
		from, err := resolve(c.From, false)
		if err != nil {
			return nil, err
		}
		to, err := resolve(c.To, true)
		if err != nil {
			return nil, err
		}
		if occupied[to] {
			return nil, fmt.Errorf("multiple cables into %q; use a mixer", c.To)
		}
		occupied[to] = true
		p.units[to.node].cables = append(p.units[to.node].cables, cable{from.node, from.port, to.port})
		indegree[to.node]++
		children[from.node] = append(children[from.node], to.node)
	}
	queue := make([]int, 0, len(p.units))
	for i, n := range indegree {
		if n == 0 {
			queue = append(queue, i)
		}
	}
	for head := 0; head < len(queue); head++ {
		i := queue[head]
		p.order = append(p.order, i)
		for _, j := range children[i] {
			indegree[j]--
			if indegree[j] == 0 {
				queue = append(queue, j)
			}
		}
	}
	if len(p.order) != len(p.units) {
		return nil, fmt.Errorf("patch contains a cycle; use a delay module's internal feedback")
	}
	var err error
	p.left, err = resolve(d.Output.Left, false)
	if err != nil {
		return nil, err
	}
	p.right, err = resolve(d.Output.Right, false)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Patch) tick() (float64, float64) {
	for _, i := range p.order {
		u := &p.units[i]
		for _, c := range u.cables {
			u.inputs[c.input] = p.units[c.source].outputs[c.output]
		}
		u.module.Tick(u.inputs, u.outputs)
	}
	return p.units[p.left.node].outputs[p.left.port] * p.gain, p.units[p.right.node].outputs[p.right.port] * p.gain
}

type sequence struct {
	events    []score.Event
	index     int
	sample    int64
	frequency float64
	velocity  float64
}

func (*sequence) Inputs() []dsp.Port { return nil }
func (*sequence) Outputs() []string  { return []string{"freq", "gate", "velocity", "trigger"} }
func (s *sequence) Tick(_ []float64, out []float64) {
	for s.index < len(s.events) && s.events[s.index].End <= s.sample {
		s.index++
	}
	out[1], out[3] = 0, 0
	if s.index < len(s.events) {
		e := s.events[s.index]
		if s.sample >= e.Start && s.sample < e.End {
			s.frequency = e.Frequency
			s.velocity = e.Velocity
			out[1] = 1
			if s.sample == e.Start {
				out[3] = 1
			}
		}
	}
	out[0] = s.frequency
	out[2] = s.velocity
	s.sample++
}

// WriteDOT emits a portable Graphviz view of the patch, without needing Graphviz
// installed to render audio. Compile first to validate the graph.
func WriteDOT(w io.Writer, d *score.Document) error {
	var b strings.Builder
	b.WriteString("digraph patch {\n  rankdir=LR;\n  node [shape=box];\n")
	for _, n := range d.Nodes {
		fmt.Fprintf(&b, "  %q [label=%q];\n", n.ID, n.ID+"\n"+n.Type)
	}
	for _, c := range d.Connections {
		from, fp, _ := strings.Cut(c.From, ".")
		to, tp, _ := strings.Cut(c.To, ".")
		fmt.Fprintf(&b, "  %q -> %q [label=%q];\n", from, to, fp+" → "+tp)
	}
	fmt.Fprintf(&b, "  \"$output\" [label=\"Stereo output\",shape=oval];\n")
	for _, r := range []string{d.Output.Left, d.Output.Right} {
		name, port, _ := strings.Cut(r, ".")
		fmt.Fprintf(&b, "  %q -> \"$output\" [label=%q];\n", name, port)
	}
	b.WriteString("}\n")
	_, err := io.WriteString(w, b.String())
	return err
}

func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }
