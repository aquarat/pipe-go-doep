/* Classic dedicated worker: wasm_exec.js supplies the matching Go runtime. */
let ready = false;

function fatal(error) {
  ready = false;
  self.postMessage({ type: 'fatal', error: error?.message || String(error) });
}

self.onmessage = ({ data }) => {
  if (data?.type !== 'request') return;
  if (!ready) {
    self.postMessage({ type: 'result', id: data.id, status: 503,
      contentType: 'text/plain; charset=utf-8', body: 'Browser renderer is not ready\n' });
    return;
  }
  try {
    const result = self.pipeGoDoepRequest(data.action, data.json);
    const transfer = result.body instanceof Uint8Array ? [result.body.buffer] : [];
    self.postMessage({ type: 'result', id: data.id, ...result }, transfer);
  } catch (error) {
    fatal(error);
  }
};

async function start() {
  importScripts('/static/wasm_exec.js');
  const go = new Go();
  const response = await fetch('/static/synth.wasm');
  if (!response.ok) throw new Error(`Cannot load browser renderer (${response.status})`);
  // ArrayBuffer instantiation also works with development servers that do not
  // yet advertise application/wasm; no eval or blob worker is required.
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
  go.run(instance).then(() => fatal(new Error('Go renderer exited')), fatal);
  if (typeof self.pipeGoDoepRequest !== 'function') throw new Error('Go renderer bridge did not initialize');
  ready = true;
  self.postMessage({ type: 'ready' });
}

start().catch(fatal);
