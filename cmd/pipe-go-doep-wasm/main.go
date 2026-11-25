//go:build js && wasm

// pipe-go-doep-wasm exposes the native score parser and renderer to a dedicated
// browser worker. There is deliberately no second implementation of the DSP.
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"
	"syscall/js"
	"time"

	"github.com/aquarat/pipe-go-doep/internal/engine"
	"github.com/aquarat/pipe-go-doep/internal/score"
)

const maxJSONBytes = 2 << 20

var live *engine.Stream

// probes is the worker's last accepted probe list. It outlives individual
// streams so open/update/close never drop the oscilloscope patch.
var probes []engine.Probe

func interactiveDocument(source string) (*score.Document, error) {
	if len(source) > maxJSONBytes {
		return nil, fmt.Errorf("workbench limit: 2097152 JSON bytes")
	}
	d, err := score.Parse(strings.NewReader(source))
	if err != nil {
		return nil, err
	}
	if d.SampleRate > 48000 || d.Beats*60/d.BPM+d.TailSeconds > 90 || len(d.Nodes) > 128 {
		return nil, fmt.Errorf("workbench limit: 48 kHz, 90 seconds including tail, 128 nodes; use CLI for larger scores")
	}
	return d, nil
}

func failure(status int, message string) map[string]any {
	return map[string]any{"status": status, "error": message, "body": message + "\n", "contentType": "text/plain; charset=utf-8"}
}

func request(_ js.Value, args []js.Value) (result any) {
	defer func() {
		if err := recover(); err != nil {
			result = failure(500, fmt.Sprintf("browser renderer: %v", err))
		}
	}()
	if len(args) != 2 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeString {
		return failure(400, "expected action and JSON score strings")
	}
	action, source := args[0].String(), args[1].String()
	if action != "validate" && action != "render" {
		return failure(400, "unknown synth action")
	}
	d, err := interactiveDocument(source)
	if err != nil {
		return failure(400, err.Error())
	}
	if action == "validate" {
		if _, err := engine.Compile(d); err != nil {
			return failure(400, err.Error())
		}
		return map[string]any{"status": 200, "contentType": "application/json", "body": `{"valid":true}`}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var wav bytes.Buffer
	stats, err := engine.Render(ctx, d, &wav)
	if err != nil {
		return failure(400, err.Error())
	}
	metadata, err := json.Marshal(stats)
	if err != nil {
		return failure(500, err.Error())
	}
	// Copy out of Go linear memory before the worker transfers ownership of the
	// ArrayBuffer. No Go-backed view or per-request js.Func escapes this call.
	data := js.Global().Get("Uint8Array").New(wav.Len())
	js.CopyBytesToJS(data, wav.Bytes())
	return map[string]any{"status": 200, "contentType": "audio/wav", "body": data, "stats": string(metadata)}
}

func decodeControl(source string, target any) error {
	dec := json.NewDecoder(strings.NewReader(source))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return fmt.Errorf("expected exactly one JSON object")
	}
	return nil
}

// float32Array copies values into a JS-owned Float32Array in one bulk copy; no
// view into Go memory survives the call, so the worker may transfer it.
func float32Array(values []float32) js.Value {
	encoded := make([]byte, len(values)*4)
	for i, sample := range values {
		binary.LittleEndian.PutUint32(encoded[i*4:], math.Float32bits(sample))
	}
	array := js.Global().Get("Float32Array").New(len(values))
	js.CopyBytesToJS(js.Global().Get("Uint8Array").New(array.Get("buffer")), encoded)
	return array
}

func stringList(values []string) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}

func probeChannels() []any {
	out := make([]any, len(probes))
	for i, p := range probes {
		out[i] = p.Channel
	}
	return out
}

// unresolvedWithoutStream reports node probes as unresolved: there is no patch.
func unresolvedWithoutStream() []string {
	out := []string{}
	for _, p := range probes {
		if p.Bus == "" {
			out = append(out, p.Channel)
		}
	}
	return out
}

func stream(_ js.Value, args []js.Value) (result any) {
	defer func() {
		if err := recover(); err != nil {
			result = failure(500, fmt.Sprintf("browser stream: %v", err))
		}
	}()
	if len(args) != 2 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeString {
		return failure(400, "expected action and JSON strings")
	}
	action, source := args[0].String(), args[1].String()
	if len(source) > maxJSONBytes {
		return failure(400, "workbench limit: 2097152 JSON bytes")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	switch action {
	case "close":
		live = nil
		return map[string]any{"status": 200}
	case "open", "update":
		if action == "update" && live == nil {
			return failure(409, "no open stream")
		}
		d, err := interactiveDocument(source)
		if err != nil {
			return failure(400, err.Error())
		}
		if action == "open" {
			next, err := engine.NewStream(d)
			if err != nil {
				return failure(400, err.Error())
			}
			if _, err := next.SetProbes(probes); err != nil {
				return failure(500, err.Error())
			}
			live = next
		} else if err := live.Update(ctx, d); err != nil {
			return failure(400, err.Error())
		}
		return map[string]any{"status": 200, "sampleRate": live.SampleRate(), "frames": live.Frames(), "position": live.Position(), "unresolved": stringList(live.Unresolved())}
	case "probe":
		var payload struct {
			Probes *[]engine.Probe `json:"probes"`
		}
		if err := decodeControl(source, &payload); err != nil {
			return failure(400, err.Error())
		}
		if payload.Probes == nil {
			return failure(400, "probes is required")
		}
		next := *payload.Probes
		if err := engine.ValidateProbes(next); err != nil {
			return failure(400, err.Error())
		}
		var unresolved []string
		if live != nil {
			var err error
			if unresolved, err = live.SetProbes(next); err != nil {
				return failure(400, err.Error())
			}
		}
		probes = append([]engine.Probe(nil), next...)
		if live == nil {
			unresolved = unresolvedWithoutStream()
		}
		return map[string]any{"status": 200, "channels": probeChannels(), "unresolved": stringList(unresolved)}
	case "read":
		if live == nil {
			return failure(409, "no open stream")
		}
		var payload struct {
			Frames *int `json:"frames"`
		}
		if err := decodeControl(source, &payload); err != nil {
			return failure(400, err.Error())
		}
		if payload.Frames == nil {
			return failure(400, "frames is required")
		}
		position := live.Position()
		pcm, err := live.Read(ctx, *payload.Frames)
		if err != nil {
			return failure(400, err.Error())
		}
		result := map[string]any{"status": 200, "sampleRate": live.SampleRate(), "position": position, "frames": len(pcm) / 2, "done": live.Position() == live.Frames(), "body": float32Array(pcm)}
		if len(probes) != 0 {
			result["channels"] = probeChannels()
			result["probe"] = float32Array(live.ProbeData())
			result["unresolved"] = stringList(live.Unresolved())
		}
		return result
	case "seek":
		if live == nil {
			return failure(409, "no open stream")
		}
		var payload struct {
			Frame *int64 `json:"frame"`
		}
		if err := decodeControl(source, &payload); err != nil {
			return failure(400, err.Error())
		}
		if payload.Frame == nil {
			return failure(400, "frame is required")
		}
		if err := live.Seek(ctx, *payload.Frame); err != nil {
			return failure(400, err.Error())
		}
		return map[string]any{"status": 200, "position": live.Position()}
	default:
		return failure(400, "unknown stream action")
	}
}

func main() {
	bridge := js.FuncOf(request)
	defer bridge.Release()
	js.Global().Set("pipeGoDoepRequest", bridge)
	liveBridge := js.FuncOf(stream)
	defer liveBridge.Release()
	js.Global().Set("pipeGoDoepStream", liveBridge)
	// Retain callbacks for this worker's entire lifetime.
	select {}
}
