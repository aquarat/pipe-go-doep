package engine

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"reflect"
	"testing"

	"github.com/aquarat/pipe-go-doep/internal/score"
)

func effectsScore() *score.Document {
	d := testScore()
	d.Beats, d.TailSeconds = 20, 2
	d.Tracks = []score.Track{{ID: "melody", Patterns: map[string][]score.Step{"a": {
		{Note: "A3", Beats: .125}, {Note: "C4", Beats: .25}, {Note: ".", Beats: .125}, {Note: "G3", Beats: .5},
	}}, Order: []string{"a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a"}}}
	d.Nodes = []score.Node{
		{ID: "seq", Type: "sequence", Track: "melody"},
		{ID: "osc", Type: "pulse", Params: map[string]float64{"duty": .3}},
		{ID: "noise", Type: "noise", Params: map[string]float64{"freq": 3017}},
		{ID: "mix", Type: "mixer", Params: map[string]float64{"gain_a": .4, "gain_b": .13}},
		{ID: "env", Type: "adsr", Params: map[string]float64{"attack": .003, "decay": .013, "sustain": .4, "release": .12}},
		{ID: "amp", Type: "vca"},
		{ID: "filter", Type: "lowpass", Params: map[string]float64{"cutoff": 1700}},
		{ID: "delay", Type: "delay", Params: map[string]float64{"time": .1371, "feedback": .63, "mix": .51}},
		{ID: "crush", Type: "bitcrush", Params: map[string]float64{"bits": 9, "rate": 3321}},
		{ID: "drive", Type: "drive", Params: map[string]float64{"amount": 1.7}},
		{ID: "pan", Type: "pan", Params: map[string]float64{"pan": -.3}},
	}
	d.Connections = []score.Connection{
		{From: "seq.freq", To: "osc.freq"}, {From: "seq.gate", To: "env.gate"}, {From: "seq.trigger", To: "env.trigger"},
		{From: "osc.out", To: "mix.a"}, {From: "noise.out", To: "mix.b"}, {From: "mix.out", To: "amp.in"}, {From: "env.out", To: "amp.gain"},
		{From: "amp.out", To: "filter.in"}, {From: "filter.out", To: "delay.in"}, {From: "delay.out", To: "crush.in"},
		{From: "crush.out", To: "drive.in"}, {From: "drive.out", To: "pan.in"},
	}
	d.Output = score.Output{Left: "pan.left", Right: "pan.right", Gain: .7}
	return d
}

func mustStream(t *testing.T, d *score.Document) *Stream {
	t.Helper()
	s, err := NewStream(d)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mustRead(t *testing.T, s *Stream, frames int) []float32 {
	t.Helper()
	pcm, err := s.Read(context.Background(), frames)
	if err != nil {
		t.Fatal(err)
	}
	return pcm
}

func collect(t *testing.T, s *Stream) []float32 {
	t.Helper()
	var pcm []float32
	sizes := []int{1, 127, 2048, 63, MaxBlockFrames, 777}
	for i := 0; s.Position() < s.Frames(); i++ {
		pcm = append(pcm, mustRead(t, s, sizes[i%len(sizes)])...)
	}
	return pcm
}

func TestLiveBlocksMatchOfflineWithEffectsAndNoise(t *testing.T) {
	d := effectsScore()
	s := mustStream(t, d)
	pcm := collect(t, s)
	if len(pcm) != int(s.Frames())*2 || len(mustRead(t, s, 1)) != 0 {
		t.Fatal("bad EOF/frame count")
	}
	p, err := Compile(d)
	if err != nil {
		t.Fatal(err)
	}
	for frame := int64(0); frame < s.Frames(); frame++ {
		left, right := p.tick()
		for ch, sample := range []float64{left, right} {
			want := float32(math.Max(-1, math.Min(1, sample)))
			if pcm[int(frame)*2+ch] != want {
				t.Fatalf("block mismatch frame %d channel %d", frame, ch)
			}
		}
	}
	var wav bytes.Buffer
	if _, err := Render(context.Background(), d, &wav); err != nil {
		t.Fatal(err)
	}
	for i, sample := range pcm {
		want := int16(binary.LittleEndian.Uint16(wav.Bytes()[44+i*2:]))
		// Float32 conversion may straddle a PCM16 rounding boundary by one LSB.
		if math.Abs(float64(want)-math.Round(float64(sample)*32767)) > 1 {
			t.Fatalf("WAV mismatch sample %d", i)
		}
	}
	if count, _ := s.CheckpointUsage(); count != MaxCheckpoints {
		t.Fatalf("count cap not exercised: %d", count)
	}
}

func TestLiveSeekRepeatedForwardBackwardExact(t *testing.T) {
	d := effectsScore()
	reference := collect(t, mustStream(t, d))
	s := mustStream(t, d)
	// Cross envelope/sequence edges, checkpoint edges, delay wraps, and eviction.
	for _, frame := range []int64{72003, 4011, 64000, 0, 3999, 4000, 4001, 12003, 93900, 2048, 64000, 4011, 72003, 0} {
		if err := s.Seek(context.Background(), frame); err != nil {
			t.Fatal(err)
		}
		pcm := mustRead(t, s, 2011)
		want := reference[int(frame)*2 : int(frame)*2+len(pcm)]
		if !reflect.DeepEqual(pcm, want) {
			t.Fatalf("non-exact seek at %d", frame)
		}
	}
	if err := s.Seek(context.Background(), s.Frames()); err != nil {
		t.Fatal(err)
	}
	if len(mustRead(t, s, 8)) != 0 {
		t.Fatal("seek EOF did not finish")
	}
}

func TestLiveParameterUpdateKeepsPhaseAndRamps(t *testing.T) {
	d := testScore()
	s := mustStream(t, d)
	control := mustStream(t, d)
	mustRead(t, s, 523)
	mustRead(t, control, 523)
	originalModule := s.patch.units[1].module
	d.Nodes[0].Params["gain"] = .8
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if s.Position() != 523 || s.patch.units[1].module != originalModule {
		t.Fatal("parameter update replaced oscillator or position")
	}
	got, old := mustRead(t, s, 128), mustRead(t, control, 128)
	for i := 0; i < len(got)/2; i++ {
		gain := .2 + .6*math.Min(1, float64(i+1)/64)
		want := float64(old[2*i]) * gain / .2
		if math.Abs(float64(got[2*i])-want) > 1e-7 {
			t.Fatalf("phase/ramp mismatch at %d: got %g want %g", i, got[2*i], want)
		}
	}
	if s.ramp != nil {
		t.Fatal("ramp did not finish after 8ms")
	}
	// A seek must discard the live-edit trajectory and render the latest project.
	fresh := mustStream(t, d)
	for _, frame := range []int64{523, 100, 1000, 523} {
		if err := s.Seek(context.Background(), frame); err != nil {
			t.Fatal(err)
		}
		if err := fresh.Seek(context.Background(), frame); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(mustRead(t, s, 99), mustRead(t, fresh, 99)) {
			t.Fatalf("updated seek differs at %d", frame)
		}
	}
}

func TestLiveFrequencyUpdateAndRetargetPreservePhase(t *testing.T) {
	d := testScore()
	s := mustStream(t, d)
	mustRead(t, s, 523)
	phase := 0.0
	for i := 0; i < 523; i++ {
		phase += 440.0 / 8000
		if phase >= 1 {
			phase--
		}
	}
	d.Nodes[1].Params["freq"] = 660
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	first := mustRead(t, s, 21)
	for i := 0; i < 21; i++ {
		want := float32(math.Sin(2*math.Pi*phase) * .1)
		if math.Abs(float64(first[2*i]-want)) > 1e-7 {
			t.Fatalf("frequency update reset phase at %d", i)
		}
		phase += (440 + 220*float64(i+1)/64) / 8000
		if phase >= 1 {
			phase--
		}
	}
	current := 440 + 220*21.0/64
	d.Nodes[1].Params["freq"] = 330
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	second := mustRead(t, s, 80)
	for i := 0; i < 80; i++ {
		want := float32(math.Sin(2*math.Pi*phase) * .1)
		if math.Abs(float64(second[2*i]-want)) > 1e-7 {
			t.Fatalf("retarget reset phase at %d", i)
		}
		phase += (current + (330-current)*math.Min(1, float64(i+1)/64)) / 8000
		if phase >= 1 {
			phase--
		}
	}
}

func TestLiveBadUpdateIsAtomicAndOwnsDocument(t *testing.T) {
	d := effectsScore()
	s, control := mustStream(t, d), mustStream(t, d)
	mustRead(t, s, 5000)
	mustRead(t, control, 5000)
	patch, document, position := s.patch, s.document, s.position
	count, size := s.CheckpointUsage()
	d.Nodes[7].Params["feedback"] = 2
	if err := s.Update(context.Background(), d); err == nil {
		t.Fatal("accepted invalid delay feedback")
	}
	if s.patch != patch || s.document != document || s.position != position {
		t.Fatal("bad update changed live state")
	}
	if n, b := s.CheckpointUsage(); n != count || b != size {
		t.Fatal("bad update changed checkpoints")
	}
	if !reflect.DeepEqual(mustRead(t, s, 1000), mustRead(t, control, 1000)) {
		t.Fatal("failed update changed output")
	}
	// Mutation by the caller must not alter the saved latest project used by seek.
	if err := s.Seek(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	if err := control.Seek(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(mustRead(t, s, 1000), mustRead(t, control, 1000)) {
		t.Fatal("document alias changed seek")
	}
	d = effectsScore()
	d.Connections = append(d.Connections, score.Connection{From: "delay.out", To: "noise.freq"})
	if err := s.Update(context.Background(), d); err == nil {
		t.Fatal("accepted graph cycle")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Update(ctx, effectsScore()); err != context.Canceled {
		t.Fatalf("canceled update: %v", err)
	}
}

func TestLiveStructuralUpdateEquivalentTimeAndClamp(t *testing.T) {
	d := effectsScore()
	s := mustStream(t, d)
	if err := s.Seek(context.Background(), 9001); err != nil {
		t.Fatal(err)
	}
	d.SampleRate = 16000
	d.Nodes[1].Type = "sine"
	d.Nodes[1].Params = nil
	d.Seed++
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if s.Position() != 18002 || s.SampleRate() != 16000 {
		t.Fatal("did not retain equivalent time")
	}
	fresh := mustStream(t, d)
	if err := fresh.Seek(context.Background(), 18002); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(mustRead(t, s, 1000), mustRead(t, fresh, 1000)) {
		t.Fatal("replacement differs from fresh seek")
	}
	d.Beats, d.TailSeconds = .01, 0
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if s.Position() != s.Frames() {
		t.Fatal("shorter project not clamped")
	}
}

func TestLiveCheckpointMemoryCapIncludesDelayStorage(t *testing.T) {
	d := testScore()
	d.Beats = 24
	for i := 0; i < 32; i++ {
		d.Nodes = append(d.Nodes, score.Node{ID: fmt.Sprintf("delay%d", i), Type: "delay"})
	}
	s := mustStream(t, d)
	for s.Position() < s.Frames() {
		mustRead(t, s, MaxBlockFrames)
		n, bytes := s.CheckpointUsage()
		if n > MaxCheckpoints || bytes > MaxCheckpointBytes {
			t.Fatalf("checkpoint cap exceeded: %d/%d", n, bytes)
		}
		var actual int64
		for _, cp := range s.checkpoints {
			if cp.bytes < 32*int64(2*d.SampleRate+2)*8 {
				t.Fatal("delay history missing from accounting")
			}
			actual += cp.bytes
		}
		if actual != bytes {
			t.Fatal("checkpoint byte tally inconsistent")
		}
	}
	if n, _ := s.CheckpointUsage(); n == 0 || n >= MaxCheckpoints {
		t.Fatalf("memory cap did not constrain count: %d", n)
	}
	if s.checkpoints[0].position <= s.interval {
		t.Fatal("oldest checkpoints not evicted")
	}
	if err := s.Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if n, b := s.CheckpointUsage(); n != 0 || b != 0 {
		t.Fatal("update retained old checkpoints")
	}
}

func TestLiveBoundsAndClamping(t *testing.T) {
	d := testScore()
	d.Nodes = []score.Node{{ID: "value", Type: "constant", Params: map[string]float64{"value": 2}}}
	d.Connections = nil
	d.Output = score.Output{Left: "value.out", Right: "value.out", Gain: 1}
	s := mustStream(t, d)
	for _, n := range []int{-1, 0, MaxBlockFrames + 1} {
		if _, err := s.Read(context.Background(), n); err == nil || s.Position() != 0 {
			t.Fatal("invalid read advanced state")
		}
	}
	for _, n := range []int64{-1, s.Frames() + 1} {
		if err := s.Seek(context.Background(), n); err == nil || s.Position() != 0 {
			t.Fatal("invalid seek advanced state")
		}
	}
	for _, sample := range mustRead(t, s, 10) {
		if sample != 1 {
			t.Fatal("unclamped output")
		}
	}
}
