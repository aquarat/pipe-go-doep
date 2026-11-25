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
			live = next
		} else if err := live.Update(ctx, d); err != nil {
			return failure(400, err.Error())
		}
		return map[string]any{"status": 200, "sampleRate": live.SampleRate(), "frames": live.Frames(), "position": live.Position()}
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
		// One bulk copy into a JS-owned buffer; no Go-memory view survives this
		// callback, and the worker can safely transfer the ArrayBuffer.
		encoded := make([]byte, len(pcm)*4)
		for i, sample := range pcm {
			binary.LittleEndian.PutUint32(encoded[i*4:], math.Float32bits(sample))
		}
		body := js.Global().Get("Float32Array").New(len(pcm))
		view := js.Global().Get("Uint8Array").New(body.Get("buffer"))
		js.CopyBytesToJS(view, encoded)
		return map[string]any{"status": 200, "sampleRate": live.SampleRate(), "position": position, "frames": len(pcm) / 2, "done": live.Position() == live.Frames(), "body": body}
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
