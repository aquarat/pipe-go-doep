package score

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestMetadataRoundTrip(t *testing.T) {
	for name, ui := range map[string]*UIState{
		"legacy":    nil,
		"collapsed": {},
		"expanded":  {TreeExpanded: []string{"", "/tracks", "/tracks/0/patterns", "/a~1b/~0key", "/", "/~01", "/音符"}},
	} {
		t.Run(name, func(t *testing.T) {
			d := fixture()
			d.UI = ui
			if ui != nil {
				d.ID = "20A08FFD-4FCB-4470-A0E1-17CC5EC3DE0C"
			}
			for round := 0; round < 2; round++ {
				b, err := json.Marshal(d)
				if err != nil {
					t.Fatal(err)
				}
				if ui == nil {
					var fields map[string]json.RawMessage
					if err := json.Unmarshal(b, &fields); err != nil {
						t.Fatal(err)
					}
					if fields["id"] != nil || fields["_ui"] != nil {
						t.Fatal("legacy document gained metadata")
					}
				}
				parsed, err := Parse(bytes.NewReader(b))
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(parsed, d) {
					t.Fatalf("round trip changed document: got %+v, want %+v", parsed, d)
				}
				d = parsed
			}
		})
	}
}

func TestMetadataUUIDVersionsAndVariants(t *testing.T) {
	for version := 1; version <= 8; version++ {
		for _, variant := range "89abAB" {
			d := fixture()
			d.ID = fmt.Sprintf("20a08ffd-4fcb-%d470-%c0e1-17cc5ec3de0c", version, variant)
			if err := d.Validate(); err != nil {
				t.Fatalf("valid UUID %q: %v", d.ID, err)
			}
		}
	}
}

func TestMetadataInvalidJSON(t *testing.T) {
	b, err := json.Marshal(fixture())
	if err != nil {
		t.Fatal(err)
	}
	for name, metadata := range map[string]string{
		"uuid shape":        `"id":"20a08ffd4fcb4470a0e117cc5ec3de0c"`,
		"uuid braces":       `"id":"{20a08ffd-4fcb-4470-a0e1-17cc5ec3de0c}"`,
		"uuid prefix":       `"id":"urn:uuid:20a08ffd-4fcb-4470-a0e1-17cc5ec3de0c"`,
		"uuid whitespace":   `"id":"20a08ffd-4fcb-4470-a0e1-17cc5ec3de0c "`,
		"uuid hex":          `"id":"20g08ffd-4fcb-4470-a0e1-17cc5ec3de0c"`,
		"uuid nil":          `"id":"00000000-0000-0000-0000-000000000000"`,
		"uuid version zero": `"id":"20a08ffd-4fcb-0470-a0e1-17cc5ec3de0c"`,
		"uuid version nine": `"id":"20a08ffd-4fcb-9470-a0e1-17cc5ec3de0c"`,
		"uuid variant":      `"id":"20a08ffd-4fcb-4470-c0e1-17cc5ec3de0c"`,
		"uuid type":         `"id":42`,
		"ui unknown":        `"_ui":{"pane_visible":true}`,
		"ui type":           `"_ui":[]`,
		"paths type":        `"_ui":{"tree_expanded":"/tracks"}`,
		"path type":         `"_ui":{"tree_expanded":[42]}`,
		"relative path":     `"_ui":{"tree_expanded":["tracks/0"]}`,
		"uri fragment":      `"_ui":{"tree_expanded":["#/tracks"]}`,
		"bare escape":       `"_ui":{"tree_expanded":["/tracks/~"]}`,
		"bad escape":        `"_ui":{"tree_expanded":["/tracks/~2"]}`,
		"doubled escape":    `"_ui":{"tree_expanded":["/tracks/~~0"]}`,
		"duplicate path":    `"_ui":{"tree_expanded":["/tracks","/tracks"]}`,
		"duplicate root":    `"_ui":{"tree_expanded":["",""]}`,
	} {
		t.Run(name, func(t *testing.T) {
			input := strings.Replace(string(b), `"version":1`, `"version":1,`+metadata, 1)
			if _, err := Parse(strings.NewReader(input)); err == nil {
				t.Fatal("expected metadata rejection")
			}
		})
	}
}

func TestMetadataLimits(t *testing.T) {
	d := fixture()
	d.UI = &UIState{TreeExpanded: make([]string, MaxTreeExpanded)}
	for i := range d.UI.TreeExpanded {
		d.UI.TreeExpanded[i] = fmt.Sprintf("/tracks/%d", i)
	}
	d.UI.TreeExpanded[0] = "/" + strings.Repeat("x", MaxTreePathBytes-1)
	if err := d.Validate(); err != nil {
		t.Fatalf("metadata at limits rejected: %v", err)
	}
	d.UI.TreeExpanded = append(d.UI.TreeExpanded, "/extra")
	if err := d.Validate(); err == nil {
		t.Fatal("excess path count accepted")
	}
	d.UI.TreeExpanded = []string{"/" + strings.Repeat("x", MaxTreePathBytes)}
	if err := d.Validate(); err == nil {
		t.Fatal("excess path length accepted")
	}
	d.UI.TreeExpanded = []string{"/" + strings.Repeat("音", MaxTreePathBytes/3+1)}
	if err := d.Validate(); err == nil {
		t.Fatal("path limit counted characters instead of bytes")
	}
}
