import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import https from 'node:https';

const origin = new URL(process.env.DEPLOYMENT_URL || 'https://pipe-go-doep.aquarat.co.uk');
// Public DNS avoids the LAN resolver's negative cache after a new domain is added.
const resolver = new Resolver();
resolver.setServers(['1.1.1.1', '1.0.0.1']);
const address = origin.protocol === 'https:' ? (await resolver.resolve4(origin.hostname))[0] : null;
async function get(path) {
  const url = new URL(path, origin);
  if (!address) return fetch(url);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address, family: 4 }])
        : callback(null, address, 4),
      timeout: 30000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers,
      })));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${path}`)));
  });
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const page = await get('/');
assert.equal(page.status, 200, 'public homepage');
assert.match(await page.text(), /\/static\/app\.js/);
assert.match(page.headers.get('content-security-policy'), /'wasm-unsafe-eval'/);
assert.equal(page.headers.get('cross-origin-opener-policy'), null);
assert.deepEqual(await (await get('/api/runtime')).json(), { renderer: 'wasm' });
const examples = JSON.parse(await readFile('dist/examples/index.json', 'utf8'));
assert.deepEqual(await (await get('/api/examples')).json(), examples);
assert.ok(examples.length > 0);
assert.equal(hash(Buffer.from(await (await get(`/api/example?name=${encodeURIComponent(examples[0])}`)).arrayBuffer())), hash(await readFile(`dist/examples/${examples[0]}`)));
for (const directory of ['static', 'examples']) {
  for (const name of await readdir(`dist/${directory}`)) {
    const path = `/${directory}/${name}`;
    const response = await get(path);
    assert.equal(response.status, 200, path);
    if (name.endsWith('.wasm')) assert.match(response.headers.get('content-type'), /^application\/wasm/);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(`dist${path}`)), `deployed hash: ${path}`);
    console.log(`Verified ${path}`);
  }
}
for (const path of ['/.env', '/go.mod', '/worker/index.js', '/static/app.js.map', '/static/rack-model.test.mjs']) {
  assert.equal((await get(path)).status, 404, `private/build-only file: ${path}`);
}
console.log(`Public runtime, headers, example API and all asset hashes verified at ${origin.origin}`);
