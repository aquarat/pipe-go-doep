package workbench

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testJSON = `{"version":1,"title":"web test","sample_rate":8000,"bpm":120,"beats":0.1,"tail_seconds":0,"seed":1,"tracks":[],"nodes":[{"id":"sine","type":"sine","params":{"freq":440}}],"connections":[],"output":{"left":"sine.out","right":"sine.out","gain":0.1}}`

func request(h http.Handler, method, path, body, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8080"+path, strings.NewReader(body))
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestWorkbenchRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "test.json"), []byte(testJSON), 0600); err != nil {
		t.Fatal(err)
	}
	h := Handler(dir)
	for _, path := range []string{"/", "/static/app.js", "/static/render-client.js", "/static/workbench.css", "/api/examples", "/api/example?name=test.json"} {
		w := request(h, "GET", path, "", "")
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if w := request(h, "GET", "/api/runtime", "", ""); w.Code != 200 || w.Body.String() != `{"renderer":"server"}` {
		t.Fatalf("native runtime discovery: %d %s", w.Code, w.Body)
	}
	w := request(h, "POST", "/api/validate", testJSON, "http://127.0.0.1:8080")
	if w.Code != 200 {
		t.Fatalf("validate: %d %s", w.Code, w.Body)
	}
	w = request(h, "POST", "/api/render", testJSON, "http://127.0.0.1:8080")
	if w.Code != 200 || !bytes.HasPrefix(w.Body.Bytes(), []byte("RIFF")) {
		t.Fatalf("render: %d %s", w.Code, w.Body)
	}
	var stats map[string]any
	if err := json.Unmarshal([]byte(w.Header().Get("X-Render-Stats")), &stats); err != nil {
		t.Fatal(err)
	}
	if stats["frames"] != float64(400) {
		t.Fatalf("bad stats: %v", stats)
	}
}

func TestWorkbenchRejectsInvalidRequests(t *testing.T) {
	h := Handler(t.TempDir())
	for _, tc := range []struct {
		path, body, origin string
		code               int
	}{
		{"/api/render", testJSON, "https://other.example", 403},
		{"/api/render", `{"version":1,"typo":true}`, "", 400},
		{"/api/render", strings.Replace(testJSON, `"sample_rate":8000`, `"sample_rate":96000`, 1), "", 400},
		{"/api/validate", strings.Replace(testJSON, `"type":"sine"`, `"type":"unknown"`, 1), "", 400},
	} {
		w := request(h, "POST", tc.path, tc.body, tc.origin)
		if w.Code != tc.code {
			t.Errorf("%s: got %d want %d: %s", tc.path, w.Code, tc.code, w.Body)
		}
	}
	w := request(h, "GET", "/api/example?name=../private.json", "", "")
	if w.Code != 400 {
		t.Fatal("accepted path traversal")
	}
	r := httptest.NewRequest("GET", "http://rebound.example/", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("accepted non-loopback Host")
	}
}

func TestLANRenderOrigin(t *testing.T) {
	h := Handler(t.TempDir())
	for _, origin := range []string{"http://192.168.1.20:8080", "http://other.example"} {
		r := httptest.NewRequest("POST", "http://192.168.1.20:8080/api/render", strings.NewReader(testJSON))
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if origin == "http://192.168.1.20:8080" {
			if w.Code != http.StatusOK || !bytes.HasPrefix(w.Body.Bytes(), []byte("RIFF")) {
				t.Fatalf("LAN render failed: %d %s", w.Code, w.Body)
			}
		} else if w.Code != http.StatusForbidden {
			t.Fatalf("cross-origin LAN request returned %d", w.Code)
		}
	}
}

func TestNativeLiveAssets(t *testing.T) {
	root := t.TempDir()
	examples := filepath.Join(root, "examples")
	if err := os.MkdirAll(examples, 0700); err != nil {
		t.Fatal(err)
	}
	h := Handler(examples)
	if w := request(h, "GET", "/static/synth.wasm", "", ""); w.Code != 404 || !strings.Contains(w.Body.String(), "build-web") {
		t.Fatalf("missing live assets: %d %s", w.Code, w.Body)
	}
	assets := filepath.Join(root, "dist", "static")
	if err := os.MkdirAll(assets, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"synth.wasm", "wasm_exec.js"} {
		if err := os.WriteFile(filepath.Join(assets, name), []byte("paired runtime fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		w := request(h, "GET", "/static/"+name, "", "")
		if w.Code != 200 || w.Body.String() != "paired runtime fixture" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "'wasm-unsafe-eval'") {
			t.Fatalf("live asset %s: %d %s", name, w.Code, w.Body)
		}
		if name == "synth.wasm" && w.Header().Get("Content-Type") != "application/wasm" {
			t.Fatal("incorrect WASM content type")
		}
	}
}
