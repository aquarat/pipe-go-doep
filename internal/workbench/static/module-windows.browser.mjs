// Optional real-window tests for detached-window.js and module-windows.js using
// an external existing Playwright installation. No request interception: routed
// requests stop pop-up windows loading their copied stylesheets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const files = new Map(await Promise.all(['detached-window.js', 'module-windows.js', 'pane-windows.css', 'workbench.css'].map(async name => [name, await readFile(new URL(name, import.meta.url))])));
const fixture = `<!doctype html><html lang="en"><head><title>fixture</title>
  <link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/pane-windows.css"><link rel="stylesheet" href="/late.css">
  </head><body><button id="go">Go</button></body></html>`;

// A Pop in control closes its own window, which can race Playwright's action bookkeeping.
const closing = action => action.catch(error => { if (!/closed/.test(error.message)) throw error; });

async function setup(t) {
  const server = createServer((req, res) => {
    const name = req.url.slice(1), file = files.get(name);
    if (file) { res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(file); }
    else if (name === 'late.css') {
      res.setHeader('Content-Type', 'text/css'); res.setHeader('Cache-Control', 'no-store');
      setTimeout(() => res.end('.module-window-host .late-marker { width: 37px; }'), 150);
    }
    else { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  // viewport: null lets pop-ups take the size from their window.open features.
  const context = await browser.newContext({ viewport: null });
  const errors = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);
  await page.evaluate(async () => {
    window.detached = await import('/detached-window.js');
    window.modules = await import('/module-windows.js');
    window.features = []; window.log = []; window.errors = [];
    const open = window.open;
    window.open = (...args) => { features.push(args[2]); return open.apply(window, args); };
  });
  t.after(() => assert.deepEqual(errors, []));
  return { page, context, url };
}

// Opens from a real click so the call runs inside a user gesture.
async function openFrom(page, script) {
  const popup = page.waitForEvent('popup');
  await page.evaluate(source => { document.getElementById('go').onclick = () => { window.result = (0, eval)(source); }; }, script);
  await page.locator('#go').click();
  const child = await popup;
  await child.waitForFunction(() => document.querySelector('.detached-window-content'));
  return child;
}

const openWindow = `window.handle = detached.openDetachedWindow({
  title: 'Probe', bodyClass: 'probe-window', geometry: window.requestedGeometry,
  onClose: reason => log.push(['close', reason]),
  onGeometry: g => log.push(['geometry', g.width, g.height]),
  onLayout: () => log.push(['layout']), onError: message => errors.push(message),
})`;

test('detached window opens at the requested geometry and reports resizes', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => { window.requestedGeometry = { left: 40, top: 60, width: 640, height: 480 }; });
  const child = await openFrom(page, openWindow);
  assert.deepEqual(await page.evaluate(() => features), ['popup=yes,resizable=yes,scrollbars=yes,left=40,top=60,width=640,height=480']);
  assert.deepEqual(await child.evaluate(() => [innerWidth, innerHeight]), [640, 480]);
  assert.deepEqual(await page.evaluate(() => handle.geometry()).then(g => [g.width, g.height]), [640, 480]);
  assert.equal(await child.title(), 'Probe — Pipe Go Doep');
  assert.equal(await child.evaluate(() => document.body.classList.contains('detached-window') && document.body.classList.contains('probe-window')), true);
  assert.equal(await child.locator('.detached-window-title').textContent(), 'Probe');
  assert.equal(await child.locator('script').count(), 0);
  await page.waitForFunction(() => log.some(([type]) => type === 'layout'));
  // Content fills the height left by the header.
  const box = await child.evaluate(() => {
    const header = document.querySelector('.detached-window-header').getBoundingClientRect();
    const content = document.querySelector('.detached-window-content').getBoundingClientRect();
    return { top: content.top, header: header.bottom, bottom: content.bottom, height: innerHeight };
  });
  assert.equal(Math.round(box.top), Math.round(box.header));
  assert.equal(Math.round(box.bottom), box.height);
  await child.setViewportSize({ width: 700, height: 520 });
  await page.waitForFunction(() => log.some(([type, w, h]) => type === 'geometry' && w === 700 && h === 520));
  assert.deepEqual(await page.evaluate(() => [handle.geometry().width, handle.geometry().height]), [700, 520]);
  // Default size when no geometry is given.
  await page.evaluate(() => { window.requestedGeometry = null; handle.close(); });
  await openFrom(page, openWindow);
  assert.equal(await page.evaluate(() => features[1]), 'popup=yes,resizable=yes,scrollbars=yes,width=1200,height=850');
  await page.evaluate(() => handle.close());
});

test('close reasons: api with a final geometry report, user, and exactly once', async t => {
  const { page } = await setup(t);
  let child = await openFrom(page, openWindow);
  await page.evaluate(() => { log.length = 0; });
  await child.setViewportSize({ width: 610, height: 430 });
  // Close before the resize debounce elapses: geometry still reported first.
  await page.evaluate(() => { handle.close(); handle.close(); });
  assert.deepEqual(await page.evaluate(() => log.filter(([type]) => type !== 'layout')), [['geometry', 610, 430], ['close', 'api']]);
  assert.equal(await page.evaluate(() => handle.closed && handle.window.closed), true);

  child = await openFrom(page, openWindow);
  await page.evaluate(() => { log.length = 0; });
  await child.evaluate(() => window.close());
  await page.waitForFunction(() => log.some(([type]) => type === 'close'));
  await page.evaluate(() => handle.close());
  assert.deepEqual(await page.evaluate(() => log.filter(([type]) => type === 'close')), [['close', 'user']]);

  child = await openFrom(page, openWindow);
  await page.evaluate(() => { log.length = 0; });
  await child.close();
  await page.waitForFunction(() => log.some(([type]) => type === 'close'), null, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => log.filter(([type]) => type === 'close')), [['close', 'user']]);
  // Timers stop after close: no further callbacks.
  await page.waitForTimeout(1300);
  assert.equal(await page.evaluate(() => log.length), 1);
});

test('opener navigation reports opener and closes the child', async t => {
  const { page, url } = await setup(t);
  const child = await openFrom(page, `window.handle = detached.openDetachedWindow({ title: 'Probe',
    onClose: reason => localStorage.setItem('reason', (localStorage.getItem('reason') || '') + reason + ';'),
    onGeometry: g => localStorage.setItem('geometry', JSON.stringify(g)) })`);
  await child.setViewportSize({ width: 500, height: 400 });
  const closed = child.waitForEvent('close');
  await page.goto(`${url}?next`);
  await closed;
  assert.equal(await page.evaluate(() => localStorage.getItem('reason')), 'opener;');
  const geometry = JSON.parse(await page.evaluate(() => localStorage.getItem('geometry')));
  assert.deepEqual([geometry.width, geometry.height], [500, 400]);
});

test('module windows: host fills window, pop in, focus, user close, dockAll and destroy', async t => {
  const { page, context } = await setup(t);
  await page.evaluate(() => {
    window.changes = []; window.layouts = [];
    window.mw = modules.createModuleWindows({
      onChange: (id, open, geometry, reason) => changes.push([id, open, reason ?? null, !!geometry?.width]),
      onLayout: id => layouts.push([id, mw.host(id)?.querySelector('.late-marker')?.clientWidth]),
      onError: message => errors.push(message),
    });
  });
  const osc = await openFrom(page, `(() => { const host = mw.popOut('osc', { title: 'osc · Oscillator', geometry: { width: 420, height: 500 } });
    host.append(Object.assign(host.ownerDocument.createElement('div'), { className: 'late-marker' })); return host; })()`);
  assert.equal(await page.evaluate(() => result.classList.contains('module-window-host') && result === mw.host('osc') && result.ownerDocument !== document), true);
  assert.equal(await page.evaluate(() => features[0]), 'popup=yes,resizable=yes,scrollbars=yes,width=420,height=500');
  assert.equal(await osc.evaluate(() => document.body.classList.contains('module-window')), true);
  assert.equal(await osc.locator('.detached-window-title').textContent(), 'osc · Oscillator');
  await page.waitForFunction(() => layouts.some(([id, width]) => id === 'osc' && width === 37));
  const fill = await osc.evaluate(() => {
    const host = document.querySelector('.module-window-host').getBoundingClientRect();
    const header = document.querySelector('.detached-window-header').getBoundingClientRect();
    return { header: header.height, top: host.top, bottom: host.bottom, height: innerHeight };
  });
  assert.ok(fill.header < 40, `compact header (${fill.header}px)`);
  assert.equal(Math.round(fill.bottom), fill.height);
  assert.equal(Math.round(fill.top), Math.round(fill.header));
  await osc.setViewportSize({ width: 460, height: 540 });
  await page.waitForFunction(() => layouts.filter(([id]) => id === 'osc').length >= 2 && changes.length >= 2);
  assert.equal(await osc.evaluate(() => Math.round(document.querySelector('.module-window-host').getBoundingClientRect().bottom)), 540);

  // A second popOut focuses the open window and returns the same host.
  assert.equal(await page.evaluate(() => mw.popOut('osc') === mw.host('osc') && mw.focus('osc')), true);
  assert.equal(context.pages().length, 2);

  const scope = await openFrom(page, `mw.popOut('$scope', { title: 'Oscilloscope' })`);
  assert.equal(await page.evaluate(() => features.at(-1)), 'popup=yes,resizable=yes,scrollbars=yes,width=800,height=600');
  assert.deepEqual(await page.evaluate(() => mw.ids()), ['osc', '$scope']);

  // Pop in button docks.
  const scopeClosed = scope.waitForEvent('close');
  await closing(scope.getByRole('button', { name: 'Pop in Oscilloscope' }).click());
  await scopeClosed;
  assert.equal(await page.evaluate(() => mw.isOpen('$scope') || mw.host('$scope') !== null), false);

  // User close docks with reason 'user'.
  await osc.close({ runBeforeUnload: true });
  await page.waitForFunction(() => !mw.isOpen('osc'));
  const changes = await page.evaluate(() => changes);
  assert.deepEqual(changes[0], ['osc', true, null, true]);
  assert.deepEqual(changes.filter(([, open]) => !open), [['$scope', false, 'api', true], ['osc', false, 'user', true]]);

  await openFrom(page, `mw.popOut('a', { title: 'A' })`);
  await openFrom(page, `mw.popOut('b', { title: 'B' })`);
  await page.evaluate(() => mw.dockAll());
  assert.deepEqual(await page.evaluate(() => mw.ids()), []);
  await openFrom(page, `mw.popOut('c', { title: 'C' })`);
  await page.evaluate(() => mw.destroy());
  assert.equal(await page.evaluate(() => mw.popOut('c') === null && mw.ids().length === 0), true);
  await page.waitForTimeout(200);
  assert.equal(context.pages().length, 1);
  assert.deepEqual(await page.evaluate(() => errors), []);
});

test('module windows: blocked pop-up returns null and opener unload reports opener', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => {
    window.mw = modules.createModuleWindows({
      onChange: (id, open, geometry, reason) => localStorage.setItem('changes', (localStorage.getItem('changes') || '') + `${id}:${open}:${reason ?? ''};`),
      onError: message => errors.push(message),
    });
    const open = window.open;
    window.open = () => null;
    window.blocked = mw.popOut('osc', { title: 'osc' });
    window.open = open;
  });
  assert.equal(await page.evaluate(() => blocked), null);
  assert.match(await page.evaluate(() => errors[0]), /Pop-up blocked/);
  await page.evaluate(() => errors.splice(0));
  const child = await openFrom(page, `mw.popOut('osc', { title: 'osc' })`);
  const closed = child.waitForEvent('close');
  await page.reload();
  await closed;
  assert.equal(await page.evaluate(() => localStorage.getItem('changes')), 'osc:true:;osc:false:opener;');
});
