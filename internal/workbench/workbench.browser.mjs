// Optional integration check against an already-running preview. Playwright is
// a development-only dependency; point PLAYWRIGHT_MODULE at an external install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const url = process.env.WORKBENCH_URL || 'http://127.0.0.1:8080';

test('project identity, panes, tree state and musical views integrate', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const project = async () => JSON.parse(await page.locator('#editor').inputValue());
    const waitTitle = title => page.waitForFunction(value => document.querySelector('#title').textContent === value, title);
    await waitTitle('Lantern Duel');
    const a = await project();
    assert.match(a.id, /^[a-f0-9-]{36}$/);
    assert.equal(await page.locator('#json-pane').getAttribute('open'), null);
    assert.equal(await page.locator('.rack-module').count(), a.nodes.length + 1);
    assert.equal(await page.locator('.rack-cable').count(), a.connections.length + 2);
    assert.equal(await page.locator('.rack-function-icon').count(), a.nodes.length + 1);

    await page.locator('#json-pane > summary').click();
    assert.equal(await page.locator('#json-tree .tree-row').count(), 1);
    for (const path of ['', '/tracks', '/tracks/0', '/tracks/0/patterns']) {
      await page.locator(`.tree-row[data-path="${path}"] .tree-toggle`).click();
    }
    const expanded = (await project())._ui.tree_expanded;
    await page.locator('#rack-pane > summary').click();
    // Intentionally reload immediately: native details.toggle is asynchronous.
    await page.reload(); await waitTitle('Lantern Duel');
    assert.equal(await page.locator('#rack-pane').getAttribute('open'), null);
    assert.notEqual(await page.locator('#json-pane').getAttribute('open'), null);
    assert.deepEqual((await project())._ui.tree_expanded, expanded);

    await page.selectOption('#examples', 'neon-dojo.json'); await page.click('#load'); await waitTitle('Neon Dojo');
    const b = await project(); assert.notEqual(a.id, b.id);
    assert.equal(await page.locator('#json-pane').getAttribute('open'), null);
    assert.notEqual(await page.locator('#rack-pane').getAttribute('open'), null);
    await page.locator('#score-pane > summary').click();
    await page.getByLabel('Rack zoom', { exact: true }).selectOption('0.65');
    await page.selectOption('#saved-projects', a.id); await waitTitle('Lantern Duel');
    assert.equal(await page.locator('#rack-pane').getAttribute('open'), null);
    await page.locator('#rack-pane > summary').click();
    await page.click('#render');
    await page.waitForFunction(() => document.querySelector('#render-state').textContent === 'Rendered · ready to play');
    await page.waitForFunction(() => document.querySelector('#audio').readyState >= 2);
    assert.equal(await page.locator('#clipped').textContent(), '0');
    await page.locator('#collapse-tree').click();
    assert.equal(await page.locator('#render-state').textContent(), 'Rendered · ready to play');
    await page.evaluate(() => document.querySelector('#audio').play());
    await page.waitForFunction(() => document.querySelector('#audio').currentTime > .2);
    await page.evaluate(() => document.querySelector('#audio').pause());
    const before = await page.evaluate(() => document.querySelector('#audio').currentTime);
    await page.locator('#tempo').fill('150'); await page.click('#apply-tempo');
    await page.getByRole('button', { name: 'Seek here', exact: true }).click();
    assert.equal(await page.locator('#status').textContent(), 'Render this project to seek its audio.');
    assert.equal(await page.evaluate(() => document.querySelector('#audio').currentTime), before);

    await page.locator('[data-module-type="mixer"] .rack-module-head').first().click();
    assert.equal((await project())._ui.tree_expanded.some(p => p.startsWith('/nodes/')), true);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.id, a.id); assert.deepEqual(exported._ui, (await project())._ui);

    await page.locator('#source-pane > summary').click();
    await page.locator('#editor').fill('{"broken":');
    await page.reload(); await waitTitle('Lantern Duel');
    assert.equal(await page.locator('#editor').inputValue(), '{"broken":');
    await page.click('#apply-source');
    await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
    await page.click('#revert-source');
    await page.selectOption('#saved-projects', b.id); await waitTitle('Neon Dojo');
    assert.equal(await page.locator('#score-pane').getAttribute('open'), null);
    assert.equal(await page.getByLabel('Rack zoom', { exact: true }).inputValue(), '0.65');

    let release, seen;
    const blocked = new Promise(resolve => { release = resolve; }), sawRoute = new Promise(resolve => { seen = resolve; });
    await page.route('**/api/example?name=lantern-duel.json', async route => { seen(); await blocked; await route.continue(); });
    await page.selectOption('#examples', 'lantern-duel.json'); await page.click('#load'); await sawRoute;
    await page.selectOption('#saved-projects', b.id);
    const response = page.waitForResponse(r => r.url().includes('/api/example?name=lantern-duel.json'));
    release(); await response;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#title').textContent(), 'Neon Dojo');

    const limit = await page.evaluate(async () => {
      const { createJSONTree } = await import('/static/json-tree.js');
      const root = document.createElement('div'); let writes = 0, error = '';
      const tree = createJSONTree(root, { onExpanded: () => writes++, onEdit() {}, onError: message => { error = message; } });
      tree.setProject({ id: 'test', a: { b: 1 }, _ui: { tree_expanded: Array.from({ length: 4096 }, (_, i) => '/unused' + i) } });
      tree.reveal('/a'); tree.destroy(); return { writes, error };
    });
    assert.equal(limit.writes, 0); assert.match(limit.error, /Collapse/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('rack edits and reconnections share one project across real pane windows', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
    const page = await context.newPage(), errors = [];
    context.on('page', child => {
      child.on('pageerror', error => errors.push(error.message));
      child.on('console', message => { if (/Content Security Policy/i.test(message.text())) errors.push(message.text()); });
    });
    page.on('pageerror', error => errors.push(error.message));
    const fixture = {
      version: 1, title: 'Gesture check', sample_rate: 8000, bpm: 120, beats: 8, tail_seconds: 0, seed: 1, tracks: [],
      nodes: [{ id: 'osc', type: 'sine' }, { id: 'other', type: 'pulse' }, { id: 'amp', type: 'vca' }, { id: 'mix', type: 'mixer' }],
      connections: [{ from: 'osc.out', to: 'amp.in' }, { from: 'osc.out', to: 'mix.a' }],
      output: { left: 'amp.out', right: 'mix.out', gain: .1 },
    };
    await page.route('**/api/example?*', route => route.fulfill({ json: fixture }));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Gesture check');
    let sourceHost = page;
    const project = async () => JSON.parse(await sourceHost.locator('#editor').inputValue());
    const freq = host => host.locator('[data-node-key="node:0"] [data-parameter="freq"]');
    assert.equal((await project()).nodes[0].params.freq, 440);
    await freq(page).click();
    assert.equal(await page.getByLabel('/nodes/0/params/freq', { exact: true }).inputValue(), '440');
    const drag = async (host, locator, dy) => {
      await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox();
      await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await host.mouse.down();
      await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 6 }); await host.mouse.up();
    };
    await drag(page, freq(page), -30);
    const value = (await project()).nodes[0].params.freq;
    assert.ok(value > 440);
    await freq(page).focus(); await page.keyboard.press('ArrowUp');
    assert.ok((await project()).nodes[0].params.freq > value);
    const pop = async name => {
      const pending = page.waitForEvent('popup');
      await page.locator(`#${name}-pane > summary .pane-window-button`).click();
      const child = await pending; await child.waitForLoadState(); return child;
    };
    const rack = await pop('rack'), json = await pop('json'); sourceHost = json;
    await rack.setViewportSize({ width: 1500, height: 1800 });
    await drag(rack, freq(rack), -20);
    assert.ok((await project()).nodes[0].params.freq > value);
    await freq(rack).click();
    const scalar = json.getByLabel('/nodes/0/params/freq', { exact: true });
    await scalar.fill('550'); await scalar.press('Enter');
    assert.equal(await freq(rack).getAttribute('aria-valuenow'), '550');
    const reconnect = async (label, end, node, direction, port) => {
      await rack.getByRole('button', { name: `Select cable: ${label}`, exact: true }).focus(); await rack.keyboard.press('Enter');
      const handle = rack.locator(`.is-cable-selected .rack-cable-end[data-end="${end}"]`);
      await handle.scrollIntoViewIfNeeded();
      const from = await handle.boundingBox();
      const to = await rack.locator(`.rack-module[data-node-key="node:${node}"] .rack-jack[data-direction="${direction}"][data-port="${port}"]`).boundingBox();
      await rack.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await rack.mouse.down();
      await rack.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 }); await rack.mouse.up();
    };
    await reconnect('osc.out → amp.in', 'from', 1, 'output', 'out');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Cable reconnected')).catch(async error => {
      throw Error(`${error.message}; status: ${await page.locator('#status').textContent()}; routes: ${JSON.stringify((await project()).connections)}`);
    });
    assert.deepEqual((await project()).connections, [{ from: 'other.out', to: 'amp.in' }, fixture.connections[1]]);
    await reconnect('other.out → amp.in', 'to', 3, 'input', 'a');
    assert.equal((await project()).connections[0].to, 'amp.in');
    await reconnect('other.out → amp.in', 'from', 2, 'output', 'out');
    await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
    assert.equal((await project()).connections[0].from, 'other.out');
    await page.click('#render');
    await page.waitForFunction(() => document.querySelector('#render-state').textContent === 'Rendered · ready to play');
    await page.evaluate(() => document.querySelector('#audio').play());
    const monitor = await pop('monitor');
    await monitor.waitForFunction(() => document.querySelector('#audio').currentTime > .1 && !document.querySelector('#audio').paused);
    await monitor.getByRole('button', { name: 'Pop in Output monitor', exact: true }).click();
    assert.equal(await page.locator('#audio').evaluate(audio => audio.paused), false);
    await rack.close();
    await page.locator('#rack-view').waitFor();
    await json.getByRole('button', { name: 'Pop in Project / JSON tree', exact: true }).click(); sourceHost = page;
    assert.equal((await project()).nodes[0].params.freq, 550);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#title').textContent === 'Gesture check');
    assert.equal((await project()).nodes[0].params.freq, 550);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
