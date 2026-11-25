/* A separate Go runtime: live operations never block or mutate WAV export. */
let ready = false;
function fatal(error) {
  ready = false;
  self.postMessage({ type: 'fatal', error: error?.message || String(error) });
}
self.onmessage = ({ data }) => {
  if (data?.type !== 'request') return;
  try {
    const result = ready ? self.pipeGoDoepStream(data.action, data.json) :
      { status: 503, error: 'Live synth is not ready' };
    // The bridge returns owned JS PCM, not a view into Go's moving WASM memory.
    const transfer = result.body instanceof Float32Array ? [result.body.buffer] : [];
    self.postMessage({ type: 'result', id: data.id, epoch: data.epoch, ...result }, transfer);
  } catch (error) {
    self.postMessage({ type: 'result', id: data.id, epoch: data.epoch,
      status: 500, error: error?.message || String(error) });
  }
};
async function start() {
  importScripts('/static/wasm_exec.js');
  const go = new Go();
  const response = await fetch('/static/synth.wasm');
  if (!response.ok) throw new Error(`Cannot load live synth (${response.status})`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
  go.run(instance).then(() => fatal(new Error('Live Go synth exited')), fatal);
  if (typeof self.pipeGoDoepStream !== 'function') throw new Error('Live synth bridge is unavailable; rebuild synth.wasm');
  ready = true;
  self.postMessage({ type: 'ready' });
}
start().catch(fatal);
