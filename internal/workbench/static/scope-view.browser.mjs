// Real-browser oscilloscope view checks using an external Playwright installation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const files = new Map(await Promise.all(['scope-view.js', 'scope-view.css', 'rack-view.css'].map(async name => [name, await readFile(new URL(name, import.meta.url))])));
const fixture = `<!doctype html><html><head><link rel="stylesheet" href="/rack-view.css"><link rel="stylesheet" href="/scope-view.css"></head>
<body style="margin:0;background:#11171b">
<div class="rack-view"><div id="small" style="width:420px"><div id="host"></div></div></div>
<div id="large" style="width:900px"></div></body></html>`;

async function setup(t, scale = 1) {
  const server = createServer((req, res) => {
    const name = req.url.slice(1), file = files.get(name);
    if (file) { res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(file); }
    else { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: scale });
  const errors = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const { createScopeView } = await import('/scope-view.js');
    window.pos = { frame: 9000, sampleRate: 48000, playing: true, live: true };
    window.changes = []; window.modes = [];
    window.host = document.getElementById('host');
    window.scope = createScopeView(host, { getPosition: () => pos, onStateChange: p => changes.push(p), onModeChange: m => modes.push(m) });
    // 400 Hz (120-frame period) so triggered traces repeat exactly.
    window.feed = (start, frames, channels = ['x', 'y1', 'y2'], fn = (f, c) => c === 'x' ? Math.cos(2 * Math.PI * f / 120) : c === 'y1' ? .8 * Math.sin(2 * Math.PI * f / 120) : .3) => {
      for (let p = start; p < start + frames; p += 2048) {
        const n = Math.min(2048, start + frames - p), data = new Float32Array(n * channels.length);
        for (let i = 0; i < n; i++) channels.forEach((c, k) => { data[i * channels.length + k] = fn(p + i, c); });
        scope.push({ position: p, frames: n, sampleRate: 48000, channels, unresolved: [], data });
      }
    };
    window.frames = (n = 3) => new Promise(resolve => { const w = host.ownerDocument.defaultView; let i = 0; const step = () => ++i >= n ? resolve() : w.requestAnimationFrame(step); w.requestAnimationFrame(step); });
    // Counts pixels by channel colour on the trace canvas, plus a content hash.
    window.pixels = () => {
      const canvas = host.querySelector('.scope-trace'), c = canvas.getContext('2d');
      const { data } = c.getImageData(0, 0, canvas.width, canvas.height);
      let yellow = 0, cyan = 0, white = 0, hash = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a > 100) { if (r > 200 && g > 170 && b < 140) yellow++; else if (r < 140 && g > 180 && b > 180) cyan++; else if (r > 200 && g > 200 && b > 200) white++; }
        hash = (hash * 31 + data[i + 3] + data[i]) | 0;
      }
      return { yellow, cyan, white, hash, width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight };
    };
    window.statusText = () => host.querySelector('.scope-status').hidden ? '' : host.querySelector('.scope-status').textContent;
  });
  t.after(() => assert.deepEqual(errors, []));
  return { page, context };
}

test('YT: graticule, HiDPI canvas, channel colours, readouts, trigger stability and freeze', async t => {
  const { page } = await setup(t, 2);
  await page.evaluate(() => frames());
  assert.match(await page.evaluate(() => statusText()), /No signal/);
  await page.evaluate(() => scope.setInputs({ mode: 'yt', inputs: { y1: { bus: 'left' }, y2: { node: 'lfo', port: 'out', direction: 'output' } }, labels: { y1: 'L [Stereo output]', y2: 'out lfo [LFO]' }, unresolved: [] }));
  await page.evaluate(() => frames());
  assert.match(await page.evaluate(() => statusText()), /Waiting for audio/);
  await page.evaluate(() => { pos.playing = false; return frames(); });
  assert.match(await page.evaluate(() => statusText()), /Press Play/);
  await page.evaluate(() => { pos.playing = true; });
  await page.evaluate(() => { feed(0, 12000); });
  await page.evaluate(() => frames());
  const first = await page.evaluate(() => pixels());
  assert.equal(await page.evaluate(() => statusText()), '');
  assert.equal(first.width, first.cssWidth * 2, 'device pixel canvas'); assert.ok(first.cssWidth >= 400 && first.cssWidth <= 420);
  assert.ok(first.yellow > 200, JSON.stringify(first)); assert.ok(first.cyan > 100, JSON.stringify(first));
  assert.equal(first.white, 0, 'unpatched X is not drawn');
  const grid = await page.evaluate(() => { const c = host.querySelector('.scope-grid'); const d = c.getContext('2d').getImageData(Math.round(c.width / 2), 5, 1, 1).data; return [...d]; });
  assert.ok(grid[1] > 40, `centre graticule line ${grid}`);
  const rows = await page.evaluate(() => [...host.querySelectorAll('.scope-channel')].filter(r => !r.hidden).map(r => [r.dataset.channel, r.querySelector('.scope-label').textContent]));
  assert.deepEqual(rows, [['y1', 'L [Stereo output]'], ['y2', 'out lfo [LFO]']]);
  await page.waitForTimeout(250); await page.evaluate(() => { pos.frame += 1; return frames(); });
  const readout = await page.evaluate(() => host.querySelector('[data-channel=y1] .scope-readout').textContent);
  assert.match(readout, /-0\.8 … 0\.8 · 400 Hz/);
  // Auto trigger on Y1: a later audible frame gives the identical trace.
  const a = await page.evaluate(async () => { pos.frame = 9000; await frames(); return pixels().hash; });
  const b = await page.evaluate(async () => { pos.frame = 9037; await frames(); return pixels().hash; });
  assert.equal(a, b);
  assert.match(await page.evaluate(() => host.querySelector('.scope-hud').textContent), /Y1 ↗ 0 · Trig'd/);
  await page.selectOption('#host .scope-trigger-mode', 'free');
  const c = await page.evaluate(async () => { pos.frame = 9000; await frames(); return pixels().hash; });
  const d = await page.evaluate(async () => { pos.frame = 9037; await frames(); return pixels().hash; });
  assert.notEqual(c, d, 'free run follows the audible frame');
  assert.deepEqual(await page.evaluate(() => changes.at(-1)), { triggerMode: 'free' });
  // Paused: the trace stays frozen even while no frames are drawn.
  const frozen = await page.evaluate(async () => { pos.playing = false; await frames(); const h = pixels().hash; await new Promise(r => setTimeout(r, 150)); return [h, pixels().hash]; });
  assert.equal(frozen[0], frozen[1]); assert.notEqual(frozen[0], 0);
  // Control changes persist and redraw.
  await page.selectOption('#host [data-channel=y1] .scope-scale', '2');
  assert.deepEqual(await page.evaluate(() => changes.at(-1).scales.y1), 2);
  await page.selectOption('#host .scope-timebase', '0.5');
  assert.deepEqual(await page.evaluate(() => changes.at(-1)), { timebase: .5 });
  assert.equal(await page.evaluate(() => scope.view.timebase), .5);
});

test('states: live synth only, unresolved probes, reset and setView', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => { scope.setInputs({ mode: 'yt', inputs: { y1: { bus: 'left' }, y3: { node: 'gone', port: 'out', direction: 'output' } }, labels: { y1: 'L', y3: 'out gone' }, unresolved: ['y3'] }); feed(0, 12000); return frames(); });
  assert.equal(await page.evaluate(() => host.querySelector('[data-channel=y3]').classList.contains('is-unresolved')), true);
  assert.match(await page.evaluate(() => host.querySelector('[data-channel=y3] .scope-label').textContent), /unresolved/);
  await page.evaluate(() => { pos.live = false; return frames(); });
  assert.match(await page.evaluate(() => statusText()), /Live synth only/);
  assert.equal((await page.evaluate(() => pixels())).yellow, 0);
  await page.evaluate(() => { pos.live = true; return frames(); });
  assert.ok((await page.evaluate(() => pixels())).yellow > 100);
  await page.evaluate(() => { scope.reset(); return frames(); });
  assert.match(await page.evaluate(() => statusText()), /No signal/);
  await page.evaluate(() => { scope.setView({ timebase: 5, triggerMode: 'normal', scales: { y1: .2 }, offsets: { y1: 1 }, persistence: 'long' }); });
  assert.equal(await page.evaluate(() => host.querySelector('.scope-timebase').value), '5');
  assert.equal(await page.evaluate(() => host.querySelector('[data-channel=y1] .scope-offset').value), '1');
  assert.equal(await page.evaluate(() => changes.length), 0, 'setView does not echo onStateChange');
});

test('XY mode plots Y against X with persistence; mode button asks the coordinator', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => { scope.setInputs({ mode: 'yt', inputs: { x: { bus: 'left' }, y1: { bus: 'right' } }, labels: {}, unresolved: [] }); feed(0, 12000); });
  await page.click('#host .scope-seg [data-mode=xy]');
  assert.deepEqual(await page.evaluate(() => modes), ['xy']);
  await page.evaluate(() => { scope.setInputs({ mode: 'xy', inputs: { x: { bus: 'left' }, y1: { bus: 'right' } }, labels: {}, unresolved: [] }); scope.setView({ scales: { x: .5, y1: .5 } }); return frames(); });
  const ring = await page.evaluate(() => {
    const c = host.querySelector('.scope-trace'), g = c.getContext('2d');
    const at = (dx, dy) => g.getImageData(Math.round(c.width / 2 + dx * c.width / 10), Math.round(c.height / 2 - dy * c.height / 8), 1, 1).data[3];
    // x = cos (2 div at 0.5/div), y = 0.8 sin (1.6 div).
    return { centre: at(0, 0), right: Math.max(at(2, 0), at(1.98, 0)), top: Math.max(at(0, 1.6), at(0, 1.58)) };
  });
  assert.equal(ring.centre, 0); assert.ok(ring.right > 0 && ring.top > 0, JSON.stringify(ring));
  assert.equal(await page.evaluate(() => host.querySelector('.scope-persist').hidden), false);
  assert.equal(await page.evaluate(() => host.querySelector('.scope-trigger').hidden), true);
  await page.evaluate(() => { scope.setInputs({ mode: 'xy', inputs: { y1: { bus: 'right' } }, labels: {}, unresolved: [] }); return frames(); });
  assert.match(await page.evaluate(() => statusText()), /No X signal/);
});

test('survives re-parenting, larger containers and adoption into a popup window', async t => {
  const { page, context } = await setup(t);
  await page.evaluate(() => { scope.setInputs({ mode: 'yt', inputs: { y1: { bus: 'left' } }, labels: {}, unresolved: [] }); feed(0, 12000); return frames(); });
  const small = await page.evaluate(() => pixels());
  await page.evaluate(() => { document.getElementById('large').append(host); return frames(4); });
  const large = await page.evaluate(() => pixels());
  assert.ok(large.cssWidth > 850 && large.width === large.cssWidth && large.yellow > small.yellow, JSON.stringify({ small, large }));
  // Detached then reinserted (as the rack does on render) keeps drawing.
  await page.evaluate(() => { host.remove(); document.getElementById('small').append(host); return frames(4); });
  assert.ok((await page.evaluate(() => pixels())).cssWidth <= 420);
  const popupPromise = context.waitForEvent('page');
  await page.evaluate(() => { window.child = window.open('about:blank', 'scope', 'width=700,height=700'); });
  const popup = await popupPromise;
  await page.evaluate(async () => {
    for (const link of document.querySelectorAll('link')) child.document.head.append(child.document.importNode(link));
    child.document.body.style.margin = '0';
    child.document.body.append(child.document.adoptNode(host));
    await new Promise(r => setTimeout(r, 200));
    scope.refresh();
    pos.frame = 10000; await frames(4);
  });
  const inPopup = await page.evaluate(() => ({ ...pixels(), owner: host.ownerDocument === child.document }));
  assert.ok(inPopup.owner && inPopup.yellow > 100 && inPopup.cssWidth > 600, JSON.stringify(inPopup));
  // Data pushed while adopted draws through the popup's animation frames.
  await page.evaluate(async () => { scope.reset(); feed(0, 12000, ['y1'], () => -.5); pos.frame = 9500; await frames(3); });
  const flat = await page.evaluate(() => {
    const c = host.querySelector('.scope-trace'), g = c.getContext('2d');
    return g.getImageData(Math.round(c.width / 2), Math.round(c.height / 2 + c.height / 8), 1, 1).data[3];
  });
  assert.ok(flat > 0, 'flat -0.5 trace at one division below centre');
  await page.evaluate(() => { document.getElementById('small').append(document.adoptNode(host)); child.close(); });
  await popup.waitForEvent('close');
  await page.evaluate(async () => { scope.refresh(); scope.reset(); feed(0, 12000); pos.frame = 9100; await frames(4); });
  assert.ok((await page.evaluate(() => pixels())).yellow > 100);
  await page.evaluate(() => scope.destroy());
  assert.equal(await page.evaluate(() => host.children.length), 0);
});
