package engine

import (
	"context"
	"math"
	"reflect"
	"testing"

	"github.com/aquarat/pipe-go-doep/internal/score"
)

func node(channel, id, port, direction string) Probe {
	return Probe{Channel: channel, ProbeRef: score.ProbeRef{Node: id, Port: port, Direction: direction}}
}

func bus(channel, side string) Probe {
	return Probe{Channel: channel, ProbeRef: score.ProbeRef{Bus: side}}
}

func mustProbe(t *testing.T, s *Stream, probes ...Probe) []string {
	t.Helper()
	unresolved, err := s.SetProbes(probes)
	if err != nil {
		t.Fatal(err)
	}
	return unresolved
}

// readProbes reads one block and returns a copy of its probe data.
func readProbes(t *testing.T, s *Stream, frames int) ([]float32, []float32) {
	t.Helper()
	pcm := mustRead(t, s, frames)
	return pcm, append([]float32(nil), s.ProbeData()...)
}

func TestProbesMatchIndependentSineAndBus(t *testing.T) {
	s := mustStream(t, testScore()) // sine 440 Hz -> vca gain .2 -> output gain .5
	if u := mustProbe(t, s, node("y1", "osc", "out", "output"), node("y2", "amp", "in", "input"), node("y3", "amp", "gain", "input"), node("y4", "amp", "out", "output"), bus("x", "left")); len(u) != 0 {
		t.Fatalf("unexpected unresolved %v", u)
	}
	if len(s.ProbeData()) != 0 {
		t.Fatal("probe data before any read")
	}
	phase := 0.0
	for _, n := range []int{1, 300, 77} {
		pcm, probe := readProbes(t, s, n)
		if len(probe) != n*5 {
			t.Fatalf("probe length %d for %d frames", len(probe), n)
		}
		for i := 0; i < n; i++ {
			sine := math.Sin(2 * math.Pi * phase)
			phase += 440.0 / 8000
			if phase >= 1 {
				phase--
			}
			want := []float64{sine, sine, .2, .2 * sine, .1 * sine}
			for ch, w := range want {
				if math.Abs(float64(probe[i*5+ch])-w) > 1e-6 {
					t.Fatalf("frame %d channel %d: got %g want %g", i, ch, probe[i*5+ch], w)
				}
			}
			if probe[i*5+4] != pcm[2*i] {
				t.Fatal("bus probe differs from unclamped PCM")
			}
		}
	}
}

func TestProbeBusIsPreClampAndUnresolvedIsNaN(t *testing.T) {
	d := testScore()
	d.Nodes = []score.Node{{ID: "value", Type: "constant", Params: map[string]float64{"value": 2}}}
	d.Connections = nil
	d.Output = score.Output{Left: "value.out", Right: "value.out", Gain: 1.5}
	s := mustStream(t, d)
	unresolved := mustProbe(t, s, bus("y1", "right"), node("y2", "gone", "out", "output"), node("x", "value", "value", "input"), node("y3", "value", "out", "input"), node("y4", "value", "nope", "output"))
	if !reflect.DeepEqual(unresolved, []string{"y2", "y3", "y4"}) || !reflect.DeepEqual(s.Unresolved(), unresolved) {
		t.Fatalf("unresolved %v", unresolved)
	}
	pcm, probe := readProbes(t, s, 4)
	for i := 0; i < 4; i++ {
		if pcm[2*i] != 1 || probe[i*5] != 3 || probe[i*5+2] != 2 {
			t.Fatalf("frame %d: pcm %g bus %g input %g", i, pcm[2*i], probe[i*5], probe[i*5+2])
		}
		for _, ch := range []int{1, 3, 4} {
			if !math.IsNaN(float64(probe[i*5+ch])) {
				t.Fatal("unresolved channel is not NaN")
			}
		}
	}
}

func TestProbesMatchCompiledPatchAndDoNotChangeAudio(t *testing.T) {
	d := effectsScore()
	plain := collect(t, mustStream(t, d))
	s := mustStream(t, d)
	probes := []Probe{node("y1", "env", "out", "output"), node("y2", "amp", "gain", "input"), node("y3", "osc", "duty", "input"), node("y4", "delay", "out", "output"), bus("x", "right")}
	mustProbe(t, s, probes...)
	p, err := Compile(d)
	if err != nil {
		t.Fatal(err)
	}
	index := map[string]int{}
	for i, u := range p.units {
		index[u.id] = i
	}
	var pcm []float32
	sizes := []int{1, 513, MaxBlockFrames, 61}
	for b := 0; s.Position() < s.Frames(); b++ {
		block, probe := readProbes(t, s, sizes[b%len(sizes)])
		pcm = append(pcm, block...)
		if len(probe) != len(block)/2*5 {
			t.Fatal("probe/frame count mismatch")
		}
		for i := 0; i < len(block)/2; i++ {
			_, right := p.tick()
			want := []float64{
				p.units[index["env"]].outputs[0], p.units[index["amp"]].inputs[1], p.units[index["osc"]].inputs[1],
				p.units[index["delay"]].outputs[0], right,
			}
			for ch, w := range want {
				if probe[i*5+ch] != float32(w) {
					t.Fatalf("channel %s mismatch", probes[ch].Channel)
				}
			}
		}
	}
	if !reflect.DeepEqual(pcm, plain) {
		t.Fatal("probes changed audio output")
	}
	if p.units[index["osc"]].inputs[1] != .3 {
		t.Fatal("duty base value not used")
	}
}

func TestProbesSurviveSeekAndParameterUpdate(t *testing.T) {
	d := effectsScore()
	probes := []Probe{node("y1", "filter", "out", "output"), node("y2", "env", "gate", "input"), bus("x", "left")}
	reference := mustStream(t, d)
	mustProbe(t, reference, probes...)
	var want []float32
	for reference.Position() < reference.Frames() {
		_, probe := readProbes(t, reference, MaxBlockFrames)
		want = append(want, probe...)
	}
	s := mustStream(t, d)
	mustProbe(t, s, probes...)
	mustRead(t, s, 100)
	for _, frame := range []int64{72003, 4011, 0, 64000, 12003} {
		if err := s.Seek(context.Background(), frame); err != nil {
			t.Fatal(err)
		}
		if len(s.ProbeData()) != 0 {
			t.Fatal("seek produced probe data")
		}
		_, probe := readProbes(t, s, 999)
		if !reflect.DeepEqual(probe, want[frame*3:(frame+999)*3]) {
			t.Fatalf("probe after seek to %d differs", frame)
		}
	}

	// A parameter update ramps the unconnected input over 8 ms; the input probe
	// shows the interpolated value the oscillator actually used.
	s = mustStream(t, testScore())
	mustProbe(t, s, node("y1", "osc", "freq", "input"))
	mustRead(t, s, 10)
	d = testScore()
	d.Nodes[1].Params["freq"] = 660
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if len(s.ProbeData()) != 0 || !reflect.DeepEqual(s.Probes(), []Probe{node("y1", "osc", "freq", "input")}) {
		t.Fatal("update dropped probes or kept stale data")
	}
	_, probe := readProbes(t, s, 80)
	for i, v := range probe {
		if w := 440 + 220*math.Min(1, float64(i+1)/64); math.Abs(float64(v)-w) > 1e-4 {
			t.Fatalf("ramp frame %d: got %g want %g", i, v, w)
		}
	}
}

func TestProbesReResolveOnStructuralUpdate(t *testing.T) {
	d := testScore()
	s := mustStream(t, d)
	mustProbe(t, s, node("y1", "osc", "out", "output"), node("y2", "lfo", "out", "output"), bus("x", "left"))
	if !reflect.DeepEqual(s.Unresolved(), []string{"y2"}) {
		t.Fatalf("unresolved %v", s.Unresolved())
	}
	mustRead(t, s, 100)
	// Add lfo before osc so node indices shift; probes must follow ids.
	d.Nodes = []score.Node{d.Nodes[0], {ID: "lfo", Type: "constant", Params: map[string]float64{"value": .25}}, d.Nodes[1]}
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if len(s.Unresolved()) != 0 || len(s.ProbeData()) != 0 {
		t.Fatalf("after adding lfo: unresolved %v", s.Unresolved())
	}
	_, probe := readProbes(t, s, 50)
	control := mustStream(t, d)
	if err := control.Seek(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	pcm := mustRead(t, control, 50)
	for i := 0; i < 50; i++ {
		sine := math.Sin(2 * math.Pi * math.Mod(float64(100+i)*440/8000, 1))
		if math.Abs(float64(probe[i*3])-sine) > 1e-6 || probe[i*3+1] != .25 || probe[i*3+2] != pcm[2*i] {
			t.Fatalf("frame %d after structural update: %v", i, probe[i*3:i*3+3])
		}
	}
	// Deleting the observed oscillator leaves a dangling probe, not an error.
	d.Nodes = d.Nodes[:2]
	d.Connections = []score.Connection{{From: "lfo.out", To: "amp.in"}}
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.Unresolved(), []string{"y1"}) {
		t.Fatalf("unresolved %v", s.Unresolved())
	}
	_, probe = readProbes(t, s, 5)
	if !math.IsNaN(float64(probe[0])) || probe[1] != .25 || probe[2] != .25*.2*.5 {
		t.Fatalf("dangling read %v", probe[:3])
	}
	// A failed update keeps the probes and their resolution.
	d.Output.Gain = -1
	if err := s.Update(context.Background(), d); err == nil {
		t.Fatal("accepted invalid gain")
	}
	if len(s.Probes()) != 3 || !reflect.DeepEqual(s.Unresolved(), []string{"y1"}) {
		t.Fatal("failed update changed probes")
	}
}

func TestSetProbesRejectsInvalidAtomically(t *testing.T) {
	s := mustStream(t, testScore())
	original := []Probe{node("y1", "osc", "out", "output"), bus("x", "right")}
	mustProbe(t, s, original...)
	_, before := readProbes(t, s, 7)
	for name, probes := range map[string][]Probe{
		"too many":      {bus("x", "left"), bus("y1", "left"), bus("y2", "left"), bus("y3", "left"), bus("y4", "left"), bus("y4", "right")},
		"duplicate":     {bus("y1", "left"), node("y1", "osc", "out", "output")},
		"channel":       {bus("y5", "left")},
		"empty channel": {bus("", "left")},
		"bus side":      {bus("y1", "mid")},
		"mixed":         {{Channel: "y1", ProbeRef: score.ProbeRef{Bus: "left", Node: "osc"}}},
		"direction":     {node("y1", "osc", "out", "out")},
		"no ref":        {{Channel: "y1"}},
		"bad id":        {node("y1", "osc.out", "out", "output")},
	} {
		if _, err := s.SetProbes(probes); err == nil {
			t.Fatalf("%s accepted", name)
		}
		if !reflect.DeepEqual(s.Probes(), original) || !reflect.DeepEqual(s.ProbeData(), before) || len(s.Unresolved()) != 0 {
			t.Fatalf("%s changed probe state", name)
		}
	}
	five := []Probe{bus("x", "left"), bus("y1", "left"), bus("y2", "left"), bus("y3", "left"), bus("y4", "left")}
	if u := mustProbe(t, s, five...); len(u) != 0 {
		t.Fatal("five bus probes unresolved")
	}
	if u := mustProbe(t, s); u == nil || len(u) != 0 || len(s.Probes()) != 0 {
		t.Fatal("empty list did not clear")
	}
	if len(mustRead(t, s, 3)) != 6 || len(s.ProbeData()) != 0 {
		t.Fatal("cleared probes still record")
	}
}

func TestProbeCaptureDoesNotAllocatePerSample(t *testing.T) {
	d := effectsScore()
	plain, probed := mustStream(t, d), mustStream(t, d)
	mustProbe(t, probed, node("y1", "osc", "out", "output"), node("y2", "amp", "gain", "input"), node("y3", "gone", "out", "output"), bus("x", "left"), bus("y4", "right"))
	read := func(s *Stream) func() {
		return func() {
			if s.Position()+MaxBlockFrames > s.Frames() {
				if err := s.Seek(context.Background(), 0); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.Read(context.Background(), MaxBlockFrames); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Warm both streams to steady state, then compare allocations per block.
	for i := 0; i < 3; i++ {
		read(plain)()
		read(probed)()
	}
	without, with := testing.AllocsPerRun(20, read(plain)), testing.AllocsPerRun(20, read(probed))
	if with > without {
		t.Fatalf("probe capture allocates: %v allocs/block with probes, %v without", with, without)
	}
}

func benchmarkRead(b *testing.B, probes []Probe) {
	s, err := NewStream(effectsScore())
	if err != nil {
		b.Fatal(err)
	}
	if _, err := s.SetProbes(probes); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if s.Position()+2048 > s.Frames() {
			b.StopTimer()
			if err := s.Seek(context.Background(), 0); err != nil {
				b.Fatal(err)
			}
			b.StartTimer()
		}
		if _, err := s.Read(context.Background(), 2048); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkStreamRead(b *testing.B) { benchmarkRead(b, nil) }

func BenchmarkStreamReadFiveProbes(b *testing.B) {
	benchmarkRead(b, []Probe{node("y1", "osc", "out", "output"), node("y2", "amp", "gain", "input"), node("y3", "filter", "out", "output"), bus("x", "left"), bus("y4", "right")})
}
