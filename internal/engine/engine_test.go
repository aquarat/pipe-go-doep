package engine

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"strings"
	"testing"

	"github.com/aquarat/pipe-go-doep/internal/score"
)

func testScore() *score.Document {
	return &score.Document{Version: 1, Title: "test", SampleRate: 8000, BPM: 120, Beats: 0.5, TailSeconds: 0, Seed: 1,
		Nodes:       []score.Node{{ID: "amp", Type: "vca", Params: map[string]float64{"gain": 0.2}}, {ID: "osc", Type: "sine", Params: map[string]float64{"freq": 440}}},
		Connections: []score.Connection{{From: "osc.out", To: "amp.in"}}, Output: score.Output{Left: "amp.out", Right: "amp.out", Gain: 0.5}}
}

func TestWAVPitchAndDeterminism(t *testing.T) {
	d := testScore()
	var a, b bytes.Buffer
	s, err := Render(context.Background(), d, &a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Render(context.Background(), d, &b); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.Bytes(), b.Bytes()) {
		t.Fatal("render is not deterministic")
	}
	wav := a.Bytes()
	if string(wav[:4]) != "RIFF" || string(wav[8:12]) != "WAVE" || int(binary.LittleEndian.Uint32(wav[40:])) != len(wav)-44 {
		t.Fatal("invalid WAV container")
	}
	if s.Frames != 2000 || len(wav) != 44+2000*4 {
		t.Fatalf("wrong length: %+v %d", s, len(wav))
	}
	if math.Abs(s.Peak-.1) > .001 || math.Abs(s.RMS-.1/math.Sqrt2) > .001 || s.ClippedSamples != 0 {
		t.Fatalf("unexpected levels: %+v", s)
	}
	crossings := 0
	last := int16(0)
	for offset := 44; offset < len(wav); offset += 4 {
		left := int16(binary.LittleEndian.Uint16(wav[offset:]))
		right := int16(binary.LittleEndian.Uint16(wav[offset+2:]))
		if left != right {
			t.Fatal("mono route not duplicated into stereo")
		}
		if last <= 0 && left > 0 {
			crossings++
		}
		last = left
	}
	if crossings < 109 || crossings > 111 {
		t.Fatalf("expected 440 Hz (110 cycles), got %d", crossings)
	}
}

func TestGraphRejectsBadPatches(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*score.Document)
		want string
	}{
		{"cycle", func(d *score.Document) {
			d.Connections = append(d.Connections, score.Connection{From: "amp.out", To: "osc.freq"})
		}, "cycle"},
		{"port", func(d *score.Document) { d.Connections[0].To = "amp.missing" }, "port"},
		{"multiple", func(d *score.Document) { d.Connections = append(d.Connections, d.Connections[0]) }, "multiple"},
		{"output", func(d *score.Document) { d.Output.Left = "missing.out" }, "unknown"},
		{"parameter", func(d *score.Document) { d.Nodes[0].Params["typo"] = 1 }, ""},
		{"track on DSP", func(d *score.Document) { d.Nodes[0].Track = "unused" }, "track"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := testScore()
			tc.edit(d)
			_, err := Compile(d)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q error, got %v", tc.want, err)
			}
		})
	}
}

func TestSequenceRetriggerAndHeldCV(t *testing.T) {
	s := sequence{events: []score.Event{{Start: 1, End: 3, Frequency: 220, Velocity: .7}, {Start: 3, End: 4, Frequency: 330, Velocity: .4}}, frequency: 440}
	out := make([]float64, 4)
	want := [][4]float64{{440, 0, 0, 0}, {220, 1, .7, 1}, {220, 1, .7, 0}, {330, 1, .4, 1}, {330, 0, .4, 0}}
	for sample, values := range want {
		s.Tick(nil, out)
		for j, x := range values {
			if out[j] != x {
				t.Fatalf("sample %d output %d got %v want %v", sample, j, out[j], x)
			}
		}
	}
}

func TestClippingAndCancellation(t *testing.T) {
	d := testScore()
	d.Nodes = []score.Node{{ID: "constant", Type: "constant", Params: map[string]float64{"value": 2}}}
	d.Connections = nil
	d.Output = score.Output{Left: "constant.out", Right: "constant.out", Gain: 1}
	var out bytes.Buffer
	s, err := Render(context.Background(), d, &out)
	if err != nil {
		t.Fatal(err)
	}
	if s.ClippedSamples != s.Frames*2 || s.Peak != 2 || s.RMS != 2 {
		t.Fatalf("bad pre-clamp metering: %+v", s)
	}
	if int16(binary.LittleEndian.Uint16(out.Bytes()[44:])) != 32767 {
		t.Fatal("output was not clamped")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = Render(ctx, d, io.Discard)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func TestOutputErrorPropagates(t *testing.T) {
	if _, err := Render(context.Background(), testScore(), brokenWriter{}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal(err)
	}
}

func TestTickDoesNotAllocate(t *testing.T) {
	p, err := Compile(testScore())
	if err != nil {
		t.Fatal(err)
	}
	if n := testing.AllocsPerRun(1000, func() { p.tick() }); n != 0 {
		t.Fatalf("sample loop allocates: %v", n)
	}
}

func BenchmarkGraph(b *testing.B) {
	p, err := Compile(testScore())
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p.tick()
	}
}
