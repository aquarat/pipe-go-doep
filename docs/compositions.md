# Two original demo compositions

Both JSON files are standalone version-1 scores: no samples, plugins, network access, or runtime generators are required. They share a newly written motif, not a quotation from Samurai Shodown or another game. The influence is the economical phrasing and bright timbral contrast of Japanese arcade/handheld music.

| Score | Tempo | Form | Music + tail |
| --- | --- | --- | --- |
| `examples/lantern-duel.json` | 160 BPM | 24 four-beat bars | 36 + 2 seconds |
| `examples/neon-dojo.json` | 132 BPM | 22 four-beat bars | 40 + 4 seconds |

Both render at 44.1 kHz with explicit stereo outputs and conservative mix levels. Each track lists its complete pattern order; nothing loops implicitly. Every pattern is one four-beat bar. Fixed seeds make the LFSR percussion reproducible.

Full engine renders during authoring produced zero clipped samples: Lantern peak 0.265 / RMS 0.059; Neon peak 0.252 / RMS 0.040. Both had silent final seconds in PCM16, with measurable left/right differences during the music. These are intentionally unnormalized mixes.

## The shared musical idea

The core call leaps **D–A–C–A**, then answers **G–A–F–E–D**. D-minor pentatonic notes (D, F, G, A, C) provide the recognizable shape; E is a passing/neighbor tone. Bb colors the subdominant, and C# appears intentionally over A dominant to pull back to D minor. It is not an all-pentatonic piece.

The A section uses **Dm–F–Gm–A**, twice. B opens the register over **Bb–C–Dm–A**, twice. The second pass of each section changes rhythm, register, and cadences rather than simply repeating the first. Short bass approach notes and fifths keep the harmony moving; the low C#/E dominant pickup leads into the final D. The ending's D/F suspensions over A resolve into that final tonic.

## Lantern Duel

- **Bars 1–2:** sparse arpeggio/noise introduction, then a rising pickup and snare fill.
- **Bars 3–10:** the main call, answer, and varied second pass.
- **Bars 11–18:** higher B-section responses; the second pulse becomes a slower counterline, leaving room around the lead.
- **Bars 19–22:** compact, decorated return of A.
- **Bars 23–24:** descending cadence and a held tonic, followed by silence for release.

Exactly **four sound-generating nodes** are used:

1. `melody_osc`: 25%-duty pulse, crisp attacks and short releases.
2. `counter_osc`: 12.5%-duty pulse, alternating sixteenth-note arpeggios and answering phrases.
3. `bass_osc`: 32-step wavetable triangle, amplitude-quantized to 4 bits; alternating grounded and syncopated bass bars.
4. `drum_noise`: one long-mode LFSR noise source, shared by three percussion branches.

The noise branches have separate sequences, filters, and ADSRs: a short bright hat, a longer midrange snare, and a low filtered thud. Alternating hat accents, ghost snares, pickups, and sectional fills make the groove breathe. The thud is filtered noise, not a hidden kick oscillator. Six control tracks do **not** mean six sound sources.

This is a four-source educational arrangement rather than a cycle-accurate console emulation: the shared noise can feed simultaneous envelopes, filters shape its bands, and stereo panning is available. No extra oscillator, delay, or modulation oscillator is hidden in the patch.

## Neon Dojo

- **Bars 1–2:** sparse opening and pickup.
- **Bars 3–10:** related A theme, with more space around selected syncopations.
- **Bars 11–18:** broader sustained phrases, a new soft upper layer, and half-time snare placement; bar 18 fills back into the return.
- **Bars 19–22:** one-bar motif return, cadence, fragmenting echo response, and tonic release.

The slower tempo allows the same contour to feel weightier. A filtered saw replaces the second pulse; the quantized bass gains mild drive before its amplitude envelope and a separate sine sub-bass. A quiet triangle fifth layer enters at B. Stereo eighth-note and dotted-eighth delays (about 227 and 341 ms) blur the melodic bus while percussion stays direct.

`filter_lfo` is a 0.275 Hz sine controlling the lead low-pass cutoff from approximately 1.9 to 4.5 kHz. Three bounded-gain VCAs scale its depth; `filter_center` supplies the 3.2 kHz center. This patch has six audible generators plus that control oscillator, deliberately exceeding the classic score's restriction. Stereo placement is wider, with centered bass and sub. The final notes end before the score boundary, and four further seconds let the low-feedback delay and releases decay naturally.

## Reading and tweaking the patches

- Follow `*_seq.freq → *_osc.freq` and `*_seq.gate/trigger → *_shape.gate/trigger`. Explicit triggers retrigger envelopes on repeated pitches.
- Each voice then passes through an envelope VCA and a second velocity VCA. Sequence velocity **holds at note-off**, so the ADSR release survives. Initial velocity is zero.
- `*_level.params.gain` sets the mix balance; `*_pan.params.pan` sets stereo placement. `output.gain` is the final gain, initially 0.72. Leave room for summed transients when increasing either.
- For a rounder classic lead, change `melody_osc.params.duty` from 0.25 to 0.5. Compare the narrow counter pulse against the lead before changing both.
- Change `bass_osc.params.bits` from 4 to 3 or 6 to hear quantization on the classic wavetable. The 32-step table and amplitude bit depth are distinct constraints.
- Change `drum_noise.params.short` to 1 for a more periodic, metallic noise character. Adjust the three `*_shape` decay/release values independently; drum step gates and velocities also change articulation.
- In Neon, reduce `filter_depth.params.gain` to reduce the sweep. Keep each scaling VCA within the implementation's gain bounds. Reduce `bass_drive.params.amount` for a cleaner bass.
- To retime Neon’s echoes after changing tempo, set `echo_l.params.time = 60 / BPM × 0.5` and `echo_r.params.time = 60 / BPM × 0.75`. Delay times are seconds, not tempo-synchronized automatically. Leave sufficient `tail_seconds` when raising feedback.
- For a longer arrangement, add corresponding bar names to **every** track's `order` and increase document `beats` by four per new bar. Track `transpose` is in semitones; transpose all pitched tracks together, leaving percussion control pitches alone.

From the project root:

```sh
go run ./cmd/pipe-go-doep validate examples/lantern-duel.json
go run ./cmd/pipe-go-doep render -o renders/lantern-duel.wav examples/lantern-duel.json
go run ./cmd/pipe-go-doep render -o renders/neon-dojo.wav examples/neon-dojo.json
```
