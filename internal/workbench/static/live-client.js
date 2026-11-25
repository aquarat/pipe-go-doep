const START_TIMEOUT = 30_000;
const REQUEST_TIMEOUT = 90_000;
const MAX_JSON_BYTES = 2 << 20;

// Keep this conservative shape aligned with engine.sameStructure. Parameter
// previews may follow the already queued <=100ms of audio; structural changes
// instead flush immediately and seek the replacement to the audible position.
function structureOf(project) {
  return JSON.stringify([project.version, project.sample_rate, project.bpm,
    project.beats, project.tail_seconds, project.seed, project.tracks,
    project.connections, project.nodes?.map(node => [node.id, node.type, node.track]),
    project.output?.left, project.output?.right]);
}

// All public asynchronous methods settle to true (applied) or false (superseded /
// failed). Errors also go to onError, including fire-and-forget project updates.
export function createLiveTransport({ onState, onTime, onError, onProbe } = {}) {
  let context, node, nodePromise, worker, workerPromise, boot, pending;
  let destroyed = false, epoch = 0, reconciled = -1, nextID = 0;
  let json, structure, appliedStructure, projectVersion = 0, appliedVersion = -1, engineOpen = false;
  let mode = 'idle', target = 0, grainEnd = 0, sourceRate = 48000, totalFrames = 0;
  let sent = 0, consumed = 0, sentBlocks = 0, consumedBlocks = 0, enginePosition = 0, eof = false, primed = false;
  let loop = { enabled: false, start: 0, end: 0 };
  let running = false, requested = false;
  // Probe list (JSON), latest wins. engineProbes is what the current worker's
  // engine holds; a fresh worker holds none, so probes are resent after restart.
  let probes = '[]', engineProbes = '[]';
  const waiters = new Map();
  const state = { playing: false, ready: false, position: 0, duration: 0, buffering: false, underruns: 0 };
  const callback = (fn, value) => { try { fn?.(value); } catch (error) { console.error(error); } };
  const emit = () => callback(onState, { ...state });
  const time = value => { state.position = value; callback(onTime, value); };
  const errorMessage = error => error?.message || String(error);
  const clamp = seconds => Math.max(0, Math.min(state.ready ? state.duration : Infinity,
    Number.isFinite(seconds) ? seconds : 0));

  function settle(value, current = epoch) {
    const resolve = waiters.get(current);
    if (resolve) { waiters.delete(current); resolve(value); }
  }
  function reset(active = false) {
    sent = consumed = sentBlocks = consumedBlocks = 0; eof = false; primed = false;
    node?.port.postMessage({ type: 'reset', epoch, sampleRate: sourceRate,
      position: target * sourceRate, active });
  }
  function invalidate(nextMode, seconds = state.position) {
    for (const resolve of waiters.values()) resolve(false);
    waiters.clear();
    epoch++; mode = nextMode; target = clamp(seconds);
    state.playing = mode === 'play';
    state.buffering = mode !== 'idle';
    time(target); reset(); emit();
    return epoch;
  }
  function fail(error, current = epoch) {
    if (destroyed || current !== epoch) return;
    callback(onError, errorMessage(error));
    settle(false);
    invalidate('idle');
    reconciled = epoch;
  }
  function stopWorker(error) {
    worker?.terminate(); worker = undefined; workerPromise = undefined;
    if (boot) { clearTimeout(boot.timer); boot.reject(error); boot = undefined; }
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
    engineOpen = false; appliedVersion = -1; state.ready = false; engineProbes = '[]';
  }
  function startWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = new Promise((resolve, reject) => {
      boot = { resolve, reject, timer: setTimeout(() => stopWorker(new Error('Live synth startup timed out; retry to restart')), START_TIMEOUT) };
    });
    const promise = workerPromise;
    try {
      const current = new Worker('/static/live-worker.js'); worker = current;
      const fatal = message => {
        if (worker !== current) return;
        const error = new Error(message);
        stopWorker(error); fail(error);
      };
      current.onerror = event => { event.preventDefault(); fatal(event.message || 'Live synth worker failed'); };
      current.onmessageerror = () => fatal('Cannot decode live synth response');
      current.onmessage = ({ data }) => {
        if (worker !== current) return;
        if (data.type === 'ready') {
          if (boot) { clearTimeout(boot.timer); boot.resolve(); boot = undefined; }
        } else if (data.type === 'fatal') fatal(data.error || 'Live synth failed');
        else if (data.type === 'result' && pending?.id === data.id) {
          const operation = pending; pending = undefined; clearTimeout(operation.timer);
          if (data.status === 200) operation.resolve(data);
          else operation.reject(new Error(data.error || `Live synth request failed (${data.status})`));
        }
      };
    } catch (error) { stopWorker(error); }
    return promise;
  }
  function request(action, payload, current) {
    return new Promise((resolve, reject) => {
      if (!worker || destroyed) { reject(new Error('Live synth is closed')); return; }
      const id = ++nextID;
      pending = { id, resolve, reject, timer: setTimeout(() => stopWorker(new Error('Live synth operation timed out; retry to restart')), REQUEST_TIMEOUT) };
      try { worker.postMessage({ type: 'request', id, epoch: current, action,
        json: typeof payload === 'string' ? payload : JSON.stringify(payload) }); }
      catch (error) { stopWorker(error); }
    });
  }
  // Probe failures are reported but never stop playback. A worker that died
  // meanwhile is a transport failure and propagates.
  async function syncProbes(current) {
    while (engineOpen && probes !== engineProbes && !destroyed) {
      const list = probes, owner = worker;
      try {
        await request('probe', `{"probes":${list}}`, current);
      } catch (error) {
        if (worker !== owner || !worker) throw error;
        if (list === probes) callback(onError, `Oscilloscope probes: ${errorMessage(error)}`);
      }
      if (worker === owner) engineProbes = list;
      if (destroyed || current !== epoch) return;
    }
  }
  function ensureNode() {
    if (nodePromise) return nodePromise;
    const currentContext = context;
    nodePromise = currentContext.audioWorklet.addModule('/static/live-worklet.js').then(() => {
      if (destroyed) return;
      node = new AudioWorkletNode(currentContext, 'pipe-go-doep-live', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      node.port.onmessage = ({ data }) => {
        if (destroyed || data.epoch !== epoch || reconciled !== epoch) return;
        if (data.type === 'overflow') { fail(new Error('Live audio queue overflow')); return; }
        if (data.type !== 'progress') return;
        consumed = Math.max(consumed, data.consumed);
        consumedBlocks = Math.max(consumedBlocks, data.consumedBlocks);
        if (mode !== 'idle') time(data.position / sourceRate);
        if (data.underrun) state.underruns++;
        const buffering = mode !== 'idle' && (!primed || !!data.buffering) && !data.ended;
        if (state.buffering !== buffering || data.underrun) { state.buffering = buffering; emit(); }
        if (data.ended) {
          if (mode === 'grain') time(target);
          mode = 'idle'; state.playing = false; state.buffering = false; emit();
        } else if (mode !== 'idle' && !eof && sent - consumed < sourceRate * .055) kick();
      };
      node.onprocessorerror = () => {
        node?.disconnect(); node = undefined; nodePromise = undefined;
        fail(new Error('Live audio processor failed; retry playback'));
      };
      node.connect(currentContext.destination);
    }).catch(error => { nodePromise = undefined; throw error; });
    return nodePromise;
  }
  // Called directly on the public-method stack, BEFORE any await / worker load.
  function unlock() {
    try {
      if (destroyed) return Promise.resolve(false);
      if (!context) {
        const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextClass || !globalThis.isSecureContext) throw new Error('Live audio requires HTTPS or localhost; use rendered WAV playback on LAN HTTP');
        context = new AudioContextClass({ latencyHint: 'interactive' });
        if (!context.audioWorklet) throw new Error('AudioWorklet is unavailable; use rendered WAV playback');
      }
      const current = epoch;
      return Promise.resolve(context.resume()).then(() => true, error => { fail(error, current); return false; });
    } catch (error) { fail(error); return Promise.resolve(false); }
  }
  async function reconcileAndFill() {
    const current = epoch;
    if (!json) throw new Error('Load a project before live playback');
    await Promise.all([startWorker(), ensureNode()]);
    if (destroyed || current !== epoch) return;
    if (reconciled !== current) {
      if (appliedVersion !== projectVersion || !engineOpen) {
        const version = projectVersion;
        const shape = structure;
        const result = await request(engineOpen ? 'update' : 'open', json, current);
        // Even stale successful mutations happened in the worker: record them so
        // the next revision updates that engine rather than reopening blindly.
        engineOpen = true; appliedVersion = version; appliedStructure = shape;
        sourceRate = result.sampleRate; totalFrames = result.frames;
        if (destroyed || current !== epoch) return;
      }
      await syncProbes(current);
      if (destroyed || current !== epoch) return;
      state.duration = totalFrames / sourceRate; state.ready = true;
      if (loop.enabled && Math.round(loop.end * sourceRate) <= Math.round(loop.start * sourceRate)) {
        throw new Error('Loop must span at least one project sample frame');
      }
      target = clamp(target);
      if (mode === 'play' && loop.enabled && loop.end > loop.start &&
          (target < loop.start || target >= Math.min(loop.end, state.duration))) target = Math.min(loop.start, state.duration);
      const result = await request('seek', { frame: Math.round(target * sourceRate) }, current);
      if (destroyed || current !== epoch) return;
      enginePosition = result.position;
      target = enginePosition / sourceRate;
      grainEnd = Math.min(totalFrames, enginePosition + Math.round(sourceRate * .08));
      reset(); reconciled = current; time(target); emit();
      if (mode === 'idle') { state.buffering = false; settle(true); emit(); return; }
    }
    // Live parameter changes keep oscillator/envelope/delay history and the Go
    // engine's control ramps. Coalesce again after each synchronous bridge call:
    // no new PCM is read for a superseded knob update.
    while (appliedVersion !== projectVersion && !destroyed && current === epoch) {
      const version = projectVersion, shape = structure;
      const result = await request('update', json, current);
      appliedVersion = version; appliedStructure = shape;
      sourceRate = result.sampleRate; totalFrames = result.frames;
      if (destroyed || current !== epoch) return;
      state.duration = totalFrames / sourceRate;
    }
    await syncProbes(current);
    if (destroyed || current !== epoch || mode === 'idle' || eof) return;
    const capacity = Math.ceil(sourceRate * .1);
    while (!destroyed && current === epoch && sent - consumed < capacity && sentBlocks - consumedBlocks < 24 && !eof) {
      if (appliedVersion !== projectVersion || probes !== engineProbes) { requested = true; return; }
      const looping = mode === 'play' && loop.enabled && loop.start < state.duration;
      const end = mode === 'grain' ? grainEnd : looping ? Math.min(totalFrames, Math.round(loop.end * sourceRate)) : totalFrames;
      if (enginePosition >= end) {
        if (looping) {
          const result = await request('seek', { frame: Math.round(loop.start * sourceRate) }, current);
          if (current !== epoch || destroyed) return;
          enginePosition = result.position;
        } else {
          eof = true; node.port.postMessage({ type: 'eof', epoch: current }); break;
        }
      }
      const count = Math.min(2048, Math.ceil(capacity - (sent - consumed)), end - enginePosition);
      if (count <= 0) break;
      const result = await request('read', { frames: count }, current);
      if (current !== epoch || destroyed) return;
      if (!(result.body instanceof Float32Array) || result.body.length !== result.frames * 2 || result.frames < 0 || result.frames > count) throw new Error('Invalid live PCM block');
      if (!result.frames) {
        eof = true; node.port.postMessage({ type: 'eof', epoch: current }); break;
      }
      enginePosition = result.position + result.frames;
      sent += result.frames; sentBlocks++;
      if (onProbe && result.probe instanceof Float32Array && Array.isArray(result.channels) &&
          result.probe.length === result.frames * result.channels.length) {
        callback(onProbe, { position: result.position, frames: result.frames, sampleRate: sourceRate,
          channels: result.channels, unresolved: Array.isArray(result.unresolved) ? result.unresolved : [],
          data: result.probe });
      }
      node.port.postMessage({ type: 'block', epoch: current, position: result.position,
        fadeOut: enginePosition >= end, body: result.body }, [result.body.buffer]);
    }
    if (current === epoch && !destroyed) {
      if (!primed) { primed = true; node.port.postMessage({ type: 'start', epoch: current }); }
      settle(true);
    }
  }
  function kick() {
    if (destroyed || !context) return;
    requested = true;
    if (running) return;
    running = true;
    // There is only one worker request in flight. New gestures invalidate old
    // results immediately; this loop then reconciles only the newest intent.
    void (async () => {
      try {
        while (requested && !destroyed) {
          requested = false;
          const current = epoch;
          try { await reconcileAndFill(); } catch (error) { fail(error, current); }
        }
      } finally { running = false; }
    })();
  }
  function operation(nextMode, seconds, resumeContext = false) {
    if (destroyed) return Promise.resolve(false);
    const current = invalidate(nextMode, seconds);
    const resumed = resumeContext ? unlock() : Promise.resolve(true);
    if (!context) { state.buffering = false; emit(); return resumed.then(ok => ok && current === epoch); }
    const done = new Promise(resolve => waiters.set(current, resolve));
    // unlock may fail synchronously and supersede the operation.
    if (current !== epoch) settle(false, current);
    else kick();
    return Promise.all([resumed, done]).then(([a, b]) => a && b);
  }

  return {
    setProject(project) {
      if (destroyed) return;
      try {
        const snapshot = JSON.stringify(project);
        if (!snapshot || typeof project !== 'object' || project === null) throw new Error('Project must be a JSON object');
        if (new TextEncoder().encode(snapshot).byteLength > MAX_JSON_BYTES) throw new Error('Workbench limit: 2097152 JSON bytes');
        if (snapshot === json) return;
        const shape = structureOf(JSON.parse(snapshot));
        const preview = mode === 'play' && reconciled === epoch && engineOpen && shape === appliedStructure;
        json = snapshot; structure = shape; projectVersion++;
        if (!preview) invalidate(mode);
        if (context) kick();
      } catch (error) { fail(error); }
    },
    play(seconds) { return operation('play', seconds === undefined ? state.position : seconds, true); },
    pause() {
      if (destroyed) return;
      invalidate('idle'); if (context) kick();
    },
    stop() {
      if (destroyed) return;
      invalidate('idle', 0); if (context) kick();
    },
    seek(seconds) { return operation(mode === 'play' ? 'play' : 'idle', seconds); },
    scrub(seconds) { return operation('grain', seconds, true); },
    endScrub(seconds, resume) { return operation(resume ? 'play' : 'idle', seconds, !!resume); },
    // [{channel, node, port, direction} | {channel, bus}], at most 5; [] clears.
    setProbes(list) {
      if (destroyed) return;
      if (!Array.isArray(list) || list.some(probe => !probe || typeof probe !== 'object')) {
        callback(onError, 'Oscilloscope probes must be a list of objects'); return;
      }
      const next = JSON.stringify(list);
      if (next === probes) return;
      probes = next;
      if (engineOpen && context) kick();
    },
    setLoop(value) {
      if (destroyed) return;
      let next;
      if (!value || !Number.isFinite(value.start) || !Number.isFinite(value.end) || value.start < 0 || value.end <= value.start) {
        if (value?.enabled === false) next = { enabled: false, start: 0, end: 0 };
        else { callback(onError, 'Loop needs a finite start and an end after its start'); return; }
      } else next = { enabled: !!value.enabled, start: value.start, end: value.end };
      // A sub-frame region would make the refill loop unable to advance.
      if (next.enabled && next.end - next.start < 1 / sourceRate) {
        callback(onError, 'Loop must span at least one sample frame'); return;
      }
      if ((!loop.enabled && !next.enabled) || (loop.enabled === next.enabled && loop.start === next.start && loop.end === next.end)) return;
      loop = next;
      invalidate(mode); if (context) kick();
    },
    destroy() {
      if (destroyed) return;
      invalidate('idle'); destroyed = true;
      stopWorker(new Error('Live transport destroyed'));
      if (node) { node.port.onmessage = null; node.port.close(); node.disconnect(); node = undefined; }
      if (context) { void context.close().catch(() => {}); context = undefined; }
      state.ready = false; emit();
    },
    get state() { return { ...state }; },
  };
}
