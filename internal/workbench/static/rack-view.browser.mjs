// Optional browser integration checks; PLAYWRIGHT_MODULE points to an existing install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const model = Buffer.from(await readFile(new URL('./rack-model.js', import.meta.url), 'utf8')).toString('base64');
const js = (await readFile(new URL('./rack-view.js', import.meta.url), 'utf8')).replace("'./rack-model.js'", `'data:text/javascript;base64,${model}'`);
const css = await readFile(new URL('./rack-view.css', import.meta.url), 'utf8');
const scopeJS = Buffer.from(await readFile(new URL('./scope-view.js', import.meta.url))).toString('base64');
const scopeCSS = await readFile(new URL('./scope-view.css', import.meta.url), 'utf8');
const fixture = name => readFile(new URL(`../../../examples/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);

async function setup(t, project, width = 1200, { scope = false, realScope = false } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<style>body{margin:0;background:#10171b} main{width:100%;min-width:0}</style><main></main>');
  await page.addStyleTag({ content: css });
  if (realScope) await page.addStyleTag({ content: scopeCSS });
  await page.evaluate(async ({ source, project, scope, realScope, scopeJS }) => {
    const { createRackView } = await import(`data:text/javascript;base64,${source}`);
    window.probes = []; window.screenElement = null; window.popOuts = []; window.popIns = [];
    if (scope) { window.screenElement = document.createElement('div'); window.screenElement.className = 'test-scope'; window.screenElement.append(document.createElement('canvas')); }
    if (realScope) {
      const { createScopeView } = await import(`data:text/javascript;base64,${scopeJS}`);
      window.scopeView = createScopeView(window.screenElement, { getPosition: () => ({ frame: 0, sampleRate: 48000, playing: false, live: true }) });
    }
    window.changes = []; window.reveals = []; window.edits = []; window.parameterReveals = []; window.reconnects = []; window.gestureErrors = [];
    window.accept = false; window.rebuild = false; window.capturedAtCommit = false;
    window.previews = []; window.cancels = []; window.parameterEvents = []; window.capturedAtCancel = false;
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    window.project = freeze(project);
    window.rack = createRackView(document.querySelector('main'), {
      ...(scope ? { scopeScreen: window.screenElement, onProbe: async x => { window.probes.push(x); if (window.rebuild) window.rack.setProject(window.project); return window.accept; } } : {}),
      onStateChange: x => window.changes.push(x), onReveal: x => window.reveals.push(x),
      onPopOutModule: id => { window.popOuts.push(id); window.openModule?.(id); },
      onPopInModule: id => { window.popIns.push(id); window.closeModule?.(id); },
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
  }, { source: Buffer.from(js).toString('base64'), project, scope, realScope, scopeJS });
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
  // Modules keep their HP width instead of stretching; the rails still span the pane.
  assert.equal(await page.locator('.rack-module-grid').evaluate(grid => Math.abs(grid.getBoundingClientRect().right - grid.closest('.rack-rows').getBoundingClientRect().right) < 2), true);
  assert.equal(await page.locator('.rack-module').evaluateAll(cards => cards.every(card => card.offsetWidth === Number(card.dataset.hp) * 15)), true);
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

// Every visible cable starts and ends inside a jack ring, at the current zoom.
const endpointsInRings = page => page.evaluate(() => {
  const canvas = document.querySelector('.rack-canvas'), origin = canvas.getBoundingClientRect(), scale = origin.width / canvas.offsetWidth;
  const rings = [...document.querySelectorAll('.rack-jack-ring')].map(ring => ring.getBoundingClientRect());
  const inside = (x, y) => rings.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  const wires = [...document.querySelectorAll('.rack-cable:not(.is-ghost)')].filter(g => g.style.display !== 'none').map(g => g.querySelector('.rack-cable-wire'));
  return wires.length > 0 && wires.every(wire => {
    const parts = wire.getAttribute('d').split(' ').map(Number);
    return inside(origin.left + parts[1] * scale, origin.top + parts[2] * scale) && inside(origin.left + parts.at(-2) * scale, origin.top + parts.at(-1) * scale);
  });
});
const labelReport = page => page.evaluate(() => [...document.querySelectorAll('.rack-cable:not(.is-ghost)')].filter(g => g.style.display !== 'none').map(group => {
  const label = group.querySelector('.rack-cable-label'), path = group.querySelector('.rack-cable-label-path'), text = label.textContent;
  const visible = label.dataset.fit !== 'hidden', last = text.length - 1;
  return {
    fit: label.dataset.fit, text, pointer: getComputedStyle(label).pointerEvents,
    room: path.getTotalLength() - 26, width: visible ? label.getComputedTextLength() : 0,
    upright: !visible || label.getStartPositionOfChar(0).x <= label.getEndPositionOfChar(last).x,
    offset: Number(label.querySelector('textPath').getAttribute('startOffset')),
  };
}));

test('compact HP modules are much denser and keep endpoints accurate after zoom', async t => {
  const page = await setup(t, await fixture('neon-dojo'));
  const widths = await page.locator('.rack-module').evaluateAll(cards => cards.map(card => ({ type: card.dataset.moduleType, hp: Number(card.dataset.hp), width: card.offsetWidth, height: card.offsetHeight })));
  // The previous fixed faceplates were at least 210 px wide and 350 px tall.
  for (const card of widths) {
    assert.equal(card.width, card.hp * 15);
    assert.ok(card.width < 210 && card.height < 350, JSON.stringify(card));
  }
  assert.ok(widths.filter(card => card.type === 'vca').every(card => card.width <= 105));
  assert.ok(widths.find(card => card.type === 'mixer').hp > widths.find(card => card.type === 'vca').hp);
  const rowsHeight = await page.locator('.rack-rows').evaluate(el => el.offsetHeight);
  assert.ok(rowsHeight < 5000, `rack height ${rowsHeight}`);
  assert.equal(await endpointsInRings(page), true);
  for (const zoom of ['1.5', '0.5']) {
    await page.getByLabel('Rack zoom', { exact: true }).selectOption(zoom);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await endpointsInRings(page), true, `zoom ${zoom}`);
  }
});

test('cable labels follow every cable upright, fitted, staggered and pointer-transparent', async t => {
  const project = await fixture('neon-dojo'), page = await setup(t, project);
  const labels = await labelReport(page);
  assert.equal(labels.length, project.connections.length + 2);
  assert.ok(labels.filter(l => l.fit === 'full').length > 20);
  for (const l of labels) {
    assert.equal(l.pointer, 'none');
    assert.ok(['full', 'short', 'hidden'].includes(l.fit));
    assert.ok(l.upright, l.text);
    if (l.fit !== 'hidden') assert.ok(l.width <= l.room + .5 && l.offset >= 12.9, JSON.stringify(l));
    if (l.fit === 'full') assert.match(l.text, /^\S+ \S+ \[[^\]]+\] → (\S+ \S+|[LR]) \[[^\]]+\]$/);
    if (l.fit === 'short') assert.match(l.text, /^\S+ \S+ → (\S+ \S+|[LR])$/);
  }
  // Right-to-left cables reverse the label path rather than drawing upside down.
  assert.ok(await page.locator('.rack-cable-label[data-reversed="true"]:not([data-fit="hidden"])').count() > 0);
  assert.ok(new Set(labels.filter(l => l.fit !== 'hidden').map(l => Math.round(l.offset / Math.max(1, l.room) * 10))).size > 2, 'labels are staggered');
  const small = await setup(t, smallPatch);
  const texts = await small.locator('.rack-cable-label').allTextContents();
  assert.ok(texts.includes('out osc [Sine oscillator] → in amp [Voltage amplifier]') || texts.includes('out osc → in amp'));
  assert.ok(texts.includes('out mix [Four-channel mixer] → R [Stereo output]') || texts.includes('out mix → R'));
  assert.ok((await labelReport(small)).every(l => l.upright));
  await small.locator('.rack-cable-hit').first().focus(); await small.keyboard.press('Enter');
  assert.equal(await small.locator('.rack-cable.is-cable-selected').evaluate(g => getComputedStyle(g).opacity), '1');
  assert.equal(await small.locator('.rack-cable.is-dimmed').first().evaluate(g => Number(getComputedStyle(g).opacity) < .1), true);
});

const scopePatch = {
  ...smallPatch,
  _ui: { scope: { mode: 'yt', inputs: { y1: { node: 'osc', port: 'out', direction: 'output' }, x: { bus: 'left' }, y3: { node: 'ghost', port: 'out', direction: 'output' } } } },
};
test('oscilloscope faceplate keeps its screen, draws probe cables and lists dangling probes', async t => {
  const plain = await setup(t, scopePatch);
  assert.equal(await plain.locator('.rack-family-scope, .rack-cable.is-probe').count(), 0);
  const page = await setup(t, scopePatch, 1200, { scope: true });
  const scope = page.locator('.rack-module').first();
  assert.equal(await scope.getAttribute('data-node-key'), '$rack-scope');
  assert.ok(await scope.evaluate(card => card.offsetWidth > 2 * document.querySelector('[data-module-type="vca"]').offsetWidth));
  assert.equal(await page.evaluate(() => document.querySelector('.rack-scope-screen > *') === window.screenElement), true);
  assert.deepEqual(await scope.locator('.rack-scope-jack').evaluateAll(jacks => jacks.map(j => j.dataset.channel)), ['x', 'y1', 'y2', 'y3', 'y4']);
  assert.match(await scope.locator('.rack-scope-jack[data-channel="x"]').textContent(), /XY mode/);
  const probes = page.locator('.rack-cable.is-probe:not(.is-ghost)');
  assert.equal(await probes.count(), 3);
  assert.equal(await page.locator('.rack-cable.is-probe:not(.is-ghost):not([style*="display: none"])').count(), 2);
  assert.notEqual(await probes.first().locator('.rack-cable-wire').evaluate(w => getComputedStyle(w).strokeDasharray), 'none');
  const y1 = page.locator('.rack-cable.is-probe[data-channel="y1"] .rack-cable-label');
  assert.ok(['out osc [Sine oscillator] → Y1 [Oscilloscope]', 'out osc → Y1'].includes(await y1.textContent()));
  assert.ok(['L [Stereo output] → X [Oscilloscope]', 'L → X'].includes(await page.locator('.rack-cable.is-probe[data-channel="x"] .rack-cable-label').textContent()));
  assert.equal(await endpointsInRings(page), true);
  const ends = await page.evaluate(() => {
    const canvas = document.querySelector('.rack-canvas'), o = canvas.getBoundingClientRect(), s = o.width / canvas.offsetWidth;
    const d = document.querySelector('.rack-cable.is-probe[data-channel="y1"] .rack-cable-wire').getAttribute('d').split(' ').map(Number);
    const at = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [(r.left + r.width / 2 - o.left) / s, (r.top + r.height / 2 - o.top) / s]; };
    return { d: [d[1], d[2], d.at(-2), d.at(-1)], from: at('[data-node-key="node:0"] [data-direction="output"] .rack-jack-ring'), to: at('.rack-scope-jack[data-channel="y1"] .rack-jack-ring') };
  });
  assert.ok(Math.hypot(ends.d[0] - ends.from[0], ends.d[1] - ends.from[1]) < .5 && Math.hypot(ends.d[2] - ends.to[0], ends.d[3] - ends.to[1]) < .5, JSON.stringify(ends));
  assert.match(await page.locator('.rack-summary').textContent(), /3\/5 scope probes · 1 unresolved probes/);
  assert.match(await page.locator('.rack-unresolved').textContent(), /ghost\.out/);
  assert.match(await page.locator('.rack-scope-jack[data-channel="y3"]').textContent(), /unresolved/);
  await page.locator('.rack-unresolved summary').click();
  await page.getByRole('button', { name: 'Unplug Y3', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.probes), [{ channel: 'y3', ref: null }]);
  await page.evaluate(() => window.rack.setProject({ ...window.project, _ui: { scope: { mode: 'xy', inputs: {} } } }));
  assert.doesNotMatch(await page.locator('.rack-scope-jack[data-channel="x"]').textContent(), /XY mode/);
  assert.equal(await page.evaluate(() => document.querySelector('.rack-scope-screen > *') === window.screenElement), true);
  assert.equal(await page.locator('.rack-cable.is-probe:not(.is-ghost)').count(), 0);
});

test('probe gestures patch, repatch, unplug and cancel through onProbe only', async t => {
  const page = await setup(t, scopePatch, 1200, { scope: true });
  const jack = (key, direction, port) => page.locator(`.rack-module[data-node-key="${key}"] .rack-jack[data-direction="${direction}"][data-port="${port}"]`);
  const pointerDrag = async (from, to, { cancel = false } = {}) => {
    await from.scrollIntoViewIfNeeded(); const a = await from.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    const b = typeof to.boundingBox === 'function' ? await to.boundingBox() : to;
    await page.mouse.move(b.x + (b.width || 0) / 2, b.y + (b.height || 0) / 2, { steps: 8 });
    if (!cancel) {
      assert.ok(await page.locator('.rack-jack.is-probe-target').count() > 10);
      assert.equal(await page.locator('.rack-scope-jack.is-drop-target').count(), 0);
    }
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  const y2 = page.locator('.rack-scope-jack[data-channel="y2"]'), y4 = page.locator('.rack-scope-jack[data-channel="y4"]');
  // A new probe shows a ghost cable from the pointer to the scope while dragging.
  await y2.scrollIntoViewIfNeeded(); const box = await y2.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 300, { steps: 5 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('.rack-cable.is-ghost').evaluate(g => g.style.display), '');
  await page.keyboard.press('Escape'); await page.mouse.up(); await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('.rack-cable.is-ghost').evaluate(g => g.style.display), 'none');
  await pointerDrag(y2, jack('node:2', 'input', 'gain'));
  await pointerDrag(y4, jack('$rack-output', 'input', 'right'));
  await pointerDrag(y4, jack('node:3', 'output', 'out'), { cancel: true });
  assert.deepEqual(await page.evaluate(() => window.probes), [
    { channel: 'y2', ref: { node: 'amp', port: 'gain', direction: 'input' } },
    { channel: 'y4', ref: { bus: 'right' } },
  ]);
  // Clicking a patched scope jack selects its probe; its module plug can be repatched.
  await page.locator('.rack-scope-jack[data-channel="y1"]').click();
  assert.equal(await page.locator('.rack-cable.is-cable-selected').getAttribute('data-channel'), 'y1');
  assert.equal(await page.locator('.is-cable-selected .rack-cable-end').count(), 1);
  await page.evaluate(() => { window.rebuild = true; });
  await pointerDrag(page.locator('.is-cable-selected .rack-cable-end'), jack('node:1', 'output', 'out'));
  assert.deepEqual(await page.evaluate(() => window.probes.at(-1)), { channel: 'y1', ref: { node: 'other', port: 'out', direction: 'output' } });
  // Dropping a selected probe plug on empty rack space unplugs it.
  await page.locator('.rack-scope-jack[data-channel="y1"]').click();
  await pointerDrag(page.locator('.is-cable-selected .rack-cable-end'), page.locator('.rack-row-title').first());
  assert.deepEqual(await page.evaluate(() => window.probes.at(-1)), { channel: 'y1', ref: null });
  // Same jack: no change. Unplugged scope jack dropped on empty space: no change.
  const count = await page.evaluate(() => window.probes.length);
  await page.locator('.rack-scope-jack[data-channel="y1"]').click();
  await pointerDrag(page.locator('.is-cable-selected .rack-cable-end'), jack('node:0', 'output', 'out'));
  await pointerDrag(y2, page.locator('.rack-row-title').first());
  assert.equal(await page.evaluate(() => window.probes.length), count);
  // Keyboard: select the bus probe cable, then Delete unplugs it.
  await page.getByRole('button', { name: 'Select probe: output.left → scope.x', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('.rack-details').textContent(), /L \[Stereo output\] → X \[Oscilloscope\]/);
  await page.keyboard.press('Delete');
  assert.deepEqual(await page.evaluate(() => window.probes.at(-1)), { channel: 'x', ref: null });
  await page.getByRole('button', { name: 'Select probe: output.left → scope.x', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Unplug X', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.probes.at(-1)), { channel: 'x', ref: null });
  assert.deepEqual(await page.evaluate(() => window.project._ui.scope.inputs.y1), { node: 'osc', port: 'out', direction: 'output' });
  assert.equal(await page.evaluate(() => window.reconnects.length), 0);
  // Patch cables still reconnect normally beside the scope.
  await page.getByRole('button', { name: 'Select cable: amp.out → output.left', exact: true }).focus(); await page.keyboard.press('Enter');
  const handle = await page.locator('.is-cable-selected .rack-cable-end').boundingBox(), other = await jack('node:1', 'output', 'out').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  assert.equal(await page.locator('.rack-scope-jack.is-drop-target, .rack-jack.is-probe-target').count(), 0);
  await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2, { steps: 6 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.reconnects), [{ outputChannel: 'left', end: 'from', ref: 'other.out' }]);
});

// Module windows: the test plays the coordinator, opening a same-origin popup per
// module (synchronously, inside the click) and passing a full-window host element.
async function withModuleWindows(page) {
  await page.evaluate(() => {
    window.moduleWindows = new Map();
    const publish = () => window.rack.setDetached(new Map([...window.moduleWindows].map(([id, w]) => [id, w.host])));
    window.openModule = id => {
      const existing = window.moduleWindows.get(id);
      if (existing) { existing.child.focus(); window.focused = (window.focused || 0) + 1; return; }
      const child = window.open('', `module-${id}`);
      // Copy the opener's stylesheets (popups opened with '' have none).
      for (const style of document.head.querySelectorAll('style, link[rel="stylesheet"]')) child.document.head.append(child.document.importNode(style, true));
      child.document.body.style.margin = '0';
      const host = child.document.createElement('div'); host.className = 'module-window-host'; host.style.cssText = 'width:100vw;height:100vh';
      child.document.body.append(host);
      window.moduleWindows.set(id, { child, host }); publish();
    };
    window.closeModule = id => { const entry = window.moduleWindows.get(id); window.moduleWindows.delete(id); publish(); entry?.child.close(); };
  });
}
async function popOut(page, selector) {
  const popupPromise = page.waitForEvent('popup');
  await page.locator(selector).click();
  const popup = await popupPromise; await popup.waitForLoadState();
  await popup.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  return popup;
}
const ringCentre = (page, selector) => page.evaluate(selector => {
  const canvas = document.querySelector('.rack-canvas'), o = canvas.getBoundingClientRect(), s = o.width / canvas.offsetWidth, r = document.querySelector(selector).getBoundingClientRect();
  return [(r.left + r.width / 2 - o.left) / s, (r.top + r.height / 2 - o.top) / s];
}, selector);

test('popped-out module: rack stub keeps cables, window faceplate edits, focus and pop in', async t => {
  const page = await setup(t, smallPatch);
  await withModuleWindows(page);
  // Every node module and nothing else has a pop-out control.
  assert.equal(await page.locator('.rack-module-pop').count(), smallPatch.nodes.length);
  assert.equal(await page.locator('.rack-family-output .rack-module-pop').count(), 0);
  const popup = await popOut(page, '.rack-module[data-node-key="node:0"] .rack-module-pop');
  assert.deepEqual(await page.evaluate(() => window.popOuts), ['osc']);
  const stub = page.locator('.rack-module-stub[data-node-key="node:0"]');
  assert.equal(await stub.count(), 1);
  assert.match(await stub.textContent(), /osc/); assert.match(await stub.textContent(), /sine/); assert.match(await stub.textContent(), /In window/);
  assert.equal(await stub.locator('.rack-param').count(), 0);
  assert.equal(await stub.locator('.rack-module-pop').count(), 0);
  assert.deepEqual(await stub.locator('.rack-jack').evaluateAll(j => j.map(x => `${x.dataset.direction}.${x.dataset.port}`)), ['input.freq', 'input.reset', 'output.out']);
  // Cables attach to the stub's jacks exactly.
  assert.equal(await endpointsInRings(page), true);
  const wire = (await page.locator('.rack-cable-wire').first().getAttribute('d')).split(' ').map(Number);
  const out = await ringCentre(page, '.rack-module-stub[data-node-key="node:0"] [data-direction="output"] .rack-jack-ring');
  assert.ok(Math.hypot(wire[1] - out[0], wire[2] - out[1]) < .5, JSON.stringify({ wire, out }));
  // The full faceplate lives in the window's document, with no cables there.
  if (process.env.RACK_SCREENSHOT_DIR) { await page.screenshot({ path: `${process.env.RACK_SCREENSHOT_DIR}/stub-rack.png` }); await popup.screenshot({ path: `${process.env.RACK_SCREENSHOT_DIR}/module-window.png` }); }
  const faceplate = popup.locator('.rack-module-window .rack-module.is-window[data-node-key="node:0"]');
  assert.equal(await faceplate.count(), 1);
  assert.equal(await popup.locator('.rack-cable').count(), 0);
  assert.equal(await faceplate.evaluate(el => el.ownerDocument === document && el.ownerDocument !== window.opener.document), true);
  // A dial drag in the window previews and commits through the rack callbacks.
  const freq = faceplate.locator('[data-parameter="freq"]');
  await drag(popup, freq, 0, -30);
  assert.equal(await page.evaluate(() => window.edits.length), 1);
  assert.deepEqual(await page.evaluate(() => [window.edits[0].nodeIndex, window.edits[0].name, window.edits[0].value > 440]), [0, 'freq', true]);
  assert.ok(await page.evaluate(() => window.previews.length > 0));
  assert.equal(await page.evaluate(() => window.capturedAtCommit), false);
  await freq.click(); assert.deepEqual(await page.evaluate(() => window.parameterReveals.at(-1)), { nodeIndex: 0, name: 'freq', value: 440 });
  await freq.focus(); await popup.keyboard.press('ArrowUp');
  assert.ok(await page.evaluate(() => window.edits.length === 2 && window.edits[1].value > 440));
  // An accepted commit that rebuilds keeps the faceplate (and focus) in the window.
  await page.evaluate(() => { window.accept = true; window.rebuild = true; });
  await freq.focus(); await popup.keyboard.press('ArrowUp');
  await popup.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await popup.evaluate(() => document.activeElement?.dataset.parameter), 'freq');
  await page.evaluate(() => { window.rebuild = false; });
  // Window jacks reveal; head selects; selection shows on stub and window, dimming only the stub.
  await faceplate.locator('.rack-jack[data-port="reset"]').click();
  assert.deepEqual(await page.evaluate(() => window.parameterReveals.at(-1)), { nodeIndex: 0, name: 'reset', value: 0 });
  await faceplate.locator('.rack-module-head').click();
  assert.equal(await stub.evaluate(el => el.classList.contains('is-selected')), true);
  assert.equal(await faceplate.evaluate(el => el.classList.contains('is-selected')), true);
  await page.getByLabel('Find rack module', { exact: true }).fill('amp');
  assert.equal(await stub.evaluate(el => el.classList.contains('is-dimmed')), true);
  assert.equal(await faceplate.evaluate(el => el.classList.contains('is-dimmed')), false);
  await page.getByLabel('Find rack module', { exact: true }).fill('');
  // Focus asks again (the coordinator focuses the window); the stub head selects in the rack.
  await stub.getByRole('button', { name: 'Bring the osc window to the front' }).click();
  assert.deepEqual(await page.evaluate(() => [window.popOuts, window.focused]), [['osc', 'osc'], 1]);
  await stub.locator('.rack-module-head').click();
  assert.equal(await page.evaluate(() => window.reveals.at(-1)), '/nodes/0');
  // Unknown ids are ignored.
  await page.evaluate(() => window.rack.setDetached(new Map([...window.moduleWindows].map(([id, w]) => [id, w.host]).concat([['missing', document.body]]))));
  assert.equal(await page.locator('.rack-module-stub').count(), 1);
  // Pop in from the stub: the faceplate returns to the rack and the window host is emptied.
  const host = await popup.evaluateHandle(() => document.querySelector('.module-window-host'));
  await stub.getByRole('button', { name: 'Pop osc back into the rack' }).click();
  assert.deepEqual(await page.evaluate(() => window.popIns), ['osc']);
  assert.equal(await page.locator('.rack-module-stub').count(), 0);
  assert.equal(await page.locator('.rack-module[data-node-key="node:0"] [data-parameter="freq"]').count(), 1);
  assert.equal(await page.locator('.rack-module[data-node-key="node:0"] .rack-module-pop').count(), 1);
  assert.equal(await endpointsInRings(page), true);
  assert.equal(await host.evaluate(el => el.childElementCount).catch(() => 0), 0);
});

test('popped faceplates reflow and scale to fill their window and follow resizes', async t => {
  const page = await setup(t, smallPatch);
  await withModuleWindows(page);
  const popup = await popOut(page, '.rack-module[data-node-key="node:3"] .rack-module-pop');
  const measure = () => popup.evaluate(async () => {
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const card = document.querySelector('.rack-module.is-window'), r = card.getBoundingClientRect();
    return { scale: Number(card.dataset.windowScale), cols: Number(card.dataset.windowCols), left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
  });
  await popup.setViewportSize({ width: 900, height: 500 });
  const wide = await measure();
  if (process.env.RACK_SCREENSHOT_DIR) await popup.screenshot({ path: `${process.env.RACK_SCREENSHOT_DIR}/mixer-window.png` });
  assert.ok(wide.scale > 1.5, JSON.stringify(wide));
  assert.ok(wide.left >= 0 && wide.top >= 0 && wide.right <= wide.width + 1 && wide.bottom <= wide.height + 1, JSON.stringify(wide));
  assert.ok(Math.max(wide.right - wide.left, wide.bottom - wide.top) > Math.min(wide.width, wide.height) * .6, JSON.stringify(wide));
  // A tall narrow window chooses fewer columns (reflow) and scales to fit.
  await popup.setViewportSize({ width: 320, height: 900 });
  const tall = await measure();
  assert.ok(tall.cols < wide.cols, JSON.stringify({ wide, tall }));
  assert.ok(tall.right <= tall.width + 1 && tall.bottom <= tall.height + 1 && tall.scale > 1, JSON.stringify(tall));
  // refreshLayout (the coordinator's onLayout) re-fits as well.
  await popup.evaluate(() => { document.querySelector('.module-window-host').style.height = '50vh'; });
  await page.evaluate(() => window.rack.refreshLayout());
  const half = await measure();
  assert.ok(half.bottom <= half.height / 2 + 1 && half.scale < tall.scale, JSON.stringify(half));
});

test('popped-out oscilloscope: screen fills the window, stub jacks keep probe cables and patching', async t => {
  const page = await setup(t, scopePatch, 1200, { scope: true, realScope: true });
  await withModuleWindows(page);
  const popup = await popOut(page, '.rack-module[data-node-key="$rack-scope"] .rack-module-pop');
  assert.deepEqual(await page.evaluate(() => window.popOuts), ['$scope']);
  const stub = page.locator('.rack-module-stub[data-node-key="$rack-scope"]');
  assert.equal(await stub.count(), 1); assert.match(await stub.textContent(), /In window/);
  assert.equal(await page.locator('.rack-module').first().getAttribute('data-node-key'), '$rack-scope');
  assert.deepEqual(await stub.locator('.rack-scope-jack').evaluateAll(j => j.map(x => x.dataset.channel)), ['x', 'y1', 'y2', 'y3', 'y4']);
  assert.equal(await page.evaluate(() => window.screenElement.ownerDocument !== document && !document.contains(window.screenElement)), true);
  assert.equal(await popup.evaluate(() => document.querySelector('.rack-scope-screen.scope-fill > .scope-view') !== null), true);
  assert.equal(await endpointsInRings(page), true);
  const wire = (await page.locator('.rack-cable.is-probe[data-channel="y1"] .rack-cable-wire').getAttribute('d')).split(' ').map(Number);
  const y1 = await ringCentre(page, '.rack-module-stub .rack-scope-jack[data-channel="y1"] .rack-jack-ring');
  assert.ok(Math.hypot(wire.at(-2) - y1[0], wire.at(-1) - y1[1]) < .5);
  const screen = () => popup.evaluate(async () => {
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const r = document.querySelector('.scope-screen').getBoundingClientRect(), canvas = document.querySelector('.scope-grid');
    return { width: r.width, height: r.height, innerWidth, innerHeight, canvas: canvas.width, bottom: document.querySelector('.rack-module.is-window').getBoundingClientRect().bottom };
  });
  await popup.setViewportSize({ width: 700, height: 600 });
  const small = await screen();
  await popup.setViewportSize({ width: 1100, height: 900 });
  const large = await screen();
  if (process.env.RACK_SCREENSHOT_DIR) { await page.screenshot({ path: `${process.env.RACK_SCREENSHOT_DIR}/scope-stub.png` }); await popup.screenshot({ path: `${process.env.RACK_SCREENSHOT_DIR}/scope-window.png` }); }
  for (const s of [small, large]) {
    assert.ok(s.width > s.innerWidth - 60, JSON.stringify(s));
    assert.ok(s.bottom <= s.innerHeight + 1, JSON.stringify(s));
  }
  assert.ok(large.height - small.height > 250, JSON.stringify({ small, large }));
  assert.ok(large.canvas > small.canvas, 'the scope re-measures its canvas in the window');
  // Probing from a stub jack still works.
  const from = page.locator('.rack-module-stub .rack-scope-jack[data-channel="y2"]'), to = page.locator('.rack-module[data-node-key="node:2"] .rack-jack[data-direction="input"][data-port="gain"]');
  await from.scrollIntoViewIfNeeded(); const a = await from.boundingBox(), b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.probes.at(-1)), { channel: 'y2', ref: { node: 'amp', port: 'gain', direction: 'input' } });
  // Window scope jacks select probes but do not start drags.
  await popup.locator('.rack-scope-jack[data-channel="y1"]').click();
  assert.equal(await page.locator('.rack-cable.is-cable-selected').getAttribute('data-channel'), 'y1');
  // Rebuilds keep the same screen element in the window; pop in returns it to the rack.
  await page.evaluate(() => window.rack.setProject(window.project));
  assert.equal(await popup.evaluate(() => document.querySelector('.rack-scope-screen > *') === window.opener.screenElement), true);
  await stub.getByRole('button', { name: 'Pop oscilloscope back into the rack' }).click();
  assert.deepEqual(await page.evaluate(() => window.popIns), ['$scope']);
  assert.equal(await page.evaluate(() => document.querySelector('.rack-scope-screen > *') === window.screenElement), true);
  await page.evaluate(() => window.rack.destroy());
});
