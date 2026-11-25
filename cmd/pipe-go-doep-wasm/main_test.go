//go:build js && wasm

package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"reflect"
	"strings"
	"syscall/js"
	"testing"
)

const bridgeScore = `{"version":1,"title":"bridge","sample_rate":8000,"bpm":120,"beats":2,"seed":1,"nodes":[{"id":"osc","type":"sine","params":{"freq":440}}],"output":{"left":"osc.out","right":"osc.out","gain":0.2}}`

func callStream(t *testing.T, action, source string, status int) map[string]any {
	t.Helper()
	result := stream(js.Undefined(), []js.Value{js.ValueOf(action), js.ValueOf(source)}).(map[string]any)
	if result["status"] != status {
		t.Fatalf("%s: %+v", action, result)
	}
	return result
}

func floatBytes(t *testing.T, body any) []byte {
	t.Helper()
	value := body.(js.Value)
	if !value.InstanceOf(js.Global().Get("Float32Array")) {
		t.Fatal("body is not Float32Array")
	}
	view := js.Global().Get("Uint8Array").New(value.Get("buffer"))
	out := make([]byte, view.Length())
	js.CopyBytesToGo(out, view)
	return out
}

func TestStreamBridgeLifecycleAndOfflineIndependence(t *testing.T) {
	live = nil
	defer func() { live = nil }()
	opened := callStream(t, "open", bridgeScore, 200)
	if opened["sampleRate"] != 8000 || opened["position"] != int64(0) || opened["frames"] != int64(8000) {
		t.Fatalf("open metadata: %+v", opened)
	}
	first := callStream(t, "read", `{"frames":257}`, 200)
	if first["position"] != int64(0) || first["frames"] != 257 || first["done"] != false {
		t.Fatalf("read metadata: %+v", first)
	}
	pcm := floatBytes(t, first["body"])
	if len(pcm) != 257*8 {
		t.Fatal("body is not interleaved stereo")
	}
	for i := 0; i < 257; i++ {
		if !bytes.Equal(pcm[i*8:i*8+4], pcm[i*8+4:i*8+8]) {
			t.Fatal("stereo route differs")
		}
		value := math.Float32frombits(binary.LittleEndian.Uint32(pcm[i*8:]))
		if value < -1 || value > 1 || math.IsNaN(float64(value)) {
			t.Fatal("invalid PCM")
		}
	}
	callStream(t, "read", `{"frames":13}`, 200)
	if !bytes.Equal(pcm, floatBytes(t, first["body"])) {
		t.Fatal("previous buffer was overwritten")
	}
	callStream(t, "seek", `{"frame":0}`, 200)
	again := callStream(t, "read", `{"frames":257}`, 200)
	if !bytes.Equal(pcm, floatBytes(t, again["body"])) {
		t.Fatal("seek did not reproduce exact PCM")
	}
	position := live.Position()
	offline := request(js.Undefined(), []js.Value{js.ValueOf("render"), js.ValueOf(bridgeScore)}).(map[string]any)
	if offline["status"] != 200 || live.Position() != position {
		t.Fatal("offline render changed live stream")
	}
	updated := callStream(t, "update", bridgeScore, 200)
	if updated["position"] != position {
		t.Fatal("update reset position")
	}
	callStream(t, "seek", `{"frame":7999}`, 200)
	last := callStream(t, "read", `{"frames":8192}`, 200)
	if last["position"] != int64(7999) || last["frames"] != 1 || last["done"] != true {
		t.Fatalf("tail metadata: %+v", last)
	}
	end := callStream(t, "read", `{"frames":1}`, 200)
	if end["frames"] != 0 || len(floatBytes(t, end["body"])) != 0 {
		t.Fatal("EOF not empty")
	}
	callStream(t, "close", `{}`, 200)
	if live != nil {
		t.Fatal("close retained engine")
	}
	callStream(t, "read", `{"frames":1}`, 409)
	callStream(t, "update", bridgeScore, 409)
}

func TestStreamBridgeRejectsMalformedRequestsAtomically(t *testing.T) {
	live = nil
	defer func() { live = nil }()
	callStream(t, "open", bridgeScore, 200)
	callStream(t, "read", `{"frames":123}`, 200)
	original, position := live, live.Position()
	for _, tc := range []struct{ action, source string }{
		{"open", `null`}, {"update", `{}`}, {"read", `{"frames":8193}`}, {"read", `{"frames":0}`},
		{"read", `{"frames":1.5}`}, {"read", `{"frames":null}`}, {"read", `{"frames":1} {}`},
		{"seek", `{"frame":-1}`}, {"seek", `{"frame":8001}`}, {"seek", `{}`}, {"seek", `{"frame":0,"oops":1}`}, {"nope", `{}`},
	} {
		callStream(t, tc.action, tc.source, 400)
		if live != original || live.Position() != position {
			t.Fatalf("%s mutated active stream", tc.action)
		}
	}
}

const probeScore = `{"version":1,"title":"probe","sample_rate":8000,"bpm":120,"beats":2,"seed":1,"nodes":[{"id":"osc","type":"sine","params":{"freq":440}},{"id":"amp","type":"vca","params":{"gain":3}}],"connections":[{"from":"osc.out","to":"amp.in"}],"output":{"left":"amp.out","right":"osc.out","gain":0.5}}`

func floats(t *testing.T, value any) []float32 {
	t.Helper()
	raw := floatBytes(t, value)
	out := make([]float32, len(raw)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	return out
}

func stringsOf(value any) []string {
	out := []string{}
	for _, v := range value.([]any) {
		out = append(out, v.(string))
	}
	return out
}

func TestStreamBridgeProbes(t *testing.T) {
	live, probes = nil, nil
	defer func() { live, probes = nil, nil }()
	opened := callStream(t, "open", probeScore, 200)
	if len(stringsOf(opened["unresolved"])) != 0 {
		t.Fatalf("open without probes: %+v", opened)
	}
	plain := callStream(t, "read", `{"frames":64}`, 200)
	if _, ok := plain["probe"]; ok {
		t.Fatal("read without probes returned probe data")
	}
	plainPCM := floats(t, plain["body"])

	set := callStream(t, "probe", `{"probes":[{"channel":"y1","node":"osc","port":"out","direction":"output"},{"channel":"x","bus":"left"},{"channel":"y3","node":"lead","port":"out","direction":"output"},{"channel":"y2","node":"amp","port":"gain","direction":"input"}]}`, 200)
	if got := stringsOf(set["channels"]); !reflect.DeepEqual(got, []string{"y1", "x", "y3", "y2"}) {
		t.Fatalf("channels %v", got)
	}
	if got := stringsOf(set["unresolved"]); !reflect.DeepEqual(got, []string{"y3"}) {
		t.Fatalf("unresolved %v", got)
	}
	callStream(t, "seek", `{"frame":0}`, 200)
	read := callStream(t, "read", `{"frames":64}`, 200)
	if !reflect.DeepEqual(stringsOf(read["channels"]), []string{"y1", "x", "y3", "y2"}) || !reflect.DeepEqual(stringsOf(read["unresolved"]), []string{"y3"}) {
		t.Fatalf("read metadata %+v", read)
	}
	pcm, probe := floats(t, read["body"]), floats(t, read["probe"])
	if !reflect.DeepEqual(pcm, plainPCM) {
		t.Fatal("probes changed PCM")
	}
	if len(probe) != 64*4 {
		t.Fatalf("probe length %d", len(probe))
	}
	clipped := false
	for i := 0; i < 64; i++ {
		sine := float32(math.Sin(2 * math.Pi * math.Mod(float64(i)*440/8000, 1)))
		row := probe[i*4 : i*4+4]
		if math.Abs(float64(row[0]-sine)) > 1e-6 || math.Abs(float64(row[1]-1.5*sine)) > 1e-6 || !math.IsNaN(float64(row[2])) || row[3] != 3 {
			t.Fatalf("frame %d probe %v", i, row)
		}
		if math.Abs(float64(row[1])) > 1 {
			clipped = true
			if pcm[2*i] != float32(math.Copysign(1, float64(row[1]))) {
				t.Fatal("bus probe is not the pre-clamp value of the clamped PCM")
			}
		}
	}
	if !clipped {
		t.Fatal("fixture never exceeded the clamp")
	}
	first := floatBytes(t, read["probe"])
	callStream(t, "read", `{"frames":5}`, 200)
	if !bytes.Equal(first, floatBytes(t, read["probe"])) {
		t.Fatal("probe buffer aliased Go memory")
	}

	// Invalid probe payloads change nothing.
	for _, source := range []string{
		`{}`, `{"probes":null}`, `[]`, `{"probes":[{"channel":"y9","bus":"left"}]}`,
		`{"probes":[{"channel":"y1","bus":"left"},{"channel":"y1","bus":"right"}]}`,
		`{"probes":[{"channel":"x","bus":"left"},{"channel":"y1","bus":"left"},{"channel":"y2","bus":"left"},{"channel":"y3","bus":"left"},{"channel":"y4","bus":"left"},{"channel":"y4","bus":"right"}]}`,
		`{"probes":[{"channel":"y1","bus":"left","node":"osc"}]}`, `{"probes":[{"channel":"y1","node":"osc","port":"out"}]}`,
		`{"probes":[{"channel":"y1","bus":"left","colour":"red"}]}`, `{"probes":[null]}`, `{"probes":[]} {}`,
	} {
		callStream(t, "probe", source, 400)
		if len(probes) != 4 || len(live.Probes()) != 4 {
			t.Fatalf("invalid payload %s changed probes", source)
		}
	}

	// Structural update re-resolves (lead appears); parameter update keeps probes.
	structural := strings.Replace(probeScore, `{"id":"amp"`, `{"id":"lead","type":"constant","params":{"value":0.5}},{"id":"amp"`, 1)
	if got := stringsOf(callStream(t, "update", structural, 200)["unresolved"]); len(got) != 0 {
		t.Fatalf("structural update unresolved %v", got)
	}
	row := floats(t, callStream(t, "read", `{"frames":1}`, 200)["probe"])
	if row[2] != .5 {
		t.Fatalf("re-resolved probe read %v", row)
	}
	if got := stringsOf(callStream(t, "update", strings.Replace(structural, `"gain":3`, `"gain":2`, 1), 200)["unresolved"]); len(got) != 0 {
		t.Fatalf("parameter update unresolved %v", got)
	}
	if got := floats(t, callStream(t, "read", `{"frames":1}`, 200)["probe"]); len(got) != 4 || got[2] != .5 {
		t.Fatalf("parameter update probe %v", got)
	}
	if got := stringsOf(callStream(t, "update", probeScore, 200)["unresolved"]); !reflect.DeepEqual(got, []string{"y3"}) {
		t.Fatalf("removing lead: unresolved %v", got)
	}

	// Probes survive close/open and EOF reads return empty probe data.
	callStream(t, "close", `{}`, 200)
	if got := stringsOf(callStream(t, "probe", `{"probes":[{"channel":"x","bus":"right"},{"channel":"y4","node":"osc","port":"out","direction":"output"}]}`, 200)["unresolved"]); !reflect.DeepEqual(got, []string{"y4"}) {
		t.Fatalf("closed probe unresolved %v", got)
	}
	if got := stringsOf(callStream(t, "open", probeScore, 200)["unresolved"]); len(got) != 0 {
		t.Fatalf("reopen unresolved %v", got)
	}
	callStream(t, "seek", `{"frame":8000}`, 200)
	end := callStream(t, "read", `{"frames":1}`, 200)
	if end["frames"] != 0 || len(floats(t, end["probe"])) != 0 || !reflect.DeepEqual(stringsOf(end["channels"]), []string{"x", "y4"}) {
		t.Fatalf("EOF probe %+v", end)
	}
	callStream(t, "probe", `{"probes":[]}`, 200)
	callStream(t, "seek", `{"frame":0}`, 200)
	if _, ok := callStream(t, "read", `{"frames":4}`, 200)["probe"]; ok || len(live.Probes()) != 0 {
		t.Fatal("empty probe list did not clear")
	}
}
