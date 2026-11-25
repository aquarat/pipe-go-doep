import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeRing, findTrigger, analyse, traceYT, traceXY, valueToX, valueToY, nearestScale, formatValue, CHANNELS } from './scope-view.js';

const block = (position, frames, channels, fn, sampleRate = 48000) => {
  const data = new Float32Array(frames * channels.length);
  for (let i = 0; i < frames; i++) channels.forEach((c, k) => { data[i * channels.length + k] = fn(position + i, c); });
  return { position, frames, sampleRate, channels, unresolved: [], data };
};
const recorder = () => {
  const calls = [];
  return { calls, moveTo: (x, y) => calls.push(['m', x, y]), lineTo: (x, y) => calls.push(['l', x, y]) };
};
const Y1 = CHANNELS.indexOf('y1'), X = CHANNELS.indexOf('x'), Y2 = CHANNELS.indexOf('y2');

test('ring is indexed by absolute frame, maps block channel order and reads unwritten frames as NaN', () => {
  const ring = createProbeRing(1);
  assert.equal(ring.write(block(1000, 100, ['y2', 'x'], (f, c) => c === 'x' ? f : -f)), true);
  assert.equal(ring.sampleRate, 48000);
  assert.ok(ring.size >= 48000 && (ring.size & (ring.size - 1)) === 0);
  assert.equal(ring.value(X, 1000), 1000); assert.equal(ring.value(Y2, 1099), -1099);
  assert.ok(Number.isNaN(ring.value(Y1, 1050)), 'unprobed channel');
  assert.ok(Number.isNaN(ring.value(X, 999))); assert.ok(Number.isNaN(ring.value(X, 1100)));
  assert.ok(Number.isNaN(ring.value(X, 1000 + ring.size)), 'aliased slot is not valid for another frame');
  ring.clear(); assert.ok(Number.isNaN(ring.value(X, 1000)));
});

test('later blocks overwrite the same frames, and wrapping evicts old frames', () => {
  const ring = createProbeRing(1);
  ring.write(block(0, 2048, ['y1'], () => 1));
  ring.write(block(1024, 512, ['y1'], () => 2)); // loop seam / grain re-read
  assert.equal(ring.value(Y1, 1023), 1); assert.equal(ring.value(Y1, 1024), 2);
  assert.equal(ring.value(Y1, 1535), 2); assert.equal(ring.value(Y1, 1536), 1);
  ring.write(block(10, 4, ['x'], () => 5));
  assert.ok(Number.isNaN(ring.value(Y1, 10)), 'a later block without the channel clears it for those frames');
  const size = ring.size;
  ring.write(block(size + 5, 1, ['y1'], () => 9));
  assert.ok(Number.isNaN(ring.value(Y1, 5))); assert.equal(ring.value(Y1, size + 5), 9);
  const big = createProbeRing(1);
  big.write(block(0, 8000, ['y1'], f => f, 2000)); // larger than the ring: keeps the newest frames
  assert.equal(big.value(Y1, 7999), 7999); assert.ok(Number.isNaN(big.value(Y1, 0)));
});

test('ring rejects malformed blocks and reallocates on sample-rate change', () => {
  const ring = createProbeRing(1);
  assert.equal(ring.write({ position: 0, frames: 2, sampleRate: 48000, channels: ['y1'], data: new Float32Array(3) }), false);
  assert.equal(ring.write({ position: -1, frames: 1, sampleRate: 48000, channels: ['y1'], data: new Float32Array(1) }), false);
  assert.equal(ring.write(null), false);
  ring.write(block(0, 10, ['y1'], () => 1));
  ring.write(block(0, 10, ['y1'], () => 2, 22050));
  assert.equal(ring.sampleRate, 22050); assert.equal(ring.value(Y1, 3), 2);
});

test('trigger finds the latest crossing for each slope, skipping gaps', () => {
  const ring = createProbeRing(1);
  const period = 100;
  ring.write(block(0, 1000, ['y1'], f => Math.sin(2 * Math.PI * (f - .5) / period)));
  const rising = findTrigger(ring, Y1, 0, 950, 0, true);
  assert.equal(rising % period, 1); assert.ok(rising <= 950 && rising > 850);
  const falling = findTrigger(ring, Y1, 0, 950, 0, false);
  assert.equal(falling % period, 51); assert.ok(falling <= 950 && falling > 850);
  const level = findTrigger(ring, Y1, 0, 999, .5, true);
  assert.ok(ring.value(Y1, level - 1) < .5 && ring.value(Y1, level) >= .5);
  assert.equal(findTrigger(ring, Y1, 0, 999, 2, true), -1, 'level outside signal');
  assert.equal(findTrigger(ring, Y1, 5000, 5100, 0, true), -1, 'no data');
});

test('analysis reports min, max and a frequency estimate', () => {
  const ring = createProbeRing(1), out = {};
  ring.write(block(0, 4800, ['y1', 'y2'], (f, c) => c === 'y1' ? .8 * Math.sin(2 * Math.PI * 440 * f / 48000) : .25));
  analyse(ring, Y1, 0, 4800, 48000, out);
  assert.ok(Math.abs(out.min + .8) < 1e-3 && Math.abs(out.max - .8) < 1e-3);
  assert.ok(Math.abs(out.frequency - 440) < 2, String(out.frequency));
  analyse(ring, Y2, 0, 4800, 48000, out);
  assert.equal(out.min, .25); assert.ok(Number.isNaN(out.frequency), 'DC has no frequency');
  analyse(ring, X, 0, 4800, 48000, out);
  assert.equal(out.valid, 0); assert.ok(Number.isNaN(out.min));
});

test('YT trace maps value/scale/offset to pixels, breaks at gaps and uses min/max columns when dense', () => {
  assert.equal(valueToY(0, 1, 0, 80), 40); assert.equal(valueToY(1, .5, 0, 80), 20); assert.equal(valueToY(0, 1, 1, 80), 30);
  const ring = createProbeRing(1);
  ring.write(block(0, 10, ['y1'], f => f < 5 ? 0 : 1));
  ring.write(block(12, 8, ['y1'], () => -1));
  const sparse = recorder();
  assert.equal(traceYT(ring, Y1, 0, 20, 200, 80, 1, 0, sparse), 18);
  assert.deepEqual(sparse.calls[0], ['m', 0, 40]);
  assert.deepEqual(sparse.calls.filter(c => c[0] === 'm').map(c => c[1]), [0, 120], 'gap at frames 10-11 lifts the pen');
  ring.write(block(0, 20000, ['y1'], f => f % 2 ? 1 : -1));
  const dense = recorder();
  assert.equal(traceYT(ring, Y1, 0, 20000, 100, 80, 1, 0, dense), 20000);
  assert.equal(dense.calls.length, 200);
  assert.ok(dense.calls.every(([, , y]) => y === 30 || y === 50));
});

test('XY trace plots Y against X and skips frames missing either channel', () => {
  assert.equal(valueToX(0, 1, 0, 100), 50); assert.equal(valueToX(1, .5, 0, 100), 70);
  const ring = createProbeRing(1);
  ring.write(block(0, 360, ['x', 'y1'], (f, c) => c === 'x' ? Math.cos(f * Math.PI / 180) : Math.sin(f * Math.PI / 180)));
  ring.write(block(100, 10, ['x'], f => Math.cos(f * Math.PI / 180)));
  const path = recorder();
  assert.equal(traceXY(ring, X, Y1, 0, 360, 100, 80, .25, 0, .25, 0, path), 350);
  assert.equal(path.calls.filter(c => c[0] === 'm').length, 2);
  for (const [, x, y] of path.calls) {
    const radius = Math.hypot((x - 50) / 10, (y - 40) / 10); // 10 px per division
    assert.ok(Math.abs(radius - 4) < 1e-3, `circle radius ${radius}`);
  }
});

test('scale and value formatting helpers', () => {
  assert.equal(nearestScale(.3), .5); assert.equal(nearestScale(1), 1); assert.equal(nearestScale(1e9), 10000);
  assert.equal(formatValue(0), '0'); assert.equal(formatValue(.5), '0.5'); assert.equal(formatValue(440), '440');
  assert.equal(formatValue(12345), '12.3k'); assert.equal(formatValue(NaN), '—');
});
