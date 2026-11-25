package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const minimalScore = `{"version":1,"sample_rate":8000,"bpm":120,"beats":0.1,"nodes":[{"id":"tone","type":"sine"}],"output":{"left":"tone.out","right":"tone.out","gain":0.1}}`

type failedOutput struct{}

func (failedOutput) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestStatusWriteErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "score.json")
	if err := os.WriteFile(path, []byte(minimalScore), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"validate", path}, {"render", "-o", filepath.Join(dir, "out.wav"), path}} {
		if err := run(context.Background(), args, failedOutput{}, io.Discard); !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

func TestFailedRenderPreservesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "score.json")
	output := filepath.Join(dir, "out.wav")
	if err := os.WriteFile(path, []byte(strings.Replace(minimalScore, `"type":"sine"`, `"type":"not_a_module"`, 1)), 0600); err != nil {
		t.Fatal(err)
	}
	original := []byte("existing good audio")
	if err := os.WriteFile(output, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := run(context.Background(), []string{"render", "-o", output, path}, io.Discard, io.Discard); err == nil {
		t.Fatal("invalid patch rendered")
	}
	got, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, original) {
		t.Fatal("failed render changed existing output")
	}
	leftovers, err := filepath.Glob(filepath.Join(dir, ".render-*"))
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("temporary render left behind: %v %v", leftovers, err)
	}
}
