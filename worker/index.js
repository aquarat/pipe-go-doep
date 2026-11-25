// Synthesis runs in the browser's dedicated Go WASM worker. The edge only serves
// assets and the small discovery API shared with the native Go workbench.
const policy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function headers(response, request) {
  const result = new Response(request.method === 'HEAD' ? null : response.body, response);
  result.headers.set('Content-Security-Policy', policy);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'same-origin');
  // Runtime files have stable names, so revalidate after each deployment.
  result.headers.set('Cache-Control', 'no-cache');
  // Do not isolate browsing-context groups: pop-out panes adopt the parent's DOM.
  return result;
}

function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: extra });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.method === 'POST' && ['/api/render', '/api/validate'].includes(path)) {
      return json({ error: 'This public workbench renders and validates in your browser using Go WebAssembly. Use the workbench interface.', renderer: 'wasm' }, 501);
    }
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }
  if (path === '/api/runtime') return json({ renderer: 'wasm' });
  if (path === '/api/examples') {
    url.pathname = '/examples/index.json';
    url.search = '';
    return env.ASSETS.fetch(new Request(url, request));
  }
  if (path === '/api/example') {
    const name = url.searchParams.get('name') || '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/.test(name) || name === 'index.json') {
      return json({ error: 'Invalid example name' }, 400);
    }
    url.pathname = `/examples/${name}`;
    url.search = '';
    return env.ASSETS.fetch(new Request(url, request));
  }
  if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
  // Defense in depth: a build must never expose project files or test harnesses.
  if (path.split('/').some(part => part.startsWith('.')) || /\.(?:map|mjs|go|env)$/.test(path) || /\.(?:test|browser)\./.test(path)) {
    return json({ error: 'Not found' }, 404);
  }
  const response = await env.ASSETS.fetch(request);
  if (response.ok && path.endsWith('.wasm')) {
    const result = new Response(response.body, response);
    result.headers.set('Content-Type', 'application/wasm');
    return result;
  }
  return response;
}

export default {
  async fetch(request, env) {
    try {
      return headers(await route(request, env), request);
    } catch (error) {
      console.error(JSON.stringify({ message: 'Asset request failed', error: String(error), path: new URL(request.url).pathname }));
      return headers(json({ error: 'Unable to load workbench assets' }, 500), request);
    }
  },
};
