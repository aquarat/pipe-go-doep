import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './index.js';

const env = { ASSETS: { async fetch(request) {
  const path = new URL(request.url).pathname;
  const files = { '/examples/index.json': '["demo.json"]', '/examples/demo.json': '{"bpm":120}', '/static/synth.wasm': 'wasm' };
  return new Response(files[path] ?? 'missing', { status: path in files ? 200 : 404 });
} } };
const call = (path, method = 'GET') => worker.fetch(new Request(`https://example.com${path}`, { method }), env);

test('discovery and examples match the native API without an upstream server', async () => {
  assert.deepEqual(await (await call('/api/runtime')).json(), { renderer: 'wasm' });
  assert.deepEqual(await (await call('/api/examples')).json(), ['demo.json']);
  assert.deepEqual(await (await call('/api/example?name=demo.json')).json(), { bpm: 120 });
  assert.equal((await call('/api/example?name=missing.json')).status, 404);
});

test('example requests cannot escape their directory', async () => {
  for (const name of ['../secrets.json', '/demo.json', 'a\\b.json', 'index.json', '', '%2e%2e%2fsecrets.json']) {
    assert.equal((await call(`/api/example?name=${encodeURIComponent(name)}`)).status, 400);
  }
});

test('public synthesis explicitly selects browser execution and rejects other writes', async () => {
  assert.equal((await call('/api/render', 'POST')).status, 501);
  assert.equal((await call('/api/validate', 'POST')).status, 501);
  assert.equal((await call('/static/synth.wasm', 'PUT')).status, 405);
  assert.equal((await call('/api/unknown')).status, 404);
});

test('WASM MIME/CSP, popup access and source-file exclusions', async () => {
  const response = await call('/static/synth.wasm');
  assert.equal(response.headers.get('Content-Type'), 'application/wasm');
  assert.match(response.headers.get('Content-Security-Policy'), /'wasm-unsafe-eval'/);
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), null);
  assert.equal(await (await call('/api/runtime', 'HEAD')).text(), '');
  for (const path of ['/.env', '/static/app.js.map', '/static/rack-model.test.mjs', '/main.go']) {
    assert.equal((await call(path)).status, 404);
  }
});
