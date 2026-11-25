// Build first. Uses an existing Playwright/Chromium installation; no dependency
// is added to the synth or deployed assets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(root, 'examples/lantern-duel.json'), 'utf8'));
fixture.beats = 0.5;
fixture.tail_seconds = 0;
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; base-uri 'none'";

async function setup(t, options = {}) {
  const requests = [];
  let workerLoads = 0;
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.url === '/api/runtime') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ renderer: options.renderer || 'wasm' }));
      } else if (req.url === '/api/validate' && options.renderer === 'server') {
        let body = '';
        for await (const chunk of req) body += chunk;
        assert.equal(req.method, 'POST');
        assert.deepEqual(JSON.parse(body), fixture);
        res.setHeader('Content-Type', 'application/json');
        res.end('{"valid":true}');
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(options.app ? await readFile(join(root, 'dist/index.html'))
          : '<!doctype html><button id="validate">Validate</button><button id="render">Render</button><output></output><script type="module" src="/harness.js"></script>');
      } else if (req.url === '/api/examples') {
        res.setHeader('Content-Type', 'application/json');
        res.end('["short-fixture.json"]');
      } else if (req.url === '/api/example?name=short-fixture.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(fixture));
      } else if (req.url === '/harness.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`import { synthRequest } from '/static/render-client.js';
          window.synthRequest = synthRequest;
          window.project = ${JSON.stringify(fixture)};
          for (const action of ['validate', 'render']) document.getElementById(action).onclick = async () => {
            const response = await synthRequest(action, window.project);
            document.querySelector('output').textContent = action + ':' + response.status;
          };`);
      } else if (/^\/static\/[a-zA-Z0-9._-]+$/.test(req.url)) {
        const name = req.url.slice('/static/'.length);
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.css') ? 'text/css' : 'text/javascript');
        if (name === 'synth-worker.js') {
          workerLoads++;
          if (options.firstWorker && workerLoads === 1) {
            res.end(options.firstWorker);
            return;
          }
        }
        let content = await readFile(join(root, 'dist/static', name));
        if (name === 'render-client.js' && options.fastTimeout) {
          content = content.toString().replace('START_TIMEOUT_MS = 30_000', 'START_TIMEOUT_MS = 1_000')
            .replace('OPERATION_TIMEOUT_MS = 90_000', 'OPERATION_TIMEOUT_MS = 1_000');
        }
        res.end(content);
      } else {
        res.writeHead(404).end();
      }
    } catch (error) {
      res.writeHead(500).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (options.app) await page.waitForFunction(() => document.querySelector('#editor')?.value.includes('sample_rate'));
  else await page.waitForFunction(() => typeof window.synthRequest === 'function');
  return { page, requests, workerLoads: () => workerLoads };
}

test('real Chromium worker validates and renders native-identical WAV under strict CSP', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-renderer-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(join(temporary, 'fixture.json'), JSON.stringify(fixture));
  execFileSync('go', ['run', './cmd/pipe-go-doep', 'render', '-o', join(temporary, 'native.wav'), join(temporary, 'fixture.json')], { cwd: root });
  const native = await readFile(join(temporary, 'native.wav'));
  const { page, requests, workerLoads } = await setup(t);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.click('#validate');
  await page.waitForFunction(() => document.querySelector('output').textContent === 'validate:200');
  await page.click('#render');
  await page.waitForFunction(() => document.querySelector('output').textContent === 'render:200');
  const rendered = await page.evaluate(async () => {
    const response = await synthRequest('render', project);
    return { status: response.status, type: response.headers.get('Content-Type'),
      stats: JSON.parse(response.headers.get('X-Render-Stats')),
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  });
  assert.equal(rendered.status, 200);
  assert.equal(rendered.type, 'audio/wav');
  assert.deepEqual(Buffer.from(rendered.bytes), native);
  assert.equal(rendered.stats.frames, (native.length - 44) / 4);
  assert.equal(rendered.stats.sample_rate, fixture.sample_rate);
  assert.ok(rendered.stats.peak > 0);
  assert.equal(workerLoads(), 1);
  assert.equal(requests.filter(path => path === '/api/runtime').length, 1);
  assert.deepEqual(errors, []);
});

test('budgets, malformed scores, concurrency, worker readiness and UI responsiveness', async t => {
  const { page } = await setup(t);
  const result = await page.evaluate(async () => {
    const first = synthRequest('validate', project);
    const second = synthRequest('validate', project);
    const statuses = await Promise.all([first, second].map(async p => (await p).status));
    const failures = [];
    for (const patch of [null, { ...project, sample_rate: 96000 },
      { ...project, beats: 100, bpm: 60 }, { ...project, nodes: Array(129).fill(project.nodes[0]) },
      { ...project, title: 'é'.repeat(1 << 20) }, { ...project, unexpected: true }]) {
      const response = await synthRequest('validate', patch);
      failures.push([response.status, await response.text()]);
    }
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 5);
    const response = await synthRequest('render', { ...project, beats: 12, bpm: 120 });
    clearInterval(ticker);
    const validation = await synthRequest('validate', project);
    return { statuses, failures, ticks, status: response.status, valid: await validation.json() };
  });
  assert.deepEqual(result.statuses, [200, 429]);
  for (const [status, body] of result.failures) { assert.equal(status, 400); assert.ok(body.length > 5); }
  assert.equal(result.status, 200);
  assert.deepEqual(result.valid, { valid: true });
  assert.ok(result.ticks > 2, `UI must keep ticking during Go rendering; got ${result.ticks}`);
});

for (const [name, firstWorker] of [
  ['startup timeout', '/* Never becomes ready. */'],
  ['operation timeout', "postMessage({type:'ready'}); onmessage = () => { while(true) {} };"],
  ['worker crash', "postMessage({type:'ready'}); onmessage = () => { throw new Error('simulated crash'); };"],
  ['worker fatal message', "postMessage({type:'ready'}); onmessage = () => postMessage({type:'fatal',error:'simulated failure'});"],
]) {
  test(`${name} rejects and next request starts a fresh real Go worker`, async t => {
    const { page, workerLoads } = await setup(t, { firstWorker, fastTimeout: true });
    const result = await page.evaluate(async () => {
      let error;
      try { await synthRequest('validate', project); } catch (failure) { error = failure.message; }
      const response = await synthRequest('validate', project);
      return { error, status: response.status, body: await response.json() };
    });
    assert.ok(result.error);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { valid: true });
    assert.equal(workerLoads(), 2);
  });
}

test('server runtime preserves HTTP POST and caches runtime without creating a worker', async t => {
  const { page, requests, workerLoads } = await setup(t, { renderer: 'server' });
  assert.deepEqual(await page.evaluate(async () => {
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await (await synthRequest('validate', project)).json());
    return results;
  }), [{ valid: true }, { valid: true }]);
  assert.equal(requests.filter(path => path === '/api/runtime').length, 1);
  assert.equal(workerLoads(), 0);
});

test('built application Check project and Render audio controls use the ready Go worker', async t => {
  const { page, requests, workerLoads } = await setup(t, { app: true });
  await page.click('#validate');
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Valid project'));
  await page.click('#render');
  await page.waitForFunction(() => document.querySelector('#render-state').textContent === 'Rendered · ready to play');
  assert.match(await page.locator('#status').textContent(), /rendered in/);
  assert.match(await page.locator('#audio').getAttribute('src'), /^blob:/);
  assert.equal(await page.locator('#download').getAttribute('aria-disabled'), 'false');
  assert.equal(workerLoads(), 1);
  assert.equal(requests.filter(path => path === '/api/runtime').length, 1);
  assert.equal(requests.filter(path => path === '/api/render' || path === '/api/validate').length, 0);
});
