// Optional real-window tests using an external existing Playwright installation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const files = new Map(await Promise.all(['pane-windows.js', 'pane-windows.css', 'score-view.js', 'score-view.css', 'rack-view.css', 'workbench.css'].map(async name => [name, await readFile(new URL(name, import.meta.url))])));
const fixture = `<!doctype html><html lang="en"><head>
  <link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/score-view.css">
  <link rel="stylesheet" href="/rack-view.css"><link rel="stylesheet" href="/pane-windows.css"><link rel="stylesheet" href="/late.css">
  </head><body><main class="workspace">
  <details class="pane" data-pane="score" open><summary><h2>Score</h2></summary><div id="score"></div></details>
  <details class="pane" data-pane="rack" open><summary><h2>Rack</h2></summary>
    <div id="rack" class="rack-view"><button id="edit">Edit</button><input id="value" value="original"><div class="late-marker"></div>
    <div class="rack-viewport"><div class="rack-spacer" style="height:2400px">Full rack</div></div></div></details>
  <details class="pane" data-pane="monitor"><summary><h2>Monitor</h2></summary><audio id="audio" src="/tone.wav" controls></audio></details>
  </main></body></html>`;

function wav() {
  const buffer = Buffer.alloc(44 + 8000 * 30 * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}

async function setup(t) {
  let styleRequests = 0;
  const server = createServer((req, res) => {
    const name = req.url.slice(1), file = files.get(name);
    if (file) { res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(file); }
    else if (name === 'late.css') {
      res.setHeader('Content-Type', 'text/css'); res.setHeader('Cache-Control', 'no-store');
      setTimeout(() => res.end('.pane-window .late-marker { height: 73px; }'), styleRequests++ ? 100 : 0);
    }
    else if (name === 'tone.wav') { res.setHeader('Content-Type', 'audio/wav'); res.end(wav()); }
    else { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const errors = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const { createPaneWindows } = await import('/pane-windows.js');
    const { createScoreView } = await import('/score-view.js');
    window.nodes = Object.fromEntries(['score', 'rack', 'edit', 'value', 'audio'].map(id => [id, document.getElementById(id)]));
    window.changes = []; window.layouts = []; window.measurements = []; window.errors = []; window.edits = 0; window.reveals = [];
    nodes.edit.addEventListener('click', () => window.edits++);
    window.score = createScoreView(nodes.score, { onReveal: path => reveals.push(path) });
    score.setProject({ bpm: 120, beats: 8, tracks: [{ id: 'lead', patterns: { p: [{ note: 'C4', beats: 1 }] }, order: ['p', 'p'] }] });
    window.panes = createPaneWindows({ panes: document.querySelectorAll('main > details'),
      onLayout: name => { layouts.push(name); if (name === 'score') score.refreshLayout(); if (name === 'rack') measurements.push(nodes.rack.querySelector('.late-marker').clientHeight); },
      onChange: (name, detached) => changes.push([name, detached]), onError: message => errors.push(message),
    });
  });
  t.after(() => assert.deepEqual(errors, []));
  return { page, context };
}

async function pop(page, name, keyboard = false) {
  const pending = page.waitForEvent('popup');
  const control = page.locator(`[data-pane="${name}"] > summary button`);
  if (keyboard) { await control.focus(); await control.press('Enter'); } else await control.click();
  const child = await pending;
  await child.locator('.pane-window-content').waitFor();
  return child;
}

test('actual nodes retain edits, native summary toggles, full rack height, and keyboard pop-in', async t => {
  const { page } = await setup(t);
  await page.locator('[data-pane="rack"] > summary h2').click();
  assert.equal(await page.locator('[data-pane="rack"]').evaluate(node => node.open), false);
  const child = await pop(page, 'rack', true);
  assert.equal(await page.locator('[data-pane="rack"]').evaluate(node => node.open), false);
  assert.equal(await page.locator('#rack').count(), 0);
  assert.equal(await child.evaluate(() => document.querySelector('#rack') === opener.nodes.rack), true);
  await child.locator('#value').fill('edited in child'); await child.locator('#edit').click();
  assert.equal(await page.evaluate(() => edits), 1);
  assert.equal(await child.locator('.rack-viewport').evaluate(node => node.clientHeight), 2400);
  assert.equal(await child.locator('.pane-window-main').evaluate(node => node.scrollHeight > node.clientHeight), true);
  await page.waitForFunction(() => measurements.includes(73));
  await child.getByRole('button', { name: 'Pop in Rack' }).press('Space');
  await page.waitForFunction(() => nodes.rack.ownerDocument === document);
  assert.equal(await page.locator('#value').inputValue(), 'edited in child');
  assert.equal(await page.locator('[data-pane="rack"]').evaluate(node => node.open), false);
  assert.deepEqual(await page.evaluate(() => changes), [['rack', true], ['rack', false]]);
  assert.deepEqual(await page.evaluate(() => errors), []);
});

test('independent children return on close, placeholder/main pop-in, dockAll and destroy', async t => {
  const { page, context } = await setup(t);
  const rack = await pop(page, 'rack'); const score = await pop(page, 'score');
  await rack.close({ runBeforeUnload: true });
  await page.waitForFunction(() => nodes.rack.ownerDocument === document);
  assert.equal(await score.locator('#score').count(), 1);
  await page.locator('[data-pane="score"] .pane-window-placeholder button').click();
  await page.waitForFunction(() => nodes.score.ownerDocument === document);
  await pop(page, 'rack');
  await page.locator('[data-pane="rack"] > summary button').click();
  await page.waitForFunction(() => nodes.rack.ownerDocument === document);
  await pop(page, 'rack'); await pop(page, 'score');
  await page.evaluate(() => panes.dockAll());
  await page.waitForFunction(() => document.querySelectorAll('.pane-is-detached').length === 0);
  await pop(page, 'score'); await page.evaluate(() => panes.destroy());
  assert.equal(await page.locator('.pane-window-button').count(), 0);
  assert.equal(await page.locator('.pane-window-placeholder').count(), 0);
  assert.equal(await page.evaluate(() => panes.popOut('rack')), false);
  assert.equal(context.pages().length, 1);
});

test('blocked popup preserves content, state, event handlers and summary state', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => { window.open = () => null; });
  await page.locator('[data-pane="rack"] > summary button').click();
  await page.locator('#edit').click();
  assert.equal(await page.evaluate(() => nodes.rack.ownerDocument === document && edits === 1), true);
  assert.equal(await page.locator('[data-pane="rack"]').evaluate(node => node.open), true);
  assert.deepEqual(await page.evaluate(() => changes), []);
  assert.match(await page.evaluate(() => errors[0]), /Pop-up blocked/);
});

test('score uses child rAF, DPR, resize and controls, then rebinds to the parent', async t => {
  const { page } = await setup(t);
  const child = await pop(page, 'score');
  await child.evaluate(() => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    window.frameRequests = 0;
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { frameRequests++; return request(callback); };
    opener.panes.refresh();
  });
  await child.setViewportSize({ width: 750, height: 650 });
  await child.waitForFunction(() => {
    const canvas = document.querySelector('.sv-ruler');
    return frameRequests > 0 && canvas.width === Math.ceil(parseFloat(canvas.style.width) * 2);
  });
  await child.getByTitle('Reveal this pattern in the JSON tree').click();
  assert.deepEqual(await page.evaluate(() => reveals), ['/tracks/0/patterns/p']);
  await child.evaluate(() => {
    // A hidden/throttled original window must not own the adopted score's frame.
    const request = opener.requestAnimationFrame;
    opener.requestAnimationFrame = () => { throw new Error('Score scheduled on its original window'); };
    opener.score.setTime(.5); opener.score.refreshLayout();
    opener.requestAnimationFrame = request;
  });
  assert.match(await child.locator('.sv-position').textContent(), /0:00.5/);
  await child.getByRole('button', { name: 'Pop in Score', exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.sv-ruler');
    return canvas && canvas.width === Math.ceil(parseFloat(canvas.style.width) * devicePixelRatio);
  });
  assert.deepEqual(await page.evaluate(() => errors), []);
});

test('audio identity and active playback survive adoption; parent close docks and closes children', async t => {
  const { page } = await setup(t);
  await page.evaluate(async () => { nodes.audio.currentTime = 3; nodes.audio.volume = .25; await nodes.audio.play(); });
  const child = await pop(page, 'monitor');
  await child.waitForFunction(() => { const audio = document.querySelector('audio'); return !audio.paused && audio.currentTime >= 3; });
  assert.equal(await child.evaluate(() => document.querySelector('audio') === opener.nodes.audio), true);
  assert.equal(await child.locator('audio').evaluate(node => node.volume), .25);
  await child.getByRole('button', { name: 'Pop in Monitor' }).click();
  await page.waitForFunction(() => nodes.audio.ownerDocument === document && !nodes.audio.paused && nodes.audio.currentTime >= 3);
  const rack = await pop(page, 'rack'); const score = await pop(page, 'score');
  const closed = Promise.all([rack.waitForEvent('close'), score.waitForEvent('close')]);
  await page.close({ runBeforeUnload: true });
  await closed;
});
