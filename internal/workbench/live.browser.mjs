// Full-app live transport checks. Uses an existing optional Playwright install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const url = process.env.WORKBENCH_URL || 'http://127.0.0.1:8081';
const fixture = {
  version: 1, title: 'Live transport check', sample_rate: 8000, bpm: 120, beats: 24, tail_seconds: .2, seed: 17, tracks: [],
  nodes: [{ id: 'osc', type: 'sine', params: { freq: 440 } }, { id: 'echo', type: 'delay', params: { time: .05, feedback: .2, mix: .2 } }],
  connections: [{ from: 'osc.out', to: 'echo.in' }], output: { left: 'echo.out', right: 'echo.out', gain: .2 },
};

test('live audio, seeking, scrubbing, loops and popup controls integrate without rendering a WAV', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
    await context.addInitScript(() => {
      window.liveNodes = [];
      const Original = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends Original {
        constructor(...args) {
          super(...args);
          const analyser = args[0].createAnalyser(); analyser.fftSize = 2048; this.connect(analyser);
          window.liveNodes.push({ node: this, analyser, context: args[0] });
        }
      };
    });
    const page = await context.newPage(), errors = [];
    context.on('page', child => child.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/example?*', route => route.fulfill({ json: fixture }));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Live transport check');
    assert.equal(await page.locator('#transport-mode').inputValue(), 'live');
    await page.locator('#transport-play').click();
    await page.waitForFunction(() => Number(document.querySelector('#transport-seek').value) > .2);
    assert.equal(await page.locator('#audio').getAttribute('src'), null);
    await page.waitForFunction(() => {
      const analyser = window.liveNodes.at(-1)?.analyser;
      if (!analyser) return false;
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      return samples.some(x => Math.abs(x) > .01);
    });
    await page.locator('#render').click();
    await page.waitForFunction(() => document.querySelector('#render-state').textContent === 'Rendered · ready to play');
    assert.equal(await page.locator('#transport-mode').inputValue(), 'live');
    assert.equal(await page.locator('#transport-play').textContent(), 'Pause');
    await page.locator('#transport-play').click();
    assert.equal(await page.locator('#transport-play').textContent(), 'Play');
    // Seeking is available before any full-track export exists.
    await page.locator('#transport-seek').evaluate(input => {
      input.value = '4'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => Number(document.querySelector('#transport-seek').value) >= 3.99);
    await page.locator('#transport-play').click();
    await page.waitForFunction(() => Number(document.querySelector('#transport-seek').value) > 4.15);
    await page.locator('#transport-play').click();

    // A grain is heard while dragging; releasing while paused stays paused.
    const range = page.locator('#transport-seek'); await range.scrollIntoViewIfNeeded();
    const box = await range.boundingBox();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => Number(document.querySelector('#transport-seek').value) > 7);
    assert.equal(await page.locator('#transport-play').textContent(), 'Play');

    await page.locator('#transport-loop-start').fill('0'); await page.locator('#transport-loop-start').press('Tab');
    await page.locator('#transport-loop-end').fill('1'); await page.locator('#transport-loop-end').press('Tab');
    await page.locator('#transport-loop').check();
    await page.locator('#transport-stop').click(); await page.locator('#transport-play').click();
    await page.waitForFunction(() => Number(document.querySelector('#transport-seek').value) > .25);
    await page.waitForFunction(() => Number(document.querySelector('#transport-seek').value) < .15);
    await page.locator('#transport-loop').uncheck();

    // Preview updates audio without rewriting JSON until the gesture commits.
    const knob = page.locator('[data-node-key="node:0"] [data-parameter="freq"]');
    await knob.scrollIntoViewIfNeeded(); const dial = await knob.boundingBox();
    await page.mouse.move(dial.x + dial.width / 2, dial.y + dial.height / 2); await page.mouse.down();
    await page.mouse.move(dial.x + dial.width / 2, dial.y + dial.height / 2 - 30, { steps: 6 });
    assert.equal(JSON.parse(await page.locator('#editor').inputValue()).nodes[0].params.freq, 440);
    await page.mouse.up();
    assert.ok(JSON.parse(await page.locator('#editor').inputValue()).nodes[0].params.freq > 440);
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#monitor-pane > summary .pane-window-button').click();
    const popup = await popupPromise; await popup.waitForLoadState();
    await popup.waitForFunction(() => document.querySelector('#transport-play').textContent === 'Pause');
    await popup.locator('#transport-play').click();
    assert.equal(await page.evaluate(() => window.liveNodes.length), 1);
    await popup.getByRole('button', { name: 'Pop in Output monitor', exact: true }).click();
    await page.locator('#transport-stop').click();
    assert.equal(await page.locator('#transport-seek').inputValue(), '0');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('transport cancellation, source switching and WAV EOF looping remain controllable', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/example?*', route => route.fulfill({ json: { ...fixture, beats: 8, tail_seconds: 0 } }));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Live transport check');
    await page.locator('#transport-play').click();
    await page.waitForFunction(() => Number(document.querySelector('#transport-seek').value) > .05);
    await page.locator('#json-pane > summary').click(); await page.locator('#source-pane > summary').click();
    const source = await page.locator('#editor').inputValue();
    await page.locator('#editor').fill(source + ' ');
    // Pending source must never disable the ability to stop existing playback.
    assert.equal(await page.locator('#transport-play').textContent(), 'Pause');
    await page.locator('#transport-play').click();
    assert.equal(await page.locator('#transport-play').textContent(), 'Play');
    await page.locator('#revert-source').click();
    await page.locator('#transport-seek').evaluate(input => { input.value = '.2'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    const range = page.locator('#transport-seek'); await range.scrollIntoViewIfNeeded();
    const box = await range.boundingBox();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2, { steps: 4 });
    await page.locator('#editor').evaluate(input => { input.value += ' '; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.waitForFunction(() => Math.abs(Number(document.querySelector('#transport-seek').value) - .2) < .02);
    await page.locator('#revert-source').click();
    await page.locator('#render').click();
    await page.waitForFunction(() => document.querySelector('#audio').readyState >= 2);
    await page.locator('#transport-mode').selectOption('rendered');
    assert.ok(Math.abs(await page.locator('#audio').evaluate(audio => audio.currentTime) - .2) < .02);
    await page.locator('#transport-mode').selectOption('live');
    await page.locator('#audio').evaluate(audio => audio.dispatchEvent(new Event('play')));
    assert.equal(await page.locator('#transport-mode').inputValue(), 'live');

    await page.locator('#transport-mode').selectOption('rendered');
    await page.locator('#transport-loop-end').fill('8'); await page.locator('#transport-loop-end').press('Tab');
    await page.locator('#transport-loop').check();
    await page.locator('#audio').evaluate(audio => { audio.currentTime = audio.duration - .02; return audio.play(); });
    await page.waitForFunction(() => { const audio = document.querySelector('#audio'); return !audio.paused && audio.currentTime > .03 && audio.currentTime < .5; });
    await page.locator('#transport-stop').click(); await page.locator('#transport-loop').uncheck();
    await page.locator('#transport-mode').selectOption('live');
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#monitor-pane > summary .pane-window-button').click();
    const popup = await popupPromise; await popup.waitForLoadState();
    const popupRange = popup.locator('#transport-seek'); const popupBox = await popupRange.boundingBox();
    await popup.mouse.move(popupBox.x + popupBox.width * .2, popupBox.y + popupBox.height / 2); await popup.mouse.down();
    await popup.mouse.move(popupBox.x + popupBox.width * .6, popupBox.y + popupBox.height / 2, { steps: 4 });
    await popup.close();
    await page.locator('#transport-play').click();
    await page.waitForFunction(() => Number(document.querySelector('#transport-seek').value) > .1 && document.querySelector('#transport-play').textContent === 'Pause');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('oscilloscope probes a module jack through the real Go engine without changing the sound', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/example?*', route => route.fulfill({ json: fixture }));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Live transport check');
    const source = page.locator('#rack-view .rack-scope-jack[data-channel="y1"]');
    const target = page.locator('#rack-view .rack-jack[data-node-key="node:0"][data-direction="output"][data-port="out"]');
    await source.scrollIntoViewIfNeeded();
    const from = await source.locator('.rack-jack-ring').boundingBox(), to = await target.locator('.rack-jack-ring').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#editor').value)._ui.scope?.inputs?.y1?.node === 'osc');
    assert.deepEqual(JSON.parse(await page.locator('#editor').inputValue())._ui.scope.inputs.y1, { node: 'osc', port: 'out', direction: 'output' });
    // The probe cable is drawn and labelled along its path.
    await page.waitForFunction(() => [...document.querySelectorAll('#rack-view .rack-cable.is-probe textPath')].some(t => /osc/.test(t.textContent)));

    await page.locator('#transport-play').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#rack-view .scope-readout')].some(r => /4[34]\d(\.\d+)?\s*Hz/.test(r.textContent)), null, { timeout: 30000 });
    await page.locator('#transport-play').click();

    // Unplug from the keyboard on the selected probe cable.
    await page.locator('#rack-view .rack-cable.is-probe .rack-cable-hit').first().focus();
    await page.keyboard.press('Enter'); await page.keyboard.press('Delete');
    await page.waitForFunction(() => !JSON.parse(document.querySelector('#editor').value)._ui.scope?.inputs?.y1);
    assert.equal(await page.locator('#rack-view .rack-cable.is-probe:not(.is-ghost)').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
