package score

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"testing"
)

func number(x float64) *float64 { return &x }

func fixture() *Document {
	return &Document{
		Version: 1, SampleRate: 8000, BPM: 120, Beats: 4,
		Tracks:      []Track{{ID: "melody", Patterns: map[string][]Step{"a": {{Note: "A4", Beats: 1}}}, Order: []string{"a"}}},
		Nodes:       []Node{{ID: "seq", Type: "sequence", Track: "melody"}, {ID: "osc", Type: "sine"}},
		Connections: []Connection{{From: "seq.freq", To: "osc.freq"}},
		Output:      Output{Left: "osc.out", Right: "osc.out", Gain: 0.5},
	}
}

func TestParseStrict(t *testing.T) {
	b, err := json.Marshal(fixture())
	if err != nil {
		t.Fatal(err)
	}
	valid := string(b)
	for name, input := range map[string]string{
		"valid": valid, "whitespace": valid + "\n\t ",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(strings.NewReader(input)); err != nil {
				t.Fatal(err)
			}
		})
	}
	for name, input := range map[string]string{
		"unknown root":   strings.Replace(valid, `"version":1`, `"version":1,"typo":0`, 1),
		"unknown step":   strings.Replace(valid, `"note":"A4"`, `"note":"A4","typo":0`, 1),
		"unknown node":   strings.Replace(valid, `"type":"sine"`, `"type":"sine","typo":0`, 1),
		"unknown output": strings.Replace(valid, `"gain":0.5`, `"gain":0.5,"typo":0`, 1),
		"second object":  valid + `{}`, "second null": valid + `null`,
		"trailing junk": valid + `garbage`, "null": `null`, "array": `[]`,
		"empty": ``, "invalid score": `{}`, "oversized": strings.Repeat(" ", MaxJSONBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(strings.NewReader(input)); err == nil {
				t.Fatal("expected rejection")
			}
		})
	}
	if _, err := Parse(brokenReader{}); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("read error not preserved: %v", err)
	}
}

type brokenReader struct{}

func (brokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestValidate(t *testing.T) {
	cases := map[string]func(*Document){
		"version":                 func(d *Document) { d.Version = 2 },
		"low rate":                func(d *Document) { d.SampleRate = 7999 },
		"high rate":               func(d *Document) { d.SampleRate = 96001 },
		"zero bpm":                func(d *Document) { d.BPM = 0 },
		"nan bpm":                 func(d *Document) { d.BPM = math.NaN() },
		"inf beats":               func(d *Document) { d.Beats = math.Inf(1) },
		"zero beats":              func(d *Document) { d.Beats = 0 },
		"negative tail":           func(d *Document) { d.TailSeconds = -1 },
		"nan tail":                func(d *Document) { d.TailSeconds = math.NaN() },
		"duration":                func(d *Document) { d.Beats = 601 },
		"duration including tail": func(d *Document) { d.Beats = 600; d.TailSeconds = 0.001 },
		"gain":                    func(d *Document) { d.Output.Gain = math.Inf(-1) },
		"duplicate track":         func(d *Document) { d.Tracks = append(d.Tracks, d.Tracks[0]) },
		"duplicate node":          func(d *Document) { d.Nodes = append(d.Nodes, d.Nodes[0]) },
		"ambiguous id":            func(d *Document) { d.Nodes[0].ID = "seq.freq" },
		"missing pattern":         func(d *Document) { d.Tracks[0].Order = []string{"missing"} },
		"empty pattern":           func(d *Document) { d.Tracks[0].Patterns["a"] = nil },
		"empty order":             func(d *Document) { d.Tracks[0].Order = nil },
		"unused invalid pattern":  func(d *Document) { d.Tracks[0].Patterns["unused"] = []Step{{Note: "H4", Beats: 1}} },
		"transpose":               func(d *Document) { d.Tracks[0].Transpose = 128 },
		"transposed note range":   func(d *Document) { d.Tracks[0].Transpose = 100 },
		"negative step":           func(d *Document) { d.Tracks[0].Patterns["a"][0].Beats = -1 },
		"nan velocity":            func(d *Document) { d.Tracks[0].Patterns["a"][0].Velocity = number(math.NaN()) },
		"overlap gate":            func(d *Document) { d.Tracks[0].Patterns["a"][0].Gate = number(1.01) },
		"negative gate":           func(d *Document) { d.Tracks[0].Patterns["a"][0].Gate = number(-0.1) },
		"missing sequence track":  func(d *Document) { d.Nodes[0].Track = "missing" },
		"sequence params":         func(d *Document) { d.Nodes[0].Params = map[string]float64{"x": 1} },
		"non sequence track":      func(d *Document) { d.Nodes[1].Track = "melody" },
		"nonfinite param":         func(d *Document) { d.Nodes[1].Params = map[string]float64{"freq": math.Inf(1)} },
		"missing source":          func(d *Document) { d.Connections[0].From = "missing.out" },
		"missing dest":            func(d *Document) { d.Connections[0].To = "missing.in" },
		"missing port syntax":     func(d *Document) { d.Output.Left = "osc" },
		"missing right":           func(d *Document) { d.Output.Right = "" },
		"duplicate input":         func(d *Document) { d.Connections = append(d.Connections, d.Connections[0]) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			d := fixture()
			mutate(d)
			if err := d.Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
	for _, rate := range []int{8000, 96000} {
		d := fixture()
		d.SampleRate, d.Beats, d.TailSeconds = rate, 599, 0.5
		if err := d.Validate(); err != nil {
			t.Fatalf("valid boundary rejected: %v", err)
		}
	}
	var d *Document
	if d.Validate() == nil {
		t.Fatal("nil document accepted")
	}
}

func TestResourceLimits(t *testing.T) {
	for name, mutate := range map[string]func(*Document){
		"nodes":                func(d *Document) { d.Nodes = make([]Node, MaxNodes+1) },
		"tracks":               func(d *Document) { d.Tracks = make([]Track, MaxTracks+1) },
		"connections":          func(d *Document) { d.Connections = make([]Connection, MaxConnections+1) },
		"stored steps":         func(d *Document) { d.Tracks[0].Patterns["a"] = make([]Step, MaxSteps+1) },
		"order entries":        func(d *Document) { d.Tracks[0].Order = make([]string, MaxOrderEntries+1) },
		"repeated note events": func(d *Document) { repeatPattern(d, "A4", 1024, MaxEvents/1024+1) },
		"repeated rests":       func(d *Document) { repeatPattern(d, ".", 1024, MaxExpandedSteps/1024+1) },
		"aggregate events": func(d *Document) {
			repeatPattern(d, "A4", 1024, MaxEvents/1024)
			d.Tracks = append(d.Tracks, Track{ID: "other", Patterns: map[string][]Step{"a": {{Note: "C4", Beats: 1}}}, Order: []string{"a"}})
		},
	} {
		t.Run(name, func(t *testing.T) {
			d := fixture()
			mutate(d)
			if err := d.Validate(); err == nil {
				t.Fatal("expected resource limit rejection")
			}
		})
	}
	d := fixture()
	repeatPattern(d, "A4", 1024, MaxEvents/1024)
	if err := d.Validate(); err != nil {
		t.Fatalf("event limit boundary rejected: %v", err)
	}
}

func repeatPattern(d *Document, note string, count, repeats int) {
	p := make([]Step, count)
	for i := range p {
		p[i] = Step{Note: note, Beats: 0.001}
	}
	d.Tracks[0].Patterns["a"] = p
	d.Tracks[0].Order = make([]string, repeats)
	for i := range d.Tracks[0].Order {
		d.Tracks[0].Order[i] = "a"
	}
}

func TestScientificPitch(t *testing.T) {
	for note, want := range map[string]int{"C-1": 0, "C4": 60, "c4": 60, "A4": 69, "C#4": 61, "Db4": 61, "B#3": 60, "Cb4": 59, "G9": 127} {
		n, err := noteNumber(note, 0)
		if err != nil || n != want {
			t.Errorf("%q: got %d, %v; want %d", note, n, err, want)
		}
	}
	for _, note := range []string{"", "A", "H4", "A##4", "Dbb4", "4C", "C-2", "G#9", "Cb-1", " A4", "A4 ", "A♯4", "A4.0"} {
		if _, err := noteNumber(note, 0); err == nil {
			t.Errorf("accepted invalid note %q", note)
		}
	}
}

func TestCompileDefaultsRestsTransposeAndClipping(t *testing.T) {
	d := fixture()
	d.Beats, d.TailSeconds = 3.5, 10
	d.Tracks[0].Transpose = 12
	d.Tracks[0].Patterns["a"] = []Step{
		{Note: "A4", Beats: 1},
		{Note: ".", Beats: 1},
		{Note: "Db4", Beats: 1, Velocity: number(0.25), Gate: number(1)},
		{Note: "C#4", Beats: 1, Velocity: number(0), Gate: number(1)},
		{Note: "C4", Beats: 1},
	}
	events, err := d.CompileTrack("melody")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3: %+v", len(events), events)
	}
	want := []Event{{0, 3400, 880, 1}, {8000, 12000, 440 * math.Exp2(4.0/12), 0.25}, {12000, 14000, 440 * math.Exp2(4.0/12), 0}}
	for i := range want {
		if events[i] != want[i] {
			t.Errorf("event %d = %+v, want %+v", i, events[i], want[i])
		}
	}
	if _, err := d.CompileTrack("missing"); err == nil {
		t.Fatal("missing track accepted")
	}
	d.BPM = math.NaN()
	if _, err := d.CompileTrack("melody"); err == nil {
		t.Fatal("compile did not validate")
	}
}

func TestCompileAbsoluteRoundingAndExplicitOrder(t *testing.T) {
	d := fixture()
	d.BPM, d.Beats = 137, 1000
	repeatPattern(d, "A4", 10, 1000)
	for i := range d.Tracks[0].Patterns["a"] {
		d.Tracks[0].Patterns["a"][i].Beats = 0.1
		d.Tracks[0].Patterns["a"][i].Gate = number(1)
	}
	events, err := d.CompileTrack("melody")
	// Keep the score duration within 300 s at this tempo.
	if err == nil {
		t.Fatal("expected overlong document to fail")
	}
	d.Beats = 600
	events, err = d.CompileTrack("melody")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 6000 {
		t.Fatalf("got %d events, want 6000", len(events))
	}
	for i, e := range events {
		start := int64(math.Round(float64(i) / 10 * 60 / 137 * 8000))
		end := int64(math.Round(float64(i+1) / 10 * 60 / 137 * 8000))
		if e.Start != start || e.End != end {
			t.Fatalf("event %d drifted: %+v, want [%d,%d)", i, e, start, end)
		}
		if i > 0 && events[i-1].End != e.Start {
			t.Fatalf("gate-1 events have a gap or overlap at %d", i)
		}
	}
	d = fixture()
	events, err = d.CompileTrack("melody")
	if err != nil || len(events) != 1 {
		t.Fatalf("track looped implicitly: %+v, %v", events, err)
	}
}

func TestCompileZeroLengthAndRestOnly(t *testing.T) {
	d := fixture()
	d.Tracks[0].Patterns["a"] = []Step{
		{Note: "A4", Beats: 1, Gate: number(0)},
		{Note: "A4", Beats: 0.000001},
		{Note: ".", Beats: 1},
	}
	events, err := d.CompileTrack("melody")
	if err != nil || len(events) != 0 {
		t.Fatalf("zero-length notes/rests produced events: %+v, %v", events, err)
	}
}

func TestValidateRoundedWAVDuration(t *testing.T) {
	for _, tc := range []struct {
		name               string
		frames, tailFrames float64
		valid              bool
	}{
		{"tiny duration", 0.004, 0, false},
		{"below half frame", 0.49, 0, false},
		{"half frame rounds up", 0.5, 0, true},
		{"tail contributes to rounding", 0.25, 0.25, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := fixture()
			d.Beats = tc.frames / 4000 // 8000 Hz at 120 BPM.
			d.TailSeconds = tc.tailFrames / 8000
			err := d.Validate()
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
			if !tc.valid && !strings.Contains(err.Error(), "zero WAV frames") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestCompileMinimumOnsetSpacing(t *testing.T) {
	oneSample := Step{Note: "A4", Beats: 1.0 / 4000, Gate: number(1)}
	rest := Step{Note: ".", Beats: 1.0 / 4000}
	gateZero := oneSample
	gateZero.Gate = number(0)
	velocityZero := oneSample
	velocityZero.Velocity = number(0)
	subSample := Step{Note: "C4", Beats: 0.000001}
	for _, tc := range []struct {
		name       string
		steps      []Step
		beats      float64
		wantEvents int
		wantError  bool
	}{
		{"consecutive onsets", []Step{oneSample, oneSample}, 4, 0, true},
		{"zero velocity still triggers", []Step{oneSample, velocityZero}, 4, 0, true},
		{"one sample rest separates onsets", []Step{oneSample, rest, oneSample}, 4, 2, false},
		{"gate zero is omitted", []Step{oneSample, gateZero, oneSample}, 4, 2, false},
		{"rounded zero length is omitted", []Step{oneSample, subSample, rest, oneSample}, 4, 2, false},
		{"clipped zero length is omitted", []Step{oneSample, oneSample}, 1.25 / 4000, 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := fixture()
			d.Beats = tc.beats
			d.Tracks[0].Patterns["a"] = tc.steps
			if err := d.Validate(); err != nil {
				t.Fatalf("structural validation must pass: %v", err)
			}
			events, err := d.CompileTrack("melody")
			if tc.wantError {
				if err == nil || !strings.Contains(err.Error(), "at least 2 samples apart") {
					t.Fatalf("expected actionable onset-spacing error, got %v", err)
				}
				return
			}
			if err != nil || len(events) != tc.wantEvents {
				t.Fatalf("got events=%+v, error=%v; want %d events", events, err, tc.wantEvents)
			}
			if len(events) == 2 && (events[0].Start != 0 || events[0].End != 1 || events[1].Start != 2) {
				t.Fatalf("unexpected one-sample event timing: %+v", events)
			}
		})
	}
}
