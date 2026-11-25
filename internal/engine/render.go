package engine

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/aquarat/pipe-go-doep/internal/score"
)

// Stats measures the pre-clamp stereo output. ClippedSamples counts individual
// channel samples, not frames. No normalisation changes a score's intended mix.
type Stats struct {
	Frames         int64   `json:"frames"`
	SampleRate     int     `json:"sample_rate"`
	Seconds        float64 `json:"seconds"`
	Peak           float64 `json:"peak"`
	RMS            float64 `json:"rms"`
	ClippedSamples int64   `json:"clipped_samples"`
	RenderSeconds  float64 `json:"render_seconds"`
}

// Render streams PCM16 stereo WAV to w. The caller must discard partial output
// on error. Cancellation is checked at least once every 1024 frames.
func Render(ctx context.Context, d *score.Document, w io.Writer) (Stats, error) {
	start := time.Now()
	p, err := Compile(d)
	if err != nil {
		return Stats{}, err
	}
	frames := int64(math.Round((d.Beats*60/d.BPM + d.TailSeconds) * float64(d.SampleRate)))
	stats := Stats{Frames: frames, SampleRate: d.SampleRate, Seconds: float64(frames) / float64(d.SampleRate)}
	if err = writeHeader(w, d.SampleRate, frames); err != nil {
		return stats, err
	}
	buffer := make([]byte, 1024*4)
	var sumSquares float64
	for offset := int64(0); offset < frames; {
		if err := ctx.Err(); err != nil {
			return stats, err
		}
		count := int64(1024)
		if frames-offset < count {
			count = frames - offset
		}
		for j := int64(0); j < count; j++ {
			left, right := p.tick()
			for ch, x := range [2]float64{left, right} {
				if !finite(x) {
					return stats, fmt.Errorf("non-finite output at frame %d channel %d", offset+j, ch)
				}
				stats.Peak = math.Max(stats.Peak, math.Abs(x))
				sumSquares += x * x
				if x > 1 || x < -1 {
					stats.ClippedSamples++
				}
				x = math.Max(-1, math.Min(1, x))
				value := int16(math.Round(x * 32767))
				binary.LittleEndian.PutUint16(buffer[j*4+int64(ch*2):], uint16(value))
			}
		}
		if err := writeAll(w, buffer[:count*4]); err != nil {
			return stats, err
		}
		offset += count
	}
	stats.RMS = math.Sqrt(sumSquares / float64(frames*2))
	stats.RenderSeconds = time.Since(start).Seconds()
	return stats, nil
}

func writeAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}

func writeHeader(w io.Writer, sampleRate int, frames int64) error {
	if frames <= 0 || frames*4 > math.MaxUint32-36 {
		return fmt.Errorf("WAV frame count out of range")
	}
	h := make([]byte, 44)
	copy(h, "RIFF")
	binary.LittleEndian.PutUint32(h[4:], uint32(frames*4+36))
	copy(h[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(h[16:], 16)
	binary.LittleEndian.PutUint16(h[20:], 1)
	binary.LittleEndian.PutUint16(h[22:], 2)
	binary.LittleEndian.PutUint32(h[24:], uint32(sampleRate))
	binary.LittleEndian.PutUint32(h[28:], uint32(sampleRate*4))
	binary.LittleEndian.PutUint16(h[32:], 4)
	binary.LittleEndian.PutUint16(h[34:], 16)
	copy(h[36:], "data")
	binary.LittleEndian.PutUint32(h[40:], uint32(frames*4))
	return writeAll(w, h)
}
