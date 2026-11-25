// Optional isolated browser checks; use the same Playwright environment as rack-view.browser.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = Buffer.from(await readFile(new URL('./score-view.js', import.meta.url), 'utf8')).toString('base64');
const css = await readFile(new URL('./score-view.css', import.meta.url), 'utf8');
const project = { bpm: 120, beats: 32, tracks: [{ id: 'lead', patterns: { 'a/~': [{ note: 'C4', beats: 1 }, { note: '.', beats: 1 }] }, order: ['a/~', 'a/~'] }] };

async function setup(t) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<style>body{margin:0}main{width:100%}</style><main></main>');
  await page.addStyleTag({ content: css });
  await page.evaluate(async ({ source, project }) => {
    const { createScoreView } = await import(`data:text/javascript;base64,${source}`);
    window.seeks = []; window.scrubs = []; window.reveals = []; window.capturedAtEnd = false; window.rebuild = false;
    window.project = project;
    window.view = createScoreView(document.querySelector('main'), {
      onSeek: time => window.seeks.push(time), onReveal: pointer => window.reveals.push(pointer),
      onScrub: (time, { phase }) => {
        window.scrubs.push({ time, phase });
        if (phase === 'end' || phase === 'cancel') {
          const root = document.querySelector('main') || window.child.document.querySelector('main');
          window.capturedAtEnd ||= root.querySelector('.sv-ruler').hasPointerCapture(1);
          if (window.rebuild) window.view.setProject(window.project);
        }
      },
    });
    window.view.setProject(project); window.view.setTime(1.25);
    await new Promise(requestAnimationFrame);
  }, { source, project });
  t.after(() => assert.deepEqual(errors, []));
  return page;
}
async function begin(page, x = 32) {
  const box = await page.locator('.sv-ruler').boundingBox();
  await page.mouse.move(box.x + x, box.y + 14); await page.mouse.down();
  return box;
}

test('ruler click, keyboard seeking and source reveal retain their independent behavior', async t => {
  const page = await setup(t);
  await page.locator('.sv-ruler').click({ position: { x: 64, y: 14 } });
  assert.deepEqual(await page.evaluate(() => window.seeks), [1]);
  assert.deepEqual(await page.evaluate(() => window.scrubs), []);
  for (const key of ['ArrowRight', 'Shift+ArrowLeft', 'Home', 'ArrowDown', 'End', 'ArrowUp']) await page.keyboard.press(key);
  assert.deepEqual(await page.evaluate(() => window.seeks), [1, 1.5, 1.375, 0, 0, 16, 16]);
  assert.equal(await page.locator('.sv-ruler').getAttribute('role'), 'slider');
  assert.equal(await page.locator('.sv-ruler').getAttribute('aria-valuenow'), '16');
  await page.locator('.sv-lane').click({ position: { x: 16, y: 60 } });
  assert.deepEqual(await page.evaluate(() => window.reveals), ['/tracks/0/patterns/a~1~0/0']);
  assert.equal(await page.evaluate(() => window.seeks.length), 7);
});

test('real ruler drag captures outside its bounds, clamps and releases before callbacks', async t => {
  const page = await setup(t);
  await page.evaluate(() => { window.rebuild = true; });
  const box = await begin(page);
  await page.mouse.move(box.x + 128, box.y + 14, { steps: 5 });
  assert.equal(await page.locator('.sv-ruler').evaluate(el => el.hasPointerCapture(1)), true);
  await page.mouse.move(box.x - 60, box.y + 100, { steps: 3 }); await page.mouse.up();
  const scrubs = await page.evaluate(() => window.scrubs);
  assert.deepEqual(scrubs[0], { time: .5, phase: 'start' });
  assert.ok(scrubs.some(x => x.phase === 'move' && x.time === 2));
  assert.deepEqual(scrubs.at(-1), { time: 0, phase: 'end' });
  assert.deepEqual(await page.evaluate(() => window.seeks), []);
  assert.equal(await page.evaluate(() => window.capturedAtEnd), false);
  await page.locator('.sv-ruler').click({ position: { x: 64, y: 14 } });
  assert.deepEqual(await page.evaluate(() => window.seeks), [1]);
});

test('Escape, pointercancel, replacement and destruction cancel to the pre-drag time', async t => {
  for (const end of ['escape', 'pointercancel', 'replace', 'destroy']) {
    const page = await setup(t), box = await begin(page);
    await page.mouse.move(box.x + 128, box.y + 14, { steps: 3 });
    if (end === 'escape') await page.keyboard.press('Escape');
    else await page.evaluate(end => {
      if (end === 'pointercancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      if (end === 'replace') window.view.setProject(window.project);
      if (end === 'destroy') window.view.destroy();
    }, end);
    await page.mouse.up();
    const calls = await page.evaluate(() => window.scrubs);
    assert.deepEqual(calls.at(-1), { time: 1.25, phase: 'cancel' });
    assert.equal(calls.filter(x => x.phase === 'cancel').length, 1);
    assert.equal(calls.filter(x => x.phase === 'end').length, 0);
    assert.deepEqual(await page.evaluate(() => window.seeks), []);
    assert.equal(await page.evaluate(() => window.capturedAtEnd), false);
  }
});

test('adopted popout ruler uses its current window, scroll offset and keyboard focus', async t => {
  const page = await setup(t), opened = page.waitForEvent('popup');
  await page.evaluate(() => {
    window.child = window.open('about:blank'); child.document.head.innerHTML = document.head.innerHTML;
    child.document.body.append(document.querySelector('main')); window.view.refreshLayout();
  });
  const popup = await opened; await popup.waitForLoadState(); await popup.setViewportSize({ width: 600, height: 800 });
  await popup.locator('.sv-timeline').evaluate(el => { el.scrollLeft = 128; });
  const box = await begin(popup);
  await popup.mouse.move(box.x + 160, box.y + 14, { steps: 5 }); await popup.mouse.up();
  let calls = await page.evaluate(() => window.scrubs);
  assert.deepEqual(calls[0], { time: 2.5, phase: 'start' });
  assert.deepEqual(calls.at(-1), { time: 4.5, phase: 'end' });
  assert.deepEqual(await page.evaluate(() => window.seeks), []);
  await popup.keyboard.press('ArrowRight');
  assert.deepEqual(await page.evaluate(() => window.seeks), [5]);
  await begin(popup); await popup.mouse.move(box.x + 200, box.y + 14, { steps: 3 });
  await popup.keyboard.press('Escape'); await popup.mouse.up();
  calls = await page.evaluate(() => window.scrubs);
  assert.deepEqual(calls.at(-1), { time: 5, phase: 'cancel' });
  assert.equal(await page.evaluate(() => window.capturedAtEnd), false);
  await page.evaluate(() => window.view.destroy());
});
