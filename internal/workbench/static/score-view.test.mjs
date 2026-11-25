import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Expose private pure helpers only inside this test module. Production API stays
// exactly createScoreView; no DOM package or browser globals needed here.
const source = await readFile(new URL('./score-view.js', import.meta.url), 'utf8');
const { buildTimeline, playbackPosition, midiPitch } = await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport { buildTimeline, playbackPosition, midiPitch };`).toString('base64')}`);
const score = (track, fields = {}) => ({ bpm: 120, beats: 8, sample_rate: 48000, tracks: [track], ...fields });

test('repeated occurrences retain absolute beats and shared escaped source pointers', () => {
  const model = buildTimeline(score({ id: 'lead', transpose: 12, patterns: { 'a/~': [{ note: 'C4', beats: 1 }, { note: '.', beats: 1 }] }, order: ['a/~', 'a/~'] }));
  const track = model.tracks[0];
  assert.deepEqual(track.occurrences.map(item => [item.start, item.end]), [[0, 2], [2, 4]]);
  assert.deepEqual(track.steps.map(item => item.start), [0, 1, 2, 3]);
  assert.equal(track.steps[2].midi, 72);
  assert.equal(track.steps[2].pointer, '/tracks/0/patterns/a~1~0/0');
  assert.equal(track.steps[2].occurrence, 1);
  assert.equal(track.steps[0].velocity, 1);
  assert.equal(track.steps[0].gate, 0.85);
  assert.equal(track.steps[0].gateEnd, 0.85);
});

test('playback follows repeated occurrence and rest boundaries, never implicitly loops', () => {
  const model = buildTimeline(score({ patterns: { p: [{ note: 'A4', beats: 1 }, { note: '.', beats: 1 }] }, order: ['p', 'p'] }));
  const track = model.tracks[0];
  assert.equal(playbackPosition(model, track, 0).step.index, 0);
  assert.equal(playbackPosition(model, track, 0.5).step.rest, true);
  assert.equal(playbackPosition(model, track, 1).occurrence.index, 1);
  assert.equal(playbackPosition(model, track, 1).step.index, 0);
  assert.equal(playbackPosition(model, track, 2).step, null);
  assert.equal(playbackPosition(model, track, 3).occurrence, null);
});

test('musical end clips gates and clears active step at the boundary and during tail', () => {
  const model = buildTimeline(score({ patterns: { p: [{ note: 'C4', beats: 3, gate: 1 }] }, order: ['p', 'p'] }, { beats: 4, tail_seconds: 3 }));
  const track = model.tracks[0];
  assert.equal(track.steps[1].gateEnd, 4);
  assert.equal(model.extent, 6);
  assert.equal(playbackPosition(model, track, 1.9).occurrence.index, 1);
  assert.equal(playbackPosition(model, track, 2).step, null);
  assert.equal(playbackPosition(model, track, 3).step, null);
});

test('null defaults, zero velocity, zero gate and rounded-away notes match scheduling semantics', () => {
  const model = buildTimeline(score({ patterns: { p: [
    { note: 'A4', beats: 1, velocity: 0, gate: 1 },
    { note: 'A4', beats: 1, velocity: null, gate: null },
    { note: 'A4', beats: 1, gate: 0 },
    { note: 'A4', beats: 0.000001, gate: 0.01 },
    { note: '.', beats: 1 },
  ] }, order: ['p'] }));
  const steps = model.tracks[0].steps;
  assert.equal(steps[0].audible, true); // emitted gate even at velocity zero
  assert.equal(steps[0].velocity, 0);
  assert.equal(steps[1].velocity, 1);
  assert.equal(steps[1].gate, 0.85);
  assert.equal(steps[2].audible, false);
  assert.equal(steps[3].audible, false);
  assert.equal(steps[4].audible, false);
});

test('pitch parsing validates both written and transposed range with enharmonic spellings', () => {
  assert.equal(midiPitch('B#3'), 60);
  assert.equal(midiPitch('Cb4'), 59);
  assert.equal(midiPitch('bb2', 12), 58);
  assert.equal(midiPitch('C-1'), 0);
  for (const [note, transpose] of [['B-2', 12], ['G9', 1], ['C-1', -1], ['C♯4', 0], ['C##4', 0], ['.', 0], ['C4', 0.5]]) assert.equal(midiPitch(note, transpose), null);
});

test('fractional legato boundaries accumulate without sample-rounding drift', () => {
  const pattern = Array.from({ length: 1000 }, () => ({ note: 'C4', beats: 0.1, gate: 1 }));
  const model = buildTimeline(score({ patterns: { p: pattern }, order: ['p'] }, { beats: 100, bpm: 137 }));
  const steps = model.tracks[0].steps;
  assert.equal(model.tracks[0].end, 100);
  for (let i = 1; i < steps.length; i++) assert.equal(steps[i - 1].endSample, steps[i].startSample);
  assert.equal(steps.at(-1).endSample, Math.round(100 * 60 / 137 * 48000));
  const atThirdBoundary = playbackPosition(model, model.tracks[0], 0.3 * 60 / 137);
  assert.equal(atThirdBoundary.step.index, 3);
});

test('incomplete JSON shapes produce a safe empty or partial timeline without mutation', () => {
  for (const project of [null, [], {}, { tracks: 'oops' }, { tracks: [null, 3, { patterns: null, order: [null, '__proto__', 'missing'] }] }]) {
    const before = JSON.stringify(project);
    const model = buildTimeline(project);
    assert.ok(Number.isFinite(model.extent));
    assert.equal(JSON.stringify(project), before);
  }
});

test('expansion is bounded even when incomplete input exceeds parser limits', () => {
  const model = buildTimeline(score({ patterns: { p: Array.from({ length: 100 }, () => ({ note: 'C4', beats: 0.01 })) }, order: Array(10000).fill('p') }));
  assert.equal(model.truncated, true);
  assert.equal(model.tracks[0].steps.length, 262144);
});
