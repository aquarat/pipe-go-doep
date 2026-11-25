// Build the WASM bridge first. Uses source transport modules and dist WASM only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../../../', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('examples/lantern-duel.json', root), 'utf8'));
fixture.beats = 16; fixture.tail_seconds = 0;
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; base-uri 'none'";

async function setup(t, options = {}) {
  const requests = [];
  const project = options.project || fixture;
  let loads = 0;
  const server = createServer(async (req, res) => {
    requests.push(req.url); res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><button id="play">Play</button><script type="module" src="/harness.js"></script>');
      } else if (req.url === '/harness.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`import { createLiveTransport } from '/static/live-client.js';
          window.errors = []; window.states = []; window.times = []; window.wire = [];
          window.project = ${JSON.stringify(project)};
          window.queueReports = [];
          const NativeWorkletNode = window.AudioWorkletNode;
          window.AudioWorkletNode = class extends NativeWorkletNode {
            constructor(...args) { super(...args); this.port.addEventListener('message', e => {
              if (e.data.type === 'progress') queueReports.push(e.data);
            }); }
          };
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            postMessage(message, transfer) { wire.push({ action: message.action, epoch: message.epoch, json: message.json }); super.postMessage(message, transfer); }
          };
          const NativeContext = window.AudioContext;
          window.resumes = [];
          window.AudioContext = class extends NativeContext {
            constructor(options) { super({ ...options, sampleRate: 48000 }); window.audioContext = this; }
            resume() { resumes.push(navigator.userActivation.isActive); return super.resume(); }
          };
          window.live = createLiveTransport({onState: s => states.push(s), onTime: s => times.push(s), onError: s => errors.push(s)});
          live.setProject(project);
          document.querySelector('#play').onclick = () => { window.played = live.play(); };
          window.addEventListener('unhandledrejection', e => errors.push('UNHANDLED: ' + e.reason));`);
      } else if (/^\/static\/[a-zA-Z0-9._-]+$/.test(req.url)) {
        const name = req.url.slice(8);
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        if (name === 'live-worker.js' && ++loads === 1 && options.firstWorker) { res.end(options.firstWorker); return; }
        let content = await readFile(new URL(name.startsWith('live-') ? `internal/workbench/static/${name}` : `dist/static/${name}`, root));
        if (name === 'live-worker.js' && options.delayResult) content = content.toString() + `
          const send = self.postMessage.bind(self);
          self.postMessage = (data, transfer) => data.type === 'result'
            ? setTimeout(() => send(data, transfer), ${options.delayResult}) : send(data, transfer);`;
        if (name === 'live-client.js' && options.fastTimeout) content = content.toString()
          .replace('START_TIMEOUT = 30_000', 'START_TIMEOUT = 300').replace('REQUEST_TIMEOUT = 90_000', 'REQUEST_TIMEOUT = 300');
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
  return { page, requests, loads: () => loads };
}

test('real Go worker streams before track render, gesture unlocks, resamples and pauses at consumed position', async t => {
  const { page, requests } = await setup(t);
  await page.evaluate(() => { live.pause(); live.stop(); live.setLoop({ enabled: false }); });
  await page.click('#play');
  const initial = await page.evaluate(() => Promise.race([played,
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true, state: live.state, errors, wire: wire.slice(-10) }), 10000))]));
  assert.equal(initial, true, JSON.stringify(await page.evaluate(() => ({ errors, state: live.state, wire: wire.slice(-10) }))));
  const first = await page.evaluate(() => ({ state: live.state, wire, resumes, rate: audioContext.sampleRate }));
  assert.ok(first.wire.some(x => x.action === 'read'));
  const framesRead = first.wire.filter(x => x.action === 'read').reduce((n, x) => n + JSON.parse(x.json).frames, 0);
  assert.ok(framesRead < fixture.sample_rate * .3, `initial prime read ${framesRead} frames`);
  assert.ok(first.state.duration > 5); assert.equal(first.state.playing, true);
  assert.deepEqual(first.resumes, [true]); assert.equal(first.rate, 48000);
  await page.waitForFunction(() => live.state.position > .2);
  const paused = await page.evaluate(() => { live.pause(); return live.state.position; });
  await page.waitForTimeout(180);
  assert.ok(Math.abs(await page.evaluate(() => live.state.position) - paused) <= 1 / fixture.sample_rate);
  assert.equal(await page.evaluate(() => live.state.playing), false);
  assert.deepEqual(await page.evaluate(() => errors), []);
  assert.equal(requests.includes('/static/synth-worker.js'), false);
  await page.evaluate(() => live.destroy());
});

test('seek before open, play/pause races, latest scrub grain and resume, short loop, stop', async t => {
  const { page } = await setup(t);
  assert.equal(await page.evaluate(() => live.seek(1)), true);
  assert.equal(await page.evaluate(() => live.state.position), 1);
  await page.click('#play'); await page.evaluate(() => played);
  await page.evaluate(async () => {
    const seeks = [live.seek(4), live.seek(.4), live.seek(2)];
    await Promise.all(seeks); live.pause();
    await live.seek(1.5);
  });
  assert.equal(await page.evaluate(() => live.state.position), 1.5);
  assert.equal(await page.evaluate(() => live.state.playing), false);
  const scrub = await page.evaluate(async () => {
    const results = await Promise.all([live.scrub(3), live.scrub(.5), live.scrub(2.5)]);
    return { results, state: live.state };
  });
  assert.deepEqual(scrub.results, [false, false, true]); assert.equal(scrub.state.playing, false);
  await page.waitForFunction(() => !live.state.buffering && live.state.position === 2.5);
  await page.waitForTimeout(160);
  assert.equal(await page.evaluate(() => live.state.position), 2.5);
  assert.equal(await page.evaluate(() => live.endScrub(2, true)), true);
  await page.waitForFunction(() => live.state.position > 2.15);
  await page.evaluate(() => live.setLoop({ enabled: true, start: .1, end: .25 }));
  await page.waitForTimeout(400);
  const looped = await page.evaluate(() => live.state);
  assert.equal(looped.playing, true); assert.ok(looped.position >= .1 && looped.position <= .25);
  await page.evaluate(() => live.stop()); await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => live.state.position), 0);
  assert.deepEqual(await page.evaluate(() => errors), []);
  await page.evaluate(() => live.destroy());
});

test('invalid update pauses, latest valid project recovers, all racing operations settle', async t => {
  const { page } = await setup(t);
  await page.click('#play'); await page.evaluate(() => played);
  await page.evaluate(() => live.setProject({ ...project, sample_rate: 123 }));
  await page.waitForFunction(() => errors.length > 0);
  assert.equal(await page.evaluate(() => live.state.playing), false);
  await page.evaluate(() => {
    live.setProject({ ...project, beats: 3 });
    live.setProject({ ...project, beats: 5 });
    live.setProject({ ...project, beats: 8 });
  });
  assert.equal(await page.evaluate(() => live.play(.3)), true);
  assert.equal(await page.evaluate(() => live.state.duration), 3);
  const result = await page.evaluate(async () => {
    const a = live.seek(2), b = live.scrub(1), c = live.play(.2);
    live.pause();
    const outcomes = await Promise.all([a, b, c]);
    const final = live.seek(.7); live.destroy();
    return { outcomes, destroyed: await final, state: live.state, errors };
  });
  assert.deepEqual(result.outcomes, [false, false, false]); assert.equal(result.destroyed, false);
  assert.equal(result.state.ready, false); assert.equal(result.state.playing, false);
  assert.equal(result.errors.filter(x => x.startsWith('UNHANDLED')).length, 0);
});

test('parameter previews preserve streaming history, coalesce and do not seek; identical loops do not flush', async t => {
  const { page } = await setup(t);
  await page.click('#play'); assert.equal(await page.evaluate(() => played), true);
  await page.waitForFunction(() => live.state.position > .1);
  const before = await page.evaluate(() => ({ seeks: wire.filter(x => x.action === 'seek').length, position: live.state.position }));
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) {
      live.setLoop({ enabled: false, start: 0, end: 1 });
      live.setProject({ ...project, output: { ...project.output, gain: .2 + i / 100 } });
    }
  });
  await page.waitForFunction(() => wire.some(x => x.action === 'update'));
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({ seeks: wire.filter(x => x.action === 'seek').length,
    updates: wire.filter(x => x.action === 'update'), state: live.state, errors }));
  assert.equal(after.seeks, before.seeks); assert.equal(after.state.playing, true);
  assert.ok(after.state.position > before.position && after.state.position - before.position < .6);
  assert.equal(JSON.parse(after.updates.at(-1).json).output.gain, .39);
  assert.ok(after.updates.length <= 2); assert.deepEqual(after.errors, []);
  await page.evaluate(() => live.destroy());
});

test('in-flight old worker replies cannot move a newer seek or survive pause/destroy', async t => {
  const { page } = await setup(t, { delayResult: 40 });
  await page.click('#play'); assert.equal(await page.evaluate(() => played), true);
  await page.evaluate(() => { window.firstSeek = live.seek(4); });
  await page.waitForFunction(() => wire.some(x => x.action === 'seek' && JSON.parse(x.json).frame === 4 * project.sample_rate));
  await page.evaluate(() => { live.pause(); window.finalSeek = live.seek(.6); window.cut = times.length; });
  assert.equal(await page.evaluate(() => firstSeek), false);
  assert.equal(await page.evaluate(() => finalSeek), true);
  await page.waitForTimeout(150);
  const result = await page.evaluate(() => ({ state: live.state, times: times.slice(cut), errors }));
  assert.equal(result.state.position, .6); assert.equal(result.state.playing, false);
  assert.ok(result.times.every(x => Math.abs(x - .6) < 1 / fixture.sample_rate));
  assert.deepEqual(result.errors, []);
  await page.evaluate(() => { window.pendingSeek = live.seek(3); });
  await page.waitForFunction(() => wire.some(x => x.action === 'seek' && JSON.parse(x.json).frame === 3 * project.sample_rate));
  await page.evaluate(() => live.destroy());
  assert.equal(await page.evaluate(() => pendingSeek), false);
});

for (const name of ['lantern-duel', 'neon-dojo']) {
  test(`${name} bundled patch sustains real-time refill and bounded queue across checkpoints`, async t => {
    const project = JSON.parse(await readFile(new URL(`examples/${name}.json`, root), 'utf8'));
    const { page } = await setup(t, { project });
    await page.click('#play'); assert.equal(await page.evaluate(() => played), true);
    await page.waitForFunction(() => live.state.position >= 2.2, null, { timeout: 20000 });
    const result = await page.evaluate(() => {
      live.pause();
      return { state: live.state, maxQueue: Math.max(...queueReports.map(x => x.queued)),
        reads: wire.filter(x => x.action === 'read').length, errors };
    });
    t.diagnostic(`${project.nodes.length} modules, ${result.state.position.toFixed(3)}s consumed, ${result.reads} blocks, ${result.state.underruns} underruns, max observed queue ${(result.maxQueue / project.sample_rate * 1000).toFixed(1)}ms`);
    assert.ok(result.reads > 20); assert.ok(result.maxQueue <= project.sample_rate * .12 + 1);
    assert.equal(result.state.underruns, 0); assert.deepEqual(result.errors, []);
    assert.equal(await page.evaluate(() => live.seek(1.2)), true);
    assert.ok(Math.abs(await page.evaluate(() => live.state.position) - 1.2) < 1 / project.sample_rate);
    await page.evaluate(() => live.destroy());
  });
}

for (const [name, firstWorker] of [
  ['startup hang', '/* intentionally no ready */'],
  ['operation hang', "postMessage({type:'ready'}); onmessage = () => { while(true) {} };"],
  ['fatal', "postMessage({type:'ready'}); onmessage = () => postMessage({type:'fatal',error:'test fatal'});"],
]) {
  test(`${name} settles and allows fresh worker retry`, async t => {
    const { page, loads } = await setup(t, { firstWorker, fastTimeout: true });
    await page.click('#play'); assert.equal(await page.evaluate(() => played), false);
    assert.equal(await page.evaluate(() => live.state.playing), false);
    assert.equal(await page.evaluate(() => live.play()), true, JSON.stringify(await page.evaluate(() => errors)));
    assert.equal(loads(), 2);
    assert.equal(await page.evaluate(() => errors.filter(x => x.startsWith('UNHANDLED')).length), 0);
    await page.evaluate(() => live.destroy());
  });
}
