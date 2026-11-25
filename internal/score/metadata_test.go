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

func TestScopeMetadataRoundTrip(t *testing.T) {
	for name, scope := range map[string]*ScopeState{
		"empty":    {},
		"mode":     {Mode: "xy"},
		"inputs":   {Inputs: map[string]ProbeRef{"y1": {Node: "osc", Port: "out", Direction: "output"}, "x": {Bus: "left"}}},
		"all":      {Mode: "yt", Inputs: map[string]ProbeRef{"x": {Bus: "right"}, "y1": {Node: "osc", Port: "freq", Direction: "input"}, "y2": {Node: "seq", Port: "gate", Direction: "output"}, "y3": {Bus: "left"}, "y4": {Node: "osc", Port: "out", Direction: "output"}}},
		"dangling": {Inputs: map[string]ProbeRef{"y2": {Node: "deleted", Port: "out", Direction: "output"}, "y3": {Node: "osc", Port: "missing", Direction: "input"}}},
	} {
		t.Run(name, func(t *testing.T) {
			d := fixture()
			d.UI = &UIState{TreeExpanded: []string{"/nodes"}, Scope: scope}
			for round := 0; round < 2; round++ {
				b, err := json.Marshal(d)
				if err != nil {
					t.Fatal(err)
				}
				parsed, err := Parse(bytes.NewReader(b))
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(parsed, d) {
					t.Fatalf("round trip changed scope: got %+v, want %+v", parsed.UI.Scope, d.UI.Scope)
				}
				d = parsed
			}
		})
	}
	const contract = `"_ui":{"tree_expanded":["/nodes"],"scope":{"mode":"yt","inputs":{"y1":{"node":"lead","port":"out","direction":"output"},"x":{"bus":"left"}}}}`
	b, _ := json.Marshal(fixture())
	d, err := Parse(strings.NewReader(strings.Replace(string(b), `"version":1`, `"version":1,`+contract, 1)))
	if err != nil {
		t.Fatalf("contract example rejected: %v", err)
	}
	want := &ScopeState{Mode: "yt", Inputs: map[string]ProbeRef{"y1": {Node: "lead", Port: "out", Direction: "output"}, "x": {Bus: "left"}}}
	if !reflect.DeepEqual(d.UI.Scope, want) {
		t.Fatalf("decoded %+v", d.UI.Scope)
	}
}

func TestScopeMetadataInvalidJSON(t *testing.T) {
	b, err := json.Marshal(fixture())
	if err != nil {
		t.Fatal(err)
	}
	for name, scope := range map[string]string{
		"scope type":        `[]`,
		"scope unknown":     `{"timebase":5}`,
		"mode unknown":      `{"mode":"xyz"}`,
		"mode case":         `{"mode":"YT"}`,
		"mode type":         `{"mode":1}`,
		"inputs type":       `{"inputs":[]}`,
		"channel unknown":   `{"inputs":{"y5":{"bus":"left"}}}`,
		"channel case":      `{"inputs":{"Y1":{"bus":"left"}}}`,
		"ref null":          `{"inputs":{"y1":null}}`,
		"ref empty":         `{"inputs":{"y1":{}}}`,
		"ref string":        `{"inputs":{"y1":"osc.out"}}`,
		"ref unknown":       `{"inputs":{"y1":{"node":"osc","port":"out","direction":"output","label":"x"}}}`,
		"bus unknown":       `{"inputs":{"y1":{"bus":"centre"}}}`,
		"bus and node":      `{"inputs":{"y1":{"bus":"left","node":"osc"}}}`,
		"bus and direction": `{"inputs":{"y1":{"bus":"left","direction":"output"}}}`,
		"missing direction": `{"inputs":{"y1":{"node":"osc","port":"out"}}}`,
		"bad direction":     `{"inputs":{"y1":{"node":"osc","port":"out","direction":"both"}}}`,
		"missing port":      `{"inputs":{"y1":{"node":"osc","direction":"output"}}}`,
		"missing node":      `{"inputs":{"y1":{"port":"out","direction":"output"}}}`,
		"bad node id":       `{"inputs":{"y1":{"node":"osc.out","port":"out","direction":"output"}}}`,
		"bad port id":       `{"inputs":{"y1":{"node":"osc","port":"1out","direction":"output"}}}`,
		"port type":         `{"inputs":{"y1":{"node":"osc","port":7,"direction":"output"}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			input := strings.Replace(string(b), `"version":1`, `"version":1,"_ui":{"scope":`+scope+`}`, 1)
			if _, err := Parse(strings.NewReader(input)); err == nil {
				t.Fatal("expected scope rejection")
			}
		})
	}
}
