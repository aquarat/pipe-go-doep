// Optional browser integration checks; PLAYWRIGHT_MODULE points to an existing install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const model = Buffer.from(await readFile(new URL('./rack-model.js', import.meta.url), 'utf8')).toString('base64');
const js = (await readFile(new URL('./rack-view.js', import.meta.url), 'utf8')).replace("'./rack-model.js'", `'data:text/javascript;base64,${model}'`);
const css = await readFile(new URL('./rack-view.css', import.meta.url), 'utf8');
const fixture = name => readFile(new URL(`../../../examples/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);

async function setup(t, project, width = 1200) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<style>body{margin:0;background:#10171b} main{width:100%;min-width:0}</style><main></main>');
  await page.addStyleTag({ content: css });
  await page.evaluate(async ({ source, project }) => {
    const { createRackView } = await import(`data:text/javascript;base64,${source}`);
    window.changes = []; window.reveals = []; window.edits = []; window.parameterReveals = []; window.reconnects = []; window.gestureErrors = [];
    window.accept = false; window.rebuild = false; window.capturedAtCommit = false;
    window.previews = []; window.cancels = []; window.parameterEvents = []; window.capturedAtCancel = false;
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    window.project = freeze(project);
    window.rack = createRackView(document.querySelector('main'), {
      onStateChange: x => window.changes.push(x), onReveal: x => window.reveals.push(x),
      onRevealParameter: x => window.parameterReveals.push(x), onError: x => window.gestureErrors.push(x),
      onPreviewParameter: x => { window.previews.push(x); window.parameterEvents.push('preview'); },
      onCancelParameter: x => {
        window.cancels.push(x); window.parameterEvents.push('cancel');
        window.capturedAtCancel ||= [...document.querySelectorAll('.rack-param')].some(el => el.hasPointerCapture(1));
      },
      onEditParameter: async x => {
        window.parameterEvents.push('commit');
        window.edits.push(x); window.capturedAtCommit ||= [...document.querySelectorAll('.rack-param')].some(el => el.hasPointerCapture(1));
        if (window.rebuild) window.rack.setProject(window.project);
        return window.accept;
      },
      onReconnect: async x => { window.reconnects.push(x); if (window.rebuild) window.rack.setProject(window.project); return window.accept; },
    });
    window.rack.setProject(window.project);
    await new Promise(requestAnimationFrame);
  }, { source: Buffer.from(js).toString('base64'), project });
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

test('both real patches preserve every node, cable, named endpoint, and stereo route', async t => {
  for (const name of ['lantern-duel', 'neon-dojo']) {
    const project = await fixture(name), page = await setup(t, project);
    assert.equal(await page.locator('.rack-module').count(), project.nodes.length + 1);
    assert.equal(await page.locator('.rack-cable').count(), project.connections.length + 2);
    assert.equal(await page.locator('.rack-cable[style*="display: none"]').count(), 0);
    const geometry = await page.evaluate(() => {
      const root = document.querySelector('.rack-canvas').getBoundingClientRect();
      const p = window.project;
      const routes = [...p.connections, { from: p.output.left, to: '$output.left' }, { from: p.output.right, to: '$output.right' }];
      return [...document.querySelectorAll('.rack-cable-wire')].every((wire, index) => {
        const parts = wire.getAttribute('d').split(' ');
        return ['from', 'to'].every((side, end) => {
          const [id, port] = routes[index][side].split('.');
          const key = id === '$output' ? '$rack-output' : `node:${p.nodes.findIndex(n => n.id === id)}`;
          const jack = document.querySelector(`[data-node-key="${key}"] [data-direction="${end ? 'input' : 'output'}"][data-port="${port}"] .rack-jack-ring`).getBoundingClientRect();
          const x = Number(parts[end ? parts.length - 2 : 1]), y = Number(parts[end ? parts.length - 1 : 2]);
          return Math.abs(x - (jack.left + jack.width / 2 - root.left) / .8) < .1 && Math.abs(y - (jack.top + jack.height / 2 - root.top) / .8) < .1;
        });
      });
    });
    assert.equal(geometry, true);
    assert.equal(await page.locator('.rack-family-output .rack-param-value').textContent(), '0.72');
    assert.equal(await page.locator('[data-module-type="mixer"]').first().locator('.rack-param').count(), 4);
    assert.deepEqual(await page.locator('[data-module-type="mixer"]').first().locator('.rack-param-value').allTextContents(), ['1', '1', '1', '1']);
    assert.match(await page.locator('[data-module-type="mixer"]').first().textContent(), /Σ OUT/);
    if (process.env.RACK_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.RACK_SCREENSHOT_DIR}/${name}-rack.png`, fullPage: true });
  }
});

test('focus, keyboard reveal, zoom, hidden expansion, mobile containment and cleanup', async t => {
  const page = await setup(t, await fixture('neon-dojo'), 390);
  await page.getByLabel('Focus track', { exact: true }).selectOption('hat');
  assert.ok(await page.locator('.rack-module.is-dimmed').count() > 0);
  const sharedNoise = page.locator('.rack-module').filter({ has: page.locator('.rack-module-head strong', { hasText: /^drum_noise$/ }) });
  assert.equal(await sharedNoise.evaluate(el => el.classList.contains('is-dimmed')), false);
  await page.getByLabel('Focus track', { exact: true }).selectOption('');
  const first = page.locator('.rack-module-head').first(); await first.focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.reveals), ['/nodes/0']);
  assert.ok(await page.locator('.rack-cable.is-selected').count() > 0);
  await page.getByLabel('Rack zoom', { exact: true }).selectOption('1.2');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.ok(await page.evaluate(() => window.changes.some(c => c.zoom === 1.2)));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(async () => { const root = document.querySelector('main'); root.style.display = 'none'; window.rack.setProject(window.project, { zoom: .65, scrollTop: 150 }); await new Promise(requestAnimationFrame); root.style.display = ''; window.rack.refreshLayout(); await new Promise(requestAnimationFrame); });
  assert.equal(await page.locator('.rack-viewport').evaluate(el => el.scrollHeight <= el.clientHeight + 1), true);
  assert.ok(await page.locator('.rack-cable-wire').first().getAttribute('d'));
  await page.evaluate(() => window.rack.destroy());
  assert.equal(await page.locator('main > *').count(), 0);
});

const smallPatch = {
  sample_rate: 48000,
  nodes: [{ id: 'osc', type: 'sine' }, { id: 'other', type: 'pulse' }, { id: 'amp', type: 'vca' }, { id: 'mix', type: 'mixer' }, { id: 'noise', type: 'noise' }],
  connections: [{ from: 'osc.out', to: 'amp.in' }, { from: 'osc.out', to: 'mix.a' }],
  output: { left: 'amp.out', right: 'mix.out', gain: .7 },
};
async function drag(page, locator, dx, dy, { cancel = false, fine = false } = {}) {
  await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  if (fine) await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up(); if (fine) await page.keyboard.up('Shift');
}
test('dial previews, exact reveal, rejection, fine movement, integer toggles and rebuild-safe capture', async t => {
  const page = await setup(t, smallPatch);
  const freq = page.locator('[data-node-key="node:0"] [data-parameter="freq"]');
  await freq.click(); assert.deepEqual(await page.evaluate(() => window.parameterReveals), [{ nodeIndex: 0, name: 'freq', value: 440 }]);
  assert.deepEqual(await page.evaluate(() => window.reveals), []);
  const box = await freq.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 20, { steps: 4 });
  assert.notEqual(await freq.locator('.rack-param-value').textContent(), '440');
  assert.equal(await page.evaluate(() => window.edits.length), 0);
  assert.ok(await page.evaluate(() => window.previews.some(x => x.nodeIndex === 0 && x.name === 'freq' && x.value > 440)));
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await freq.locator('.rack-param-value').textContent(), '440');
  assert.deepEqual(await page.evaluate(() => window.cancels), [{ nodeIndex: 0, name: 'freq', value: 440 }]);
  assert.equal(await page.evaluate(() => window.capturedAtCancel), false);
  await drag(page, freq, 0, -40);
  const coarse = await page.evaluate(() => window.edits[0].value); assert.ok(coarse > 440 && coarse < 1000);
  assert.equal(await freq.locator('.rack-param-value').textContent(), '440');
  assert.deepEqual(await page.evaluate(() => window.cancels.at(-1)), { nodeIndex: 0, name: 'freq', value: 440 });
  await drag(page, freq, 0, -40, { fine: true });
  assert.ok(await page.evaluate(coarse => window.edits[1].value > 440 && window.edits[1].value < coarse, coarse));
  await drag(page, freq, 0, -40, { cancel: true }); assert.equal(await page.evaluate(() => window.edits.length), 2);
  const toggle = page.locator('[data-node-key="node:4"] [data-parameter="short"]');
  await toggle.focus(); await page.keyboard.press('ArrowUp'); assert.equal(await page.evaluate(() => window.edits.at(-1).value), 1);
  const gain = page.locator('.rack-family-output [data-parameter="gain"]');
  await gain.focus(); await page.keyboard.press('Shift+ArrowUp');
  assert.deepEqual(await page.evaluate(() => window.edits.at(-1)), { nodeIndex: null, name: 'gain', value: .701 });
  await page.evaluate(() => { window.rebuild = true; window.accept = true; });
  await drag(page, freq, 0, -20); assert.equal(await page.evaluate(() => window.capturedAtCommit), false);
  await freq.focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  assert.equal(await freq.evaluate(el => el.ownerDocument.activeElement === el), true);
});

test('selected fan-out cable endpoints, occupied drops, escape, stereo source and rejection', async t => {
  const page = await setup(t, smallPatch);
  const choose = async index => { await page.locator('.rack-cable-hit').nth(index).focus(); await page.keyboard.press('Enter'); };
  const moveEnd = async (end, target, cancel = false) => {
    const handle = page.locator(`.is-cable-selected .rack-cable-end[data-end="${end}"]`);
    await handle.scrollIntoViewIfNeeded(); const from = await handle.boundingBox(), to = await target.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    assert.ok(await page.locator('.is-drop-target').count() > 0);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    if (cancel) await page.keyboard.press('Escape'); await page.mouse.up();
  };
  const jack = (key, direction, port) => page.locator(`.rack-module[data-node-key="${key}"] .rack-jack[data-direction="${direction}"][data-port="${port}"]`);
  await choose(0); await moveEnd('from', jack('node:1', 'output', 'out'));
  assert.deepEqual(await page.evaluate(() => window.reconnects), [{ connectionIndex: 0, end: 'from', ref: 'other.out' }]);
  await moveEnd('to', jack('node:3', 'input', 'a'));
  assert.equal(await page.evaluate(() => window.reconnects.length), 1); assert.equal(await page.locator('.is-drop-target').count(), 0);
  await moveEnd('to', jack('node:3', 'input', 'b'), true); assert.equal(await page.evaluate(() => window.reconnects.length), 1);
  await moveEnd('to', jack('node:3', 'input', 'b'));
  assert.deepEqual(await page.evaluate(() => window.reconnects.at(-1)), { connectionIndex: 0, end: 'to', ref: 'mix.b' });
  // Selection raises the group, so locate the stereo cable by its accessible label.
  await page.getByRole('button', { name: 'Select cable: amp.out → output.left', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('.is-cable-selected .rack-cable-end').count(), 1);
  await page.evaluate(() => { window.rebuild = true; });
  await moveEnd('from', jack('node:1', 'output', 'out'));
  assert.deepEqual(await page.evaluate(() => window.reconnects.at(-1)), { outputChannel: 'left', end: 'from', ref: 'other.out' });
  assert.deepEqual(await page.evaluate(() => window.project.connections), smallPatch.connections);
});

test('pending previews are coalesced and cannot run after commit, pointercancel or teardown', async t => {
  for (const ending of ['commit', 'pointercancel', 'replace', 'destroy']) {
    const page = await setup(t, smallPatch);
    const freq = page.locator('[data-node-key="node:0"] [data-parameter="freq"]');
    const box = await freq.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    // Hold only subsequently scheduled frames to deterministically exercise the
    // move/finish race with an actual captured pointer and actual pointer moves.
    await page.evaluate(() => {
      window.accept = true; window.rebuild = true; window.heldFrames = [];
      window.nativeRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => {
        window.heldFrames.push(callback); return 100000 + window.heldFrames.length;
      };
    });
    await page.mouse.move(x, y - 30, { steps: 6 });
    assert.equal(await page.evaluate(() => window.heldFrames.length), 1);
    assert.deepEqual(await page.evaluate(() => window.previews), []);
    assert.deepEqual(await page.evaluate(() => window.edits), []);
    if (ending === 'commit') await page.mouse.up();
    else {
      await page.evaluate(ending => {
        if (ending === 'pointercancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
        if (ending === 'replace') window.rack.setProject(window.project);
        if (ending === 'destroy') window.rack.destroy();
      }, ending);
      await page.mouse.up();
    }
    await page.evaluate(async () => {
      window.requestAnimationFrame = window.nativeRAF;
      // Even an already-dispatched stale callback is harmless after finish.
      for (const callback of window.heldFrames) callback(performance.now());
      await new Promise(requestAnimationFrame);
    });
    assert.deepEqual(await page.evaluate(() => window.previews), []);
    assert.deepEqual(await page.evaluate(() => window.parameterEvents), [ending === 'commit' ? 'commit' : 'cancel']);
    assert.equal(await page.evaluate(() => window.capturedAtCommit || window.capturedAtCancel), false);
    if (ending !== 'commit') assert.deepEqual(await page.evaluate(() => window.cancels), [{ nodeIndex: 0, name: 'freq', value: 440 }]);
    if (ending !== 'destroy') assert.equal(await freq.locator('.rack-param-value').textContent(), '440');
  }
});

test('full-width fractional rack, full height, narrow zoom scroll and adopted popup controls', async t => {
  const page = await setup(t, smallPatch, 2400);
  assert.equal(await page.locator('.rack-module-grid').evaluate(grid => Math.abs(grid.lastElementChild.getBoundingClientRect().right - grid.getBoundingClientRect().right + 3.2) < 2), true);
  assert.equal(await page.locator('.rack-viewport').evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1), true);
  await page.setViewportSize({ width: 320, height: 700 }); await page.getByLabel('Rack zoom', { exact: true }).selectOption('1.5');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('.rack-viewport').evaluate(el => el.scrollWidth > el.clientWidth && el.scrollHeight <= el.clientHeight + 1), true);
  const popupPromise = page.waitForEvent('popup');
  await page.evaluate(() => {
    const child = window.open('about:blank'); child.document.head.innerHTML = document.head.innerHTML;
    child.document.body.append(document.querySelector('main')); window.rack.refreshLayout();
  });
  const popup = await popupPromise; await popup.waitForLoadState();
  const freq = popup.locator('[data-node-key="node:0"] [data-parameter="freq"]');
  await drag(popup, freq, 0, -30);
  assert.ok(await page.evaluate(() => window.edits.length === 1));
  assert.ok(await page.evaluate(() => window.previews.length > 0));
  assert.deepEqual(await page.evaluate(() => window.cancels.at(-1)), { nodeIndex: 0, name: 'freq', value: 440 });
  await freq.click(); assert.deepEqual(await page.evaluate(() => window.parameterReveals.at(-1)), { nodeIndex: 0, name: 'freq', value: 440 });
  // Hit-testing must use the adopted document too, not the parent's empty body.
  await popup.getByLabel('Rack zoom', { exact: true }).selectOption('0.5');
  const source = popup.getByRole('button', { name: 'Select cable: amp.out → output.left', exact: true });
  await source.focus(); await popup.keyboard.press('Enter');
  const handle = popup.locator('.is-cable-selected .rack-cable-end'); await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox(), to = await popup.locator('.rack-module[data-node-key="node:1"] .rack-jack[data-direction="output"]').boundingBox();
  await popup.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await popup.mouse.down();
  await popup.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 }); await popup.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.reconnects.at(-1)), { outputChannel: 'left', end: 'from', ref: 'other.out' });
  await page.evaluate(() => window.rack.destroy());
});

test('incomplete hostile drafts remain text-safe; explicit zero and patched defaults stay visible', async t => {
  const project = { nodes: [{ id: '<img src=x onerror=alert(1)>', type: 'pulse', params: { duty: 0 } }, { id: 'mix', type: 'mixer' }, null], connections: [{ from: 'missing.out', to: 'mix.a' }, null], output: {} };
  const page = await setup(t, project);
  assert.equal(await page.locator('img').count(), 0);
  assert.match(await page.locator('.rack-summary').textContent(), /2 unresolved routes/);
  assert.equal(await page.locator('.rack-family-oscillator .rack-param-value').nth(1).textContent(), '0');
  assert.match(await page.locator('.rack-family-oscillator [data-port="reset"]').textContent(), /DEF 0/);
  assert.match(await page.locator('.rack-family-mixer [data-port="a"]').textContent(), /PATCH 0/);
  await page.evaluate(() => window.rack.setProject({ nodes: [{ id: 'draft', type: '__proto__' }] }));
  assert.equal(await page.locator('[data-module-type="__proto__"]').count(), 1);
  await page.evaluate(() => { window.rack.setProject(null, null); window.rack.refreshLayout(); });
  assert.match(await page.locator('.rack-empty').textContent(), /No modules/);
});

test('materialized signal defaults stay compact and input jacks reveal exact parameter fields', async t => {
  const { materializeDefaults } = await import(`data:text/javascript;base64,${model}`);
  const project = structuredClone(smallPatch); materializeDefaults(project);
  const page = await setup(t, project);
  assert.equal(await page.locator('[data-module-type="mixer"] .rack-param').count(), 4);
  assert.equal(await page.locator('[data-module-type="sine"] .rack-param').count(), 1);
  const reset = page.locator('.rack-module[data-node-key="node:0"] .rack-jack[data-port="reset"]');
  await reset.click();
  assert.deepEqual(await page.evaluate(() => window.parameterReveals.at(-1)), { nodeIndex: 0, name: 'reset', value: 0 });
  const input = page.locator('.rack-module[data-node-key="node:2"] .rack-jack[data-port="in"]');
  await input.focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.parameterReveals.at(-1)), { nodeIndex: 2, name: 'in', value: 0 });
  assert.deepEqual(await page.evaluate(() => window.reveals), []);
  await page.locator('.rack-family-output .rack-jack[data-port="left"]').focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.reveals), ['/output/left']);
});
