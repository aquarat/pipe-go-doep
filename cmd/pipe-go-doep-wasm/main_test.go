//go:build js && wasm

package main

import (
	"bytes"
	"encoding/binary"
	"math"
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
