# Initial build verification

Date: 2026-11-21T18:34:33Z

## Environment

Linux/arm64; Go 1.27.3; source compatibility target Go 1.23. No runtime dependencies
outside the Go standard library. Browser checks used a temporary Playwright setup
with the machine's existing Chromium; neither is an application dependency.

## Checks

- `go test ./...` and `go test -race ./...`: pass.
- `go vet ./...`: pass.
- CLI binary build: pass.
- Engine sample-loop benchmark (two-node oscillator/VCA graph): approximately
  53 ns/sample, **0 B/op, 0 allocations/op** on this host. This is a small dispatch
  benchmark, not a whole-composition performance claim.
- WAV format independently inspected with `ffprobe`: PCM signed 16-bit little-endian,
  44,100 Hz, two channels; classic demo duration exactly 38 seconds.

## Demo renders

| Composition | Duration incl. tail | Peak | RMS | Clipped channel samples | Render wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lantern Duel | 38 s | 0.265 | 0.059 | 0 | 2.12 s |
| Neon Dojo | 44 s | 0.252 | 0.040 | 0 | 3.89 s |

Measurements are linear amplitudes before PCM clipping. Timing depends on host
load. The compositions use deliberate headroom and are not loudness-normalized.

## Browser workflow exercised

- Load the classic example, validate it, render, decode, and advance audio playback.
- Load/render the modern example; observe the expected 44-second result.
- Change tempo, reload the page, and restore the edited local draft.
- Reject an unknown JSON field with a readable validation error.
- Render the desktop UI at 1440 px and mobile UI at 390 px; no horizontal overflow
  on mobile and no JavaScript page errors in these workflows.

The tests validate synthesis mathematics, sequencing, output format and application
behaviour. Musical taste and resemblance to a particular recording remain listening
judgements; the demo melodies were composed originally rather than transcribed.

## Visual workbench expansion — 2026-11-21T19:18:25Z

- Go tests, race checks and vet pass, including metadata roundtrip/limits and
  byte-identical audio with/without project UUID and tree metadata.
- Eleven dependency-free JavaScript tests pass for identity/storage/pointers and
  tracker timing, repeats, gate quantisation, clipping and bounded expansion.
- Rack component browser checks pass for both demos, all actual cable endpoints,
  default/explicit controls, mixer channels, icons, hidden panes and cleanup.
- The retained `workbench.browser.mjs` integration check passes: UUID-specific
  pane/view restoration, immediate reload after collapse, tree JSON export,
  rendered playback, stale-audio seek rejection, raw-draft recovery, delayed-load
  races, expansion-limit enforcement and 390-pixel mobile layout.
- Desktop/mobile screenshots were inspected. No document-level horizontal
  overflow or JavaScript errors occurred in the exercised integrated workflows.

The rack uses SVG/CSS faceplates and patch cables, with configured/default value
displays rather than fabricated live DSP telemetry. Runtime remains dependency-free.
