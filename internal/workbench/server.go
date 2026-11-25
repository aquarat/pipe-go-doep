// Package workbench provides a local/LAN offline render/editor application.
package workbench

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aquarat/pipe-go-doep/internal/engine"
	"github.com/aquarat/pipe-go-doep/internal/score"
)

//go:embed index.html
var page []byte

//go:embed static/*.js static/*.css
var assets embed.FS

func Serve(ctx context.Context, addr, examples string, log io.Writer) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !(ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified()) {
		return fmt.Errorf("workbench address must use a loopback, private, or wildcard IP (for example 0.0.0.0:8080)")
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: Handler(examples), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = server.Shutdown(shutdown)
		case <-stopped:
		}
	}()
	fmt.Fprintf(log, "Workbench: http://%s\nCtrl-C to stop. Rendered audio stays in your browser until downloaded.\n", listener.Addr())
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Handler is separately constructible so HTTP behaviour can be tested without
// starting a persistent server or requiring an audio device.
func Handler(examples string) http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(assets, "static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(static))))
	// Live playback also uses browser Go/WASM when running the native workbench.
	// Keep generated binaries outside the native executable; build-web produces
	// the matching WASM/runtime pair alongside the examples directory.
	for _, asset := range []string{"synth.wasm", "wasm_exec.js"} {
		mux.HandleFunc("GET /static/"+asset, func(w http.ResponseWriter, r *http.Request) {
			path := filepath.Join(examples, "..", "dist", "static", asset)
			if _, err := os.Stat(path); err != nil {
				http.Error(w, "live synth assets missing; run node scripts/build-web.mjs first", http.StatusNotFound)
				return
			}
			if asset == "synth.wasm" {
				w.Header().Set("Content-Type", "application/wasm")
			} else {
				w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			}
			http.ServeFile(w, r, path)
		})
	}
	busy := make(chan struct{}, 1)
	mux.HandleFunc("GET /api/runtime", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"renderer":"server"}`)
	})
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(page)
	})
	mux.HandleFunc("GET /api/examples", func(w http.ResponseWriter, r *http.Request) {
		entries, err := os.ReadDir(examples)
		if err != nil {
			http.Error(w, "cannot read examples directory", 500)
			return
		}
		names := []string{}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(names)
	})
	mux.HandleFunc("GET /api/example", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		if filepath.Base(name) != name || !strings.HasSuffix(name, ".json") || strings.ContainsAny(name, "/\\") {
			http.Error(w, "invalid example name", 400)
			return
		}
		b, err := os.ReadFile(filepath.Join(examples, name))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	})
	for _, action := range []string{"validate", "render"} {
		mux.HandleFunc("POST /api/"+action, func(w http.ResponseWriter, r *http.Request) {
			select {
			case busy <- struct{}{}:
				defer func() { <-busy }()
			default:
				http.Error(w, "a render or validation is already running", http.StatusTooManyRequests)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
			d, err := score.Parse(r.Body)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			// Interactive work has a smaller budget than batch rendering. One
			// request at a time avoids multiplying graph/delay storage and CPU.
			if d.SampleRate > 48000 || d.Beats*60/d.BPM+d.TailSeconds > 90 || len(d.Nodes) > 128 {
				http.Error(w, "workbench limit: 48 kHz, 90 seconds including tail, 128 nodes; use CLI for larger scores", 400)
				return
			}
			if action == "validate" {
				if _, err = engine.Compile(d); err != nil {
					http.Error(w, err.Error(), 400)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"valid":true}`)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
			defer cancel()
			var wav bytes.Buffer
			stats, err := engine.Render(ctx, d, &wav)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			metadata, _ := json.Marshal(stats)
			w.Header().Set("X-Render-Stats", string(metadata))
			w.Header().Set("Content-Type", "audio/wav")
			w.Header().Set("Content-Disposition", `attachment; filename="pipe-go-doep.wav"`)
			_, _ = w.Write(wav.Bytes())
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		ip := net.ParseIP(strings.Trim(host, "[]"))
		if host != "localhost" && (ip == nil || !(ip.IsLoopback() || ip.IsPrivate())) {
			http.Error(w, "loopback or private IP host required", 403)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host || u.Scheme != "http" {
				http.Error(w, "same-origin requests required", 403)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
