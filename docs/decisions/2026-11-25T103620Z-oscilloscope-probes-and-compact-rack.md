# Oscilloscope probes, compact rack and cable labels

Date: 2026-11-25T10:36:20Z
Status: accepted

## Context

The maintainer asked for an oscilloscope that can be patched from any jack in the
rack, with either X/Y input or a time base and up to four Y inputs; narrower,
content-sized rack modules; and short labels drawn along every cable.

## Decision

The oscilloscope is an observer, not a DSP module. Its cables are **probes**
stored in `_ui.scope` (`mode`, `inputs.x`, `inputs.y1`…`y4`), next to the JSON
tree state. A probe names a module jack (`node`, `port`, `direction`: input or
output) or the stereo bus after master gain. Because `_ui` is excluded from the
sound signature, patching the scope never changes the audio, invalidates a WAV
render or restarts the live engine. Dangling probes (for example after a module
is deleted) are kept and shown as unresolved, not rejected.

The live Go engine records up to five probes per produced sample, with no
per-sample allocation, and returns them with each PCM block. The browser keeps a
short ring indexed by absolute frame and draws the window ending at the audible
position, so the trace lines up with what is heard even though blocks are read
about 100 ms ahead. YT mode supports a time base, per-channel scale/offset and
edge triggering; XY mode plots each Y against X with persistence. Display settings
are browser view state per project; the probe patch travels with the project.

The scope requires the live synth. Rendered-WAV playback and plain LAN HTTP show
a "Live synth only" state instead of attempting an offline probe render.

Rack modules use Eurorack-like widths (HP) derived from their controls and jacks,
with jack labels above the rings so hanging cables do not cover them. Every cable
(patch, output bus and probe) carries a `textPath` label kept upright and fitted to
the cable length: full form, then a shortened form, otherwise hidden.

## Consequences

The scope faceplate sits first in the rack. Its height sets the first row's
height, so modules beside it are taller than in other rows. The probe data adds
roughly 6% to live block synthesis time with five probes. Probe names must be
identifier-like, matching node id rules.
