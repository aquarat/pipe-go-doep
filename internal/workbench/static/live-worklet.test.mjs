import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./live-worklet.js', import.meta.url), 'utf8');
function processor(rate = 48000, sourceRate = rate) {
  let Processor;
  class Base {
    constructor() { this.messages = []; this.port = { postMessage: message => this.messages.push(message) }; }
  }
  vm.runInNewContext(source, { AudioWorkletProcessor: Base, Float32Array, sampleRate: rate,
    registerProcessor: (name, klass) => { assert.equal(name, 'pipe-go-doep-live'); Processor = klass; } });
  const p = new Processor();
  p.message({ type: 'reset', epoch: 1, sampleRate: sourceRate, position: 0, active: true });
  return p;
}
function block(p, frames, position = 0, value = .5, extra = {}) {
  const pcm = Float32Array.from({ length: frames * 2 }, (_, i) => typeof value === 'function' ? value(Math.floor(i / 2), i % 2) : value);
  p.message({ type: 'block', epoch: p.epoch, position, body: pcm, ...extra });
}
function render(p, frames = 128) {
  const out = [new Float32Array(frames), new Float32Array(frames)];
  p.process([], [out]); return out;
}

test('linear resampling preserves stereo and phase across transferred block boundaries', () => {
  for (const [sourceRate, contextRate] of [[8000, 48000], [24000, 48000], [48000, 44100], [44100, 48000], [96000, 48000]]) {
    const p = processor(contextRate, sourceRate);
    block(p, 300, 0, (i, channel) => (channel ? -1 : 1) * i / 2000);
    block(p, 700, 300, (i, channel) => (channel ? -1 : 1) * (i + 300) / 2000);
    p.fade = p.tail = 0;
    const out = render(p, 400), ratio = sourceRate / contextRate;
    for (let i = 0; i < 400; i++) {
      assert.ok(Math.abs(out[0][i] - i * ratio / 2000) < 1e-7, `${sourceRate}/${contextRate}, frame ${i}`);
      assert.equal(out[1][i], -out[0][i]);
    }
    assert.ok(Math.abs(p.consumed - 400 * ratio) < 1e-8);
    assert.ok(Math.abs(p.position - 400 * ratio) < 1e-8);
  }
});

test('queue is bounded, old epochs cannot append or reset new audio', () => {
  const p = processor();
  block(p, 4800); block(p, 1000, 4800);
  assert.equal(p.frames, 4800);
  assert.ok(p.messages.some(x => x.type === 'overflow'));
  p.message({ type: 'reset', epoch: 3, sampleRate: 48000, position: 72000, active: true });
  p.message({ type: 'block', epoch: 1, position: 0, body: new Float32Array(100) });
  p.message({ type: 'reset', epoch: 2, active: true });
  assert.equal(p.epoch, 3); assert.equal(p.frames, 0); assert.equal(p.position, 72000);
});

test('underflow fades to silence once, never replays exhausted PCM, and refill fades in', () => {
  const p = processor(); block(p, 512); render(p, 512);
  const tail = render(p, 512)[0];
  assert.ok(tail[0] > .4); assert.equal(tail[300], 0);
  assert.equal(p.messages.filter(x => x.underrun).length, 1);
  assert.ok(render(p, 512)[0].every(x => x === 0));
  assert.equal(p.messages.filter(x => x.underrun).length, 1);
  block(p, 512, 512);
  const refill = render(p, 512)[0]; assert.equal(refill[0], 0); assert.equal(refill[300], .5);
  assert.equal(p.consumed, 1024);
});

test('pause flush retains only a five millisecond tail; grain EOF drains and ends once', () => {
  const p = processor(); block(p, 2048); render(p, 512);
  p.message({ type: 'reset', epoch: 2, active: false, sampleRate: 48000, position: 100 });
  const tail = render(p, 512)[0]; assert.equal(tail[0], .5); assert.equal(tail[240], 0);
  assert.equal(p.frames, 0); assert.equal(p.position, 100);
  p.message({ type: 'reset', epoch: 3, active: true, sampleRate: 48000, position: 100 });
  block(p, 3840, 100, .5, { fadeOut: true });
  p.message({ type: 'eof', epoch: 3 });
  const grain = render(p, 4096)[0];
  assert.equal(grain[0], 0); assert.equal(grain[500], .5);
  assert.ok(grain[3839] < .003); assert.equal(grain[3840], 0);
  assert.equal(p.position, 3940); assert.equal(p.consumed, 3840);
  assert.equal(p.messages.filter(x => x.ended).length, 1);
  render(p, 128); assert.equal(p.messages.filter(x => x.ended).length, 1);
});

test('loop seam follows block positions and fades discontinuous boundaries', () => {
  const p = processor();
  block(p, 480, 2000, .5, { fadeOut: true }); block(p, 480, 1000, -.5);
  const out = render(p, 700)[0];
  assert.ok(out[479] < .003); assert.ok(out[480] === 0);
  assert.ok(Math.abs(out[481]) < .003);
  assert.equal(p.position, 1220); assert.equal(p.consumed, 700);
});
