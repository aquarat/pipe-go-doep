// Probe plumbing through the real live-client.js and live-worker.js, with a fake
// JS bridge in place of synth.wasm so it runs without a WASM build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; base-uri 'none'";
const RATE = 48000;

// Stands in for wasm_exec.js: Go.run installs a pipeGoDoepStream following the
// bridge contract (open/update/seek/read/probe). Probe values encode the frame.
const fakeRuntime = `
self.Go = class { constructor() { this.importObject = {}; } run() { install(); return new Promise(() => {}); } };
let last = null;
function install() {
  const total = ${RATE} * 10;
  let position = 0, probes = [];
  self.pipeGoDoepStream = (action, json) => {
    const payload = JSON.parse(json);
    if (action === 'open' || action === 'update') return { status: 200, sampleRate: ${RATE}, frames: total, unresolved: [] };
    if (action === 'seek') { position = payload.frame; return { status: 200, position }; }
    if (action === 'probe') {
      const list = payload.probes;
      if (!Array.isArray(list) || list.length > 5 || list.some(p => p.node === 'reject')) return { status: 400, error: 'invalid probes' };
      probes = list.map(p => p.channel);
      return { status: 200, channels: probes, unresolved: list.filter(p => p.node === 'missing').map(p => p.channel) };
    }
    if (action === 'read') {
      const frames = Math.max(0, Math.min(payload.frames, total - position));
      const result = { status: 200, position, frames, body: new Float32Array(frames * 2),
        previousProbeDetached: last ? last.byteLength === 0 : null };
      if (probes.length) {
        const probe = new Float32Array(frames * probes.length);
        for (let i = 0; i < frames; i++) for (let c = 0; c < probes.length; c++) probe[i * probes.length + c] = (c % 2 ? -1 : 1) * (position + i);
        Object.assign(result, { channels: probes, probe, unresolved: [] });
        last = probe;
      }
      position += frames;
      return result;
    }
    return { status: 400, error: 'unknown action' };
  };
}`;
const emptyWasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

async function setup(t, options = {}) {
  let loads = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', csp); res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><button id="play">Play</button><script type="module" src="/harness.js"></script>');
      } else if (req.url === '/harness.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`import { createLiveTransport } from '/static/live-client.js';
          window.errors = []; window.wire = []; window.probes = []; window.replies = [];
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            constructor(...args) { super(...args); this.addEventListener('message', e => { if (e.data.type === 'result') replies.push({ action: e.data.channels ? 'probe-data' : '', detached: e.data.previousProbeDetached }); }); }
            postMessage(message, transfer) { if (message.type === 'request') wire.push({ action: message.action, json: message.json }); super.postMessage(message, transfer); }
          };
          window.live = createLiveTransport({ onError: e => errors.push(e),
            onProbe: block => probes.push({ position: block.position, frames: block.frames, sampleRate: block.sampleRate,
              channels: block.channels, unresolved: block.unresolved, length: block.data.length,
              typed: block.data instanceof Float32Array, first: block.data[0], second: block.data[1] }) });
          live.setProject({ version: 1, sample_rate: ${RATE}, bpm: 120, beats: 20, nodes: [] });
          document.querySelector('#play').onclick = () => { window.played = live.play(); };
          window.addEventListener('unhandledrejection', e => errors.push('UNHANDLED: ' + e.reason));`);
      } else if (req.url === '/static/wasm_exec.js') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(fakeRuntime);
      } else if (req.url === '/static/synth.wasm') {
        res.setHeader('Content-Type', 'application/wasm'); res.end(emptyWasm);
      } else if (/^\/static\/live-(client|worker|worklet)\.js$/.test(req.url)) {
        const name = req.url.slice(8);
        res.setHeader('Content-Type', 'text/javascript');
        if (name === 'live-worker.js' && ++loads === 1 && options.firstWorker) { res.end(options.firstWorker); return; }
        let content = await readFile(new URL(name, import.meta.url), 'utf8');
        if (name === 'live-worker.js' && options.delayResult) content += `
          const send = self.postMessage.bind(self);
          self.postMessage = (data, transfer) => data.type === 'result'
            ? setTimeout(() => send(data, transfer), ${options.delayResult}) : send(data, transfer);`;
        res.end(content);
      } else res.writeHead(404).end();
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => !!window.live);
  t.after(() => assert.deepEqual(pageErrors, []));
  return { page, loads: () => loads };
}
const actions = page => page.evaluate(() => wire.map(x => x.action));

test('probes set before open are sent after open; blocks reach onProbe with frame-indexed, transferred data', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => live.setProbes([{ channel: 'y1', node: 'lead', port: 'out', direction: 'output' }, { channel: 'x', bus: 'left' }]));
  assert.deepEqual(await actions(page), [], 'nothing is sent before the engine opens');
  await page.click('#play'); assert.equal(await page.evaluate(() => played), true);
  const sequence = await actions(page);
  assert.deepEqual(sequence.slice(0, 3), ['open', 'probe', 'seek']);
  assert.deepEqual(JSON.parse((await page.evaluate(() => wire[1].json))).probes.map(p => p.channel), ['y1', 'x']);
  await page.waitForFunction(() => probes.length > 3);
  const blocks = await page.evaluate(() => probes);
  let expected = 0;
  for (const block of blocks) {
    assert.equal(block.position, expected); expected += block.frames;
    assert.deepEqual(block.channels, ['y1', 'x']); assert.deepEqual(block.unresolved, []);
    assert.equal(block.sampleRate, RATE); assert.equal(block.typed, true);
    assert.equal(block.length, block.frames * 2);
    assert.equal(block.first, block.position); assert.equal(block.second, -block.position);
  }
  await page.waitForFunction(() => replies.filter(r => r.detached !== null && r.detached !== undefined).length > 1);
  assert.ok(await page.evaluate(() => replies.filter(r => r.detached !== null && r.detached !== undefined).every(r => r.detached)),
    'the worker transfers (detaches) each probe buffer');
  assert.deepEqual(await page.evaluate(() => errors), []);
  await page.evaluate(() => live.destroy());
});

test('latest probe list wins while playing; clearing stops probe blocks', async t => {
  const { page } = await setup(t);
  await page.click('#play'); assert.equal(await page.evaluate(() => played), true);
  assert.ok(!(await actions(page)).includes('probe'), 'an empty list is never sent to a fresh engine');
  await page.evaluate(() => {
    window.cut = wire.length;
    live.setProbes([{ channel: 'y1', bus: 'left' }]);
    live.setProbes([{ channel: 'y2', bus: 'right' }]);
    live.setProbes([{ channel: 'y3', bus: 'left' }, { channel: 'y4', bus: 'right' }]);
    live.setProbes([{ channel: 'y3', bus: 'left' }, { channel: 'y4', bus: 'right' }]);
  });
  await page.waitForFunction(() => probes.some(p => p.channels.join() === 'y3,y4'));
  const sent = await page.evaluate(() => wire.slice(cut).filter(x => x.action === 'probe').map(x => JSON.parse(x.json).probes.map(p => p.channel).join()));
  assert.equal(sent.at(-1), 'y3,y4'); assert.ok(sent.length <= 2, sent.join(' | '));
  assert.equal(await page.evaluate(() => live.state.playing), true);
  await page.evaluate(() => live.setProbes([]));
  await page.waitForFunction(() => wire.some(x => x.action === 'probe' && JSON.parse(x.json).probes.length === 0));
  const count = await page.evaluate(() => probes.length);
  await page.waitForTimeout(250);
  assert.ok(await page.evaluate(() => probes.length) <= count + 1, 'no probe blocks after clearing');
  assert.deepEqual(await page.evaluate(() => errors), []);
  await page.evaluate(() => live.destroy());
});

test('a rejected probe list reports an error without stopping playback; a valid list recovers', async t => {
  const { page } = await setup(t);
  await page.click('#play'); assert.equal(await page.evaluate(() => played), true);
  const before = await page.evaluate(() => live.state.position);
  await page.evaluate(() => live.setProbes([{ channel: 'y1', node: 'reject', port: 'out', direction: 'output' }]));
  await page.waitForFunction(() => errors.length > 0);
  assert.match(await page.evaluate(() => errors[0]), /Oscilloscope probes: invalid probes/);
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => live.state);
  assert.equal(state.playing, true); assert.ok(state.position > before);
  await page.evaluate(() => live.setProbes([{ channel: 'y2', bus: 'left' }]));
  await page.waitForFunction(() => probes.some(p => p.channels.join() === 'y2'));
  assert.equal(await page.evaluate(() => errors.length), 1);
  await page.evaluate(() => live.destroy());
});

test('probes are resent to a restarted worker', async t => {
  const { page, loads } = await setup(t, { firstWorker: "postMessage({type:'ready'}); onmessage = () => postMessage({type:'fatal',error:'test fatal'});" });
  await page.evaluate(() => live.setProbes([{ channel: 'y1', bus: 'left' }]));
  await page.click('#play'); assert.equal(await page.evaluate(() => played), false);
  assert.equal(await page.evaluate(() => live.play()), true);
  assert.equal(loads(), 2);
  const sequence = await actions(page);
  const reopened = sequence.lastIndexOf('open');
  assert.ok(reopened > 0); assert.equal(sequence[reopened + 1], 'probe');
  await page.waitForFunction(() => probes.length > 0);
  assert.deepEqual(await page.evaluate(() => probes[0].channels), ['y1']);
  await page.evaluate(() => live.destroy());
});

test('probe blocks from a superseded epoch never reach onProbe', async t => {
  const { page } = await setup(t, { delayResult: 40 });
  await page.evaluate(() => live.setProbes([{ channel: 'y1', bus: 'left' }]));
  await page.click('#play'); assert.equal(await page.evaluate(() => played), true);
  await page.waitForFunction(() => wire.at(-1).action === 'read');
  const seekFrame = 5 * RATE;
  await page.evaluate(() => { window.cut = probes.length; window.sought = live.seek(5); });
  assert.equal(await page.evaluate(() => sought), true);
  await page.waitForFunction(cut => probes.length > cut, await page.evaluate(() => cut));
  const after = await page.evaluate(() => probes.slice(cut).map(p => p.position));
  assert.ok(after.length > 0 && after.every(p => p >= seekFrame), after.join());
  await page.evaluate(() => live.destroy());
});
