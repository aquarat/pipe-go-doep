// Port order/defaults mirror internal/dsp/dsp.go and engine.sequence.
export const MODULES = {
  sequence: { inputs: {}, outputs: ['freq', 'gate', 'velocity', 'trigger'], family: 'sequence', title: 'Track sequencer' },
  constant: { inputs: { value: 0 }, family: 'control', title: 'Constant voltage' },
  sine: { inputs: { freq: 440, reset: 0 }, family: 'oscillator', title: 'Sine oscillator' },
  pulse: { inputs: { freq: 440, duty: 0.5, reset: 0 }, family: 'oscillator', title: 'Pulse oscillator' },
  triangle: { inputs: { freq: 440, reset: 0 }, family: 'oscillator', title: 'Triangle oscillator' },
  saw: { inputs: { freq: 440, reset: 0 }, family: 'oscillator', title: 'Saw oscillator' },
  wavetable: { inputs: { freq: 440, reset: 0 }, params: { bits: 4 }, family: 'oscillator', title: 'Wavetable oscillator' },
  noise: { inputs: { freq: 8000, reset: 0 }, params: { short: 0 }, family: 'oscillator', title: 'Clocked noise' },
  adsr: { inputs: { gate: 0, trigger: 0 }, params: { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 }, family: 'envelope', title: 'ADSR envelope' },
  vca: { inputs: { in: 0, gain: 1 }, family: 'amplifier', title: 'Voltage amplifier' },
  mixer: { inputs: { a: 0, b: 0, c: 0, d: 0 }, params: { gain_a: 1, gain_b: 1, gain_c: 1, gain_d: 1 }, family: 'mixer', title: 'Four-channel mixer' },
  pan: { inputs: { in: 0, pan: 0 }, outputs: ['left', 'right'], family: 'mixer', title: 'Stereo panner' },
  lowpass: { inputs: { in: 0, cutoff: 2000 }, family: 'filter', title: 'Low-pass · 12 dB/oct' },
  delay: { inputs: { in: 0, time: 0.25, feedback: 0.3, mix: 0.25 }, family: 'effect', title: 'Fractional delay' },
  drive: { inputs: { in: 0, amount: 2 }, family: 'effect', title: 'Saturation drive' },
  bitcrush: { inputs: { in: 0, bits: 8, rate: 8000 }, family: 'effect', title: 'Bit depth / sample hold' },
};

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Unlike JS $, this end assertion cannot match before a trailing newline.
const identifier = /^[A-Za-z_][A-Za-z0-9_-]{0,63}(?![\s\S])/;
const validRate = sr => Number.isInteger(sr) && sr >= 8000 && sr <= 96000;
const moduleSpec = type => typeof type === 'string' && own(MODULES, type) ? MODULES[type] : null;

/** Bounds are constructor bounds, not runtime clamps. step/log are UI hints only. */
export function parameterSpec(type, name, sampleRate = 48000) {
  if (!validRate(sampleRate) || typeof name !== 'string') return null;
  if (type === 'output') return name === 'gain'
    ? { min: 0, max: 16, default: 0, integer: false, step: 0.01, log: false } : null;
  const module = moduleSpec(type);
  if (!module) return null;
  const defaults = { ...module.inputs, ...module.params };
  if (!own(defaults, name)) return null;
  let min = 0, max = 1, step = 0.01, log = false, integer = false;
  switch (name) {
    case 'value': case 'in': case 'a': case 'b': case 'c': case 'd':
      min = -1000000; max = 1000000; break;
    case 'freq': case 'rate': case 'cutoff':
      min = name === 'cutoff' ? 1 : 0;
      max = type === 'noise' || name === 'rate' ? sampleRate : 0.45 * sampleRate;
      step = 1; log = true; break;
    case 'duty': min = 0.01; max = 0.99; step = 0.001; break;
    case 'bits': min = 1; max = 16; integer = type === 'wavetable'; step = integer ? 1 : 0.1; break;
    case 'short': integer = true; step = 1; break;
    case 'attack': case 'decay': case 'release': max = 60; step = 0.001; log = true; break;
    case 'gain': case 'gain_a': case 'gain_b': case 'gain_c': case 'gain_d': min = -16; max = 16; break;
    case 'pan': min = -1; break;
    case 'time': max = 2; step = 0.001; log = true; break;
    case 'feedback': min = -0.99; max = 0.99; step = 0.001; break;
    case 'amount': max = 100; step = 0.1; break;
  }
  return { min, max, default: defaults[name], integer, step, log };
}

/** Materialization adds defaults only; even explicit invalid values stay editable. */
export function materializeDefaults(project) {
  if (!object(project)) return false;
  let changed = false;
  for (const node of Array.isArray(project.nodes) ? project.nodes : []) {
    if (!object(node)) continue;
    const module = moduleSpec(node.type);
    if (!module) continue;
    const defaults = { ...module.inputs, ...module.params };
    if (!Object.keys(defaults).length) continue;
    // null params decodes as an empty map in Go. Other malformed containers stay intact.
    if (!own(node, 'params') || node.params === null) { node.params = {}; changed = true; }
    if (!object(node.params)) continue;
    for (const [name, value] of Object.entries(defaults)) {
      if (!own(node.params, name)) { node.params[name] = value; changed = true; }
    }
  }
  if (!own(project, 'output') || project.output === null) { project.output = {}; changed = true; }
  if (object(project.output) && !own(project.output, 'gain')) {
    // score.Output.Gain is a Go float64, so omission means zero, not unity.
    project.output.gain = 0; changed = true;
  }
  return changed;
}

function requireProject(project) {
  if (!object(project)) throw Error('A project must be a JSON object.');
}

/** Return an independent candidate or throw; never partially mutate the draft. */
export function editParameter(project, change) {
  requireProject(project);
  if (!object(change)) throw Error('A parameter edit is required.');
  const { nodeIndex, name, value } = change;
  let type;
  if (nodeIndex === null) {
    type = 'output';
    if (project.output != null && !object(project.output)) throw Error('Output must be an object.');
  } else {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || !Array.isArray(project.nodes) || nodeIndex >= project.nodes.length || !object(project.nodes[nodeIndex])) {
      throw Error('The selected node no longer exists.');
    }
    const node = project.nodes[nodeIndex];
    type = node.type;
    if (!moduleSpec(type)) throw Error('Unknown module type.');
    if (node.params != null && !object(node.params)) throw Error('Node params must be an object.');
  }
  const spec = parameterSpec(type, name, project.sample_rate);
  if (!spec) throw Error('Unknown parameter or invalid sample rate.');
  if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.integer && !Number.isInteger(value))) {
    throw Error(`${name} must be finite in [${spec.min}, ${spec.max}]${spec.integer ? ' and integer-valued' : ''}.`);
  }
  const candidate = structuredClone(project);
  if (nodeIndex === null) { candidate.output ??= {}; candidate.output.gain = value; }
  else { candidate.nodes[nodeIndex].params ??= {}; candidate.nodes[nodeIndex].params[name] = value; }
  return candidate;
}

function validateRoutes(project) {
  if (!Array.isArray(project.nodes)) throw Error('Nodes must be an array.');
  const nodes = new Map();
  for (const node of project.nodes) {
    if (!object(node) || typeof node.id !== 'string' || !identifier.test(node.id) || nodes.has(node.id)) {
      throw Error('Invalid or duplicate node id.');
    }
    nodes.set(node.id, node);
  }
  function endpoint(ref, direction) {
    const parts = typeof ref === 'string' ? ref.split('.') : [];
    if (parts.length !== 2 || !parts.every(part => identifier.test(part))) throw Error('Invalid node.port reference.');
    const [id, port] = parts, node = nodes.get(id), module = moduleSpec(node?.type);
    const ports = module ? direction === 'from' ? module.outputs || ['out'] : Object.keys(module.inputs) : [];
    if (!ports.includes(port)) throw Error(`Unknown ${direction === 'from' ? 'output' : 'input'} port: ${ref}.`);
    return id;
  }
  const connections = project.connections ?? [];
  if (!Array.isArray(connections)) throw Error('Connections must be an array.');
  const occupied = new Set(), outgoing = new Map(), incoming = new Map();
  for (const id of nodes.keys()) { outgoing.set(id, []); incoming.set(id, 0); }
  for (const connection of connections) {
    if (!object(connection)) throw Error('Invalid connection.');
    const from = endpoint(connection.from, 'from'), to = endpoint(connection.to, 'to');
    if (occupied.has(connection.to)) throw Error(`Input ${connection.to} is already occupied.`);
    occupied.add(connection.to);
    outgoing.get(from).push(to); incoming.set(to, incoming.get(to) + 1);
  }
  if (!object(project.output)) throw Error('Output must be an object.');
  for (const channel of ['left', 'right']) endpoint(project.output[channel], 'from');
  // Iterative topological traversal also handles parallel dependencies and long drafts.
  const ready = [...nodes.keys()].filter(id => incoming.get(id) === 0);
  for (let i = 0; i < ready.length; i++) {
    for (const to of outgoing.get(ready[i])) {
      incoming.set(to, incoming.get(to) - 1);
      if (incoming.get(to) === 0) ready.push(to);
    }
  }
  if (ready.length !== nodes.size) throw Error('Reconnection would create a graph cycle.');
}

/** Reconnect exactly one selected cable end, retaining fan-out and stereo routing. */
export function reconnectProject(project, change) {
  requireProject(project);
  if (!object(change) || !['from', 'to'].includes(change.end)) throw Error('Select a cable end.');
  const candidate = structuredClone(project);
  if (own(change, 'outputChannel')) {
    if (own(change, 'connectionIndex') || !['left', 'right'].includes(change.outputChannel) || change.end !== 'from') {
      throw Error('An output cable has a fixed destination; select its left or right source.');
    }
    if (!object(candidate.output)) throw Error('Output must be an object.');
    candidate.output[change.outputChannel] = change.ref;
  } else {
    const index = change.connectionIndex;
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(candidate.connections) || index >= candidate.connections.length || !object(candidate.connections[index])) {
      throw Error('The selected connection no longer exists.');
    }
    candidate.connections[index][change.end] = change.ref;
  }
  validateRoutes(candidate);
  return candidate;
}
