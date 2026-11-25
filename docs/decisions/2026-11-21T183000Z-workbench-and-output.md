# Local workbench and reproducible output

Date: 2026-11-21T18:30:00Z
Status: accepted

## Decision

Provide the same compiler/renderer through CLI and a loopback browser workbench.
Embed the UI in the Go binary; keep score examples as ordinary JSON files. Render
stereo PCM16 WAV with a known frame count, preserving floating-point headroom until
the output stage. Report peak/RMS and clipping instead of automatically normalising.
Use atomic rename for successful CLI output and browser downloads in the workbench.

Frequency and velocity CV hold after note-off; gate and trigger drop. In particular,
held velocity allows a velocity VCA to coexist with envelope release tails.

## Consequences

The application is portable with no third-party packages and no native audio
driver setup. Playback starts only on user interaction. Rendered audio represents
a snapshot; later score edits require another render. The initial UI is a code
editor with a read-only module rack, not an interactive cable-dragging surface.

Output hard-clamps samples beyond full scale and reports every clipped channel
sample. Users can lower master gain or deliberately patch a drive module. No
dithering, loudness normalisation or sample-rate conversion is implicit. Explicit
effect-tail duration makes file lengths predictable but must be long enough for
the chosen envelopes and delay feedback.
