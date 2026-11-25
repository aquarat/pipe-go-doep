// Command pipe-go-doep is a modular chip-music renderer and local workbench.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/aquarat/pipe-go-doep/internal/engine"
	"github.com/aquarat/pipe-go-doep/internal/score"
	"github.com/aquarat/pipe-go-doep/internal/workbench"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

const usage = `pipe-go-doep — modular chip music in Go

  pipe-go-doep render   [-o renders/track.wav] score.json
  pipe-go-doep validate score.json
  pipe-go-doep graph    score.json              # Graphviz DOT to stdout
  pipe-go-doep serve    [-addr 127.0.0.1:8080] [-examples examples]

Run from the project root to use the bundled examples in the workbench.
`

func run(ctx context.Context, args []string, out, diagnostics io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		_, err := io.WriteString(out, usage)
		return err
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	flags.SetOutput(diagnostics)
	switch args[0] {
	case "serve":
		addr := flags.String("addr", "127.0.0.1:8080", "listen address; use 0.0.0.0:8080 for LAN access")
		examples := flags.String("examples", "examples", "score examples directory")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("serve takes flags only")
		}
		return workbench.Serve(ctx, *addr, *examples, out)
	case "render", "validate", "graph":
		var dest *string
		if args[0] == "render" {
			dest = flags.String("o", "renders/output.wav", "output WAV path")
		}
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 1 {
			return fmt.Errorf("%s requires one score JSON path (flags go before the path)", args[0])
		}
		f, err := os.Open(flags.Arg(0))
		if err != nil {
			return err
		}
		d, err := score.Parse(f)
		f.Close()
		if err != nil {
			return err
		}
		if args[0] == "validate" || args[0] == "graph" {
			if _, err := engine.Compile(d); err != nil {
				return err
			}
			if args[0] == "graph" {
				return engine.WriteDOT(out, d)
			}
			_, err = fmt.Fprintf(out, "Valid: %s — %d nodes, %d cables, %.2f seconds + %.2fs tail\n", d.Title, len(d.Nodes), len(d.Connections), d.Beats*60/d.BPM, d.TailSeconds)
			return err
		}
		// Render alongside the target and rename only after success. Invalid
		// patches or interrupted renders never destroy an existing good WAV.
		if err := os.MkdirAll(filepath.Dir(*dest), 0755); err != nil {
			return err
		}
		wav, err := os.CreateTemp(filepath.Dir(*dest), ".render-*.wav")
		if err != nil {
			return err
		}
		defer os.Remove(wav.Name())
		stats, renderErr := engine.Render(ctx, d, wav)
		closeErr := wav.Close()
		if renderErr != nil {
			return renderErr
		}
		if closeErr != nil {
			return closeErr
		}
		if err := os.Rename(wav.Name(), *dest); err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "Rendered %s → %s\n%.2fs · %d Hz stereo PCM16 · peak %.3f · RMS %.3f · %d clipped samples\nRender time %.3fs (%.1f× realtime)\n", d.Title, *dest, stats.Seconds, stats.SampleRate, stats.Peak, stats.RMS, stats.ClippedSamples, stats.RenderSeconds, stats.Seconds/stats.RenderSeconds)
		return err
	default:
		return fmt.Errorf("unknown command %q\n%s", args[0], usage)
	}
}
