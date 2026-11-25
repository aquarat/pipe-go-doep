// Both backends intentionally return real Responses so the editor has one API.
const MAX_JSON_BYTES = 2 << 20;
const START_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 90_000;
let runtimePromise;
let worker;
let readyPromise;
let readyResolve;
let readyReject;
let startTimer;
let pending;
let busy = false;
let nextID = 0;

function textResponse(message, status) {
  return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function runtime() {
  if (!runtimePromise) {
    runtimePromise = fetch('/api/runtime', { signal: AbortSignal.timeout(START_TIMEOUT_MS) })
      .then(async response => {
        if (!response.ok) throw new Error(`Cannot detect synth runtime (${response.status})`);
        const { renderer } = await response.json();
        if (renderer !== 'server' && renderer !== 'wasm') throw new Error('Unknown synth runtime');
        return renderer;
      }).catch(error => {
        runtimePromise = undefined;
        throw error;
      });
  }
  return runtimePromise;
}

function stopWorker(error) {
  worker?.terminate();
  worker = undefined;
  clearTimeout(startTimer);
  readyReject?.(error);
  readyResolve = readyReject = undefined;
  readyPromise = undefined;
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
    pending = undefined;
  }
}

function startWorker() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const promise = readyPromise;
  try {
    const current = new Worker('/static/synth-worker.js');
    worker = current;
    current.onerror = event => {
      event.preventDefault();
      if (worker === current) stopWorker(new Error(event.message || 'Browser renderer failed'));
    };
    current.onmessageerror = () => {
      if (worker === current) stopWorker(new Error('Cannot decode browser renderer response'));
    };
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      if (data.type === 'ready') {
        clearTimeout(startTimer);
        readyResolve?.();
        readyResolve = readyReject = undefined;
      } else if (data.type === 'fatal') {
        stopWorker(new Error(data.error || 'Browser renderer failed'));
      } else if (data.type === 'result' && pending?.id === data.id) {
        const operation = pending;
        pending = undefined;
        clearTimeout(operation.timer);
        try {
          const headers = { 'Content-Type': data.contentType };
          if (data.stats) headers['X-Render-Stats'] = data.stats;
          if (data.contentType === 'audio/wav') headers['Content-Disposition'] = 'attachment; filename="pipe-go-doep.wav"';
          operation.resolve(new Response(data.body, { status: data.status, headers }));
        } catch (error) {
          operation.reject(error);
          stopWorker(error);
        }
      }
    };
    startTimer = setTimeout(() => stopWorker(new Error('Browser renderer startup timed out; retry to restart')), START_TIMEOUT_MS);
  } catch (error) {
    stopWorker(error);
  }
  return promise;
}

export async function synthRequest(action, project) {
  if (action !== 'validate' && action !== 'render') return textResponse('Unknown synth action', 400);
  const renderer = await runtime();
  if (renderer === 'server') {
    return fetch(`/api/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project),
    });
  }
  // Bound the entire lifecycle, including startup, to one operation. Reject
  // excess work rather than accumulating scores while a worker is CPU-bound.
  if (busy) return textResponse('a render or validation is already running', 429);
  busy = true;
  try {
    const json = JSON.stringify(project);
    if (typeof json !== 'string') return textResponse('score must be a JSON object', 400);
    if (new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) {
      return textResponse('workbench limit: 2097152 JSON bytes', 400);
    }
    await startWorker();
    return await new Promise((resolve, reject) => {
      const id = ++nextID;
      const timer = setTimeout(() => stopWorker(new Error('Browser render timed out; retry to restart')), OPERATION_TIMEOUT_MS);
      pending = { id, resolve, reject, timer };
      try {
        worker.postMessage({ type: 'request', id, action, json });
      } catch (error) {
        stopWorker(error);
      }
    });
  } finally {
    busy = false;
  }
}
