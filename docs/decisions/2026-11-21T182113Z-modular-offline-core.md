# Modular offline core

Date: 2026-11-21T18:21:13Z
Status: accepted

## Context

Explore original handheld chip music in a Go instrument whose architecture can grow toward modern synthesis. Patching should resemble modular hardware and flowgraph systems, with readable source scores and reproducible output.

## Decision

Start with a dependency-free Go offline renderer and local browser workbench. Store versioned JSON scores, ordered reusable tracker patterns, and explicit module/port connections together. Compile each patch into a topologically ordered graph with preallocated port buffers. Audio and modulation use the same scalar signal path. Keep sequencing, DSP, graph scheduling and WAV output separate.

Use a Game Boy-inspired palette (pulse, quantized wavetable, LFSR noise), rather than cycle-accurate hardware emulation. Support modern filtering, stereo placement, saturation and delay in the same graph. Compose original demo music rather than transcribing a game soundtrack.

## Consequences

Every control can eventually be a signal. This first version processes all nodes at audio rate: simple and flexible, with a measurable future block-processing optimisation path. Explicit graph cycles are rejected; the delay module encapsulates its own feedback. Real-time MIDI, device audio, arbitrary feedback routing, polyphonic allocation and a graphical cable editor are future work. Offline rendering avoids OS-specific audio dependencies and lets the browser audition portable WAV files.
