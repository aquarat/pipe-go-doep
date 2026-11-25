package score_test

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/aquarat/pipe-go-doep/internal/engine"
	"github.com/aquarat/pipe-go-doep/internal/score"
)

func TestExampleMetadataDoesNotAffectRender(t *testing.T) {
	for _, name := range []string{"lantern-duel", "neon-dojo"} {
		t.Run(name, func(t *testing.T) {
			b, err := os.ReadFile("../../examples/" + name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			d, err := score.Parse(bytes.NewReader(b))
			if err != nil {
				t.Fatal(err)
			}
			if d.ID == "" || d.ID[14] != '4' {
				t.Fatal("example needs a stable version-4 UUID")
			}
			// A short excerpt exercises each example's graph and seeded DSP.
			d.Beats, d.TailSeconds = 1, 0
			d.UI = &score.UIState{TreeExpanded: []string{"", "/tracks", "/nodes/0"}}
			var withMetadata, withoutMetadata bytes.Buffer
			withStats, err := engine.Render(context.Background(), d, &withMetadata)
			if err != nil {
				t.Fatal(err)
			}
			d.ID, d.UI = "", nil
			withoutStats, err := engine.Render(context.Background(), d, &withoutMetadata)
			if err != nil {
				t.Fatal(err)
			}
			withStats.RenderSeconds, withoutStats.RenderSeconds = 0, 0
			if !bytes.Equal(withMetadata.Bytes(), withoutMetadata.Bytes()) || withStats != withoutStats {
				t.Fatal("identity/tree metadata changed rendered WAV or statistics")
			}
		})
	}
}
