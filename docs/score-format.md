# Score format (version 1)

A score is one JSON object describing tempo, monophonic tracks, a modular audio
graph, and explicit stereo outputs. `internal/score.Parse(io.Reader)` decodes and
validates it; `Document.Validate()` also supports documents constructed in Go.
`Document.CompileTrack(id)` validates the document and returns sample-indexed
note events. These operations use only the Go standard library.

## Example

```json
{
  "version": 1,
  "title": "Two notes",
  "sample_rate": 48000,
  "bpm": 120,
  "beats": 4,
  "tail_seconds": 1,
  "seed": 42,
  "tracks": [{
    "id": "melody",
    "transpose": 0,
    "patterns": {
      "phrase": [
        {"note": "A4", "beats": 1},
        {"note": ".", "beats": 1},
        {"note": "C#5", "beats": 2, "velocity": 0.7, "gate": 0.8}
      ]
    },
    "order": ["phrase"]
  }],
  "nodes": [
    {"id": "seq", "type": "sequence", "track": "melody"},
    {"id": "osc", "type": "sine"},
    {"id": "env", "type": "adsr", "params": {"attack": 0.01, "release": 0.2}},
    {"id": "amp", "type": "vca"},
    {"id": "velocity", "type": "vca"}
  ],
  "connections": [
    {"from": "seq.freq", "to": "osc.freq"},
    {"from": "seq.gate", "to": "env.gate"},
    {"from": "seq.trigger", "to": "env.trigger"},
    {"from": "osc.out", "to": "amp.in"},
    {"from": "env.out", "to": "amp.gain"},
    {"from": "amp.out", "to": "velocity.in"},
    {"from": "seq.velocity", "to": "velocity.gain"}
  ],
  "output": {"left": "velocity.out", "right": "velocity.out", "gain": 0.3}
}
```

## Document fields

| Field | Meaning / bounds |
| --- | --- |
| `version` | Must be integer `1`. |
| `id` | Optional project UUID; absent/empty means a legacy document without identity. |
| `_ui` | Optional editor metadata: `tree_expanded` and `scope`. |
| `title` | Optional display text, at most 1024 UTF-8 bytes. |
| `sample_rate` | Integer, 8000–96000 samples/second inclusive. |
| `bpm` | Finite tempo, 1–1000 beats/minute inclusive. |
| `beats` | Finite musical duration, greater than zero and at most 5000 beats. |
| `tail_seconds` | Optional nonnegative effect/release tail, default 0. |
| `seed` | Optional unsigned 64-bit integer seed, default 0. |
| `tracks` | Track definitions; may be empty for a graph without sequencers. |
| `nodes` | At least one graph node. |
| `connections` | Directed `node.port` connections; may be empty. |
| `output` | Explicit `left`, `right` source references and finite `gain` in 0–16. |

The total duration `beats * 60 / bpm + tail_seconds` must be at most 300 seconds.
Its WAV frame count, `round(totalDuration * sample_rate)`, must be at least one;
`Validate` rejects positive durations that round to zero frames. The tail counts
toward this minimum as well as the maximum.
Timing, sample rate, version, and output references must be supplied. Missing
`output.gain` is Go's zero value (silence), so set it explicitly. Other optional
numeric fields use zero unless otherwise noted below.

Identifiers (tracks, patterns, nodes, ports, types, and parameter names) have at
most 64 ASCII characters: an initial letter or underscore followed by letters,
digits, underscores, or hyphens. Track IDs and node IDs are unique within their
respective namespaces. Pattern names are local to a track.

## Project identity and editor state

`id` and `_ui` are backward-compatible additive fields in version **1**. Existing
scores without either field still parse. Neither field affects scheduling, DSP,
random seeds, or rendered audio. Go preserves a supplied identity when parsing
and serializing; it does not generate one. The browser assigns a UUID when loading
a legacy project and retains it in saved/exported JSON. The bundled examples each
carry a stable, generated version-4 UUID.

A nonempty `id` must have the canonical UUID shape
`xxxxxxxx-xxxx-Vxxx-Nxxx-xxxxxxxxxxxx`, using hexadecimal digits, version `V` in
1–8 and variant `N` in `8`, `9`, `a`, or `b`. Hex letters are case-insensitive and
their original case is preserved. Braces, URN prefixes, and surrounding whitespace
are rejected. This project identity is independent of track/node identifiers.

```json
{
  "id": "20a08ffd-4fcb-4470-a0e1-17cc5ec3de0c",
  "_ui": {"tree_expanded": ["", "/tracks", "/tracks/0"]}
}
```

This fragment shows only the optional metadata. `_ui.tree_expanded` is an array
of unique JSON Pointer strings describing expanded JSON-tree rows. The empty
string `""` identifies the root; every other pointer starts with `/`. Inside a
path token, `~0` escapes a literal tilde and `~1` escapes a literal slash; other
tilde escapes are invalid. URI-fragment pointers such as `#/tracks` are not
supported. Paths need not currently resolve, so edits can leave harmless stale
view state. At most 4096 paths are allowed, each at most 1024 UTF-8 bytes.
Duplicate paths, including duplicate root entries, are rejected.

Missing `_ui`, missing/empty `tree_expanded`, and paths not listed all default to
collapsed. Tree expansion travels with the project JSON. Pane visibility and
component-specific views live in browser storage keyed by the project UUID.
Unknown `_ui` fields are rejected just like unknown score fields.

### Oscilloscope probes

`_ui.scope` stores the oscilloscope patch. It never affects scheduling, DSP or
rendered audio.

```json
"_ui": {
  "scope": {
    "mode": "yt",
    "inputs": {
      "y1": {"node": "lead", "port": "out", "direction": "output"},
      "x": {"bus": "left"}
    }
  }
}
```

- `mode` is optional: `yt` (Y1-Y4 against time; the default) or `xy` (each Y
  against X).
- `inputs` is optional and maps channel names `x`, `y1`, `y2`, `y3`, `y4` to a
  probe reference: either `{"node", "port", "direction"}` with identifier-shaped
  `node`/`port` and `direction` `input` or `output`, or `{"bus": "left"|"right"}`
  (stereo output after master gain, before clamping). Exactly one form is
  allowed; mixing `bus` with node fields, `null` references and unknown fields
  are rejected.
- A reference to a node or port that does not exist is valid. It is a dangling
  probe shown as unresolved, so deleting a module never invalidates a project.

Display settings (timebase, scales, trigger, persistence) are browser view
state, not `_ui`.

## Tracks and pitches

Each track has `id`, a nonempty `patterns` map, a nonempty `order` array, and an
optional integer `transpose` (semitones, default 0, range −127–127). Each pattern
is a nonempty step array. `order` names existing patterns in playback order:
`["verse", "verse", "chorus"]` plays the verse twice. There is no implicit loop.
Tracks begin at beat zero; use rests for an initial offset. Playback after the
last ordered pattern is silent at the sequence gate, even if document beats
remain. All tracks share the document tempo and musical end.

Each step has:

- `note`: scientific pitch such as `C4`, `A4`, `F#3`, or `Bb2`; `.` is a rest.
  Letters A–G are case-insensitive, with an optional single ASCII `#` or `b`,
  then an integer octave. Double accidentals and Unicode accidentals are not
  supported. Enharmonic notes work across octave boundaries (`B#3` is `C4`).
  Both the written pitch and transposed pitch must lie in MIDI 0–127
  (`C-1` through `G9`). Octave text has one or two digits, optionally negative.
- `beats`: finite length, 0.000001–5000 inclusive. This advances the track even
  for rests or silent notes.
- `velocity`: optional finite value in 0–1, default **1**. Explicit zero is
  retained and still yields a timed note event when its gate has positive length.
- `gate`: optional finite fraction of the step in 0–1, default **0.85**. A value
  of 1 sustains to the next step; 0 produces no event. Gates above 1 are rejected
  to preserve monophony. `null` velocity or gate has the same meaning as omission.

Rest steps' optional velocity/gate fields are validated but have no audible
effect. Pitch conversion uses equal temperament: `440 * 2^((MIDI - 69) / 12)` Hz.

## Scheduling and sequence outputs

Beat durations accumulate continuously across pattern boundaries. Compilation
uses compensated floating-point summation and rounds each **absolute** boundary
to the nearest sample (`math.Round`, ties away from zero):

```text
start = round(startBeat * 60 / bpm * sampleRate)
end   = round((startBeat + stepBeats * gate) * 60 / bpm * sampleRate)
```

The implementation precomputes samples per beat. Ends are capped at the next
step boundary and the rounded document musical end. This avoids accumulating
per-step sample-rounding drift. The result is an ordered `[]Event`, each with
`Start`, exclusive `End`, `Frequency`, and `Velocity`. Rests do not create events;
notes that round to zero samples are omitted. No event begins or extends into
the effect tail. A short order is not repeated to fill the document; an overlong
order is clipped. Adjacent gate-1 notes may touch but cannot overlap.

**Emitted note onsets in each track must be at least two samples apart.** A
one-sample note immediately followed by another note is rejected; a one-sample
note followed by a one-sample rest and another note is valid. The trigger output
needs a low sample between its one-sample pulses so rising-edge ADSR and reset
inputs can distinguish them. `CompileTrack` checks this after quantization and
clipping and returns an actionable error: lengthen steps, add a rest, or increase
the sample rate. This temporal check is performed during track/engine compilation,
not structural `Validate`. Omitted zero-length/gate-zero events and rests do not
create triggers and are excluded; emitted zero-velocity notes still count.

The engine's `sequence` node consumes these events and exposes `freq`, `gate`,
`velocity`, and `trigger`. Gate is high for `[Start, End)`; trigger pulses for one
sample on note-on, including adjacent legato notes. During rests and after the
final event, gate and trigger are zero. **Frequency and velocity hold their last
note values through rests and envelope release; initial frequency is 440 Hz and
initial velocity is zero.** This
allows a velocity-controlled VCA to preserve an ADSR release instead of cutting
it off at note-off.

## Graph validation boundary

A node has `id`, `type`, optional numeric `params`, and an optional `track`.
Only `sequence` nodes may specify `track`; they require an existing track and
accept no static parameters. Other node types and their parameter names/ranges
are validated by the DSP factory. Score validation bounds every static parameter
to a finite number in −1e9–1e9 and checks names.

Connections specify `from` and `to` as `node.port`. Score validation checks
reference syntax, node existence, and one source per destination input. Both
output references must exist at node level; left and right may use the same
source. The graph compiler additionally checks port existence, input/output
direction, supported module types and parameters, and acyclicity. Passing score
validation alone does not guarantee a graph can be rendered.

## Untrusted-input limits

`Parse` accepts at most 4 MiB including whitespace. It rejects unknown struct
fields at all nesting levels, malformed JSON, non-object top-level values, and
any second JSON value or trailing non-whitespace data. JSON decoding uses Go's
standard `encoding/json` field matching and duplicate-key behavior (later keys
win); it does not implement a separate canonical-JSON parser.

The following limits apply **across the entire document**, not per track:

| Resource | Maximum |
| --- | ---: |
| Tracks | 32 |
| Nodes | 128 |
| Connections | 1024 |
| Patterns | 1024 |
| Stored steps | 65,536 |
| Order entries | 16,384 |
| Expanded steps after order repetition | 262,144 |
| Potential note events after order repetition | 131,072 |
| Parameters per node | 32 |
| Expanded JSON-tree paths | 4096 |
| Bytes per JSON-tree path | 1024 |

Unused patterns are validated and count toward stored limits. Every order entry
counts toward expanded limits, including repetitions and entries after the
musical end. Every non-rest ordered step counts as a potential event even when
its velocity/gate is zero or its event will be clipped away. These conservative
limits prevent short JSON orders from expanding into unbounded scheduler work.
`CompileTrack` revalidates programmatically modified scores before allocation.
