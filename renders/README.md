# Rendered audio

The initial local build includes:

- `lantern-duel.wav`: 38-second original four-source handheld-inspired composition.
- `neon-dojo.wav`: 44-second modern stereo reinterpretation.

Generated WAV/DOT files are ignored by Git. Recreate them from the repository root:

```sh
go run ./cmd/pipe-go-doep render -o renders/lantern-duel.wav examples/lantern-duel.json
go run ./cmd/pipe-go-doep render -o renders/neon-dojo.wav examples/neon-dojo.json
```

The workbench can also render/play the examples and download WAVs directly.
