import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, parameterSpec, materializeDefaults, editParameter, reconnectProject } from './rack-model.js';

// Independent constructor contract fixtures from docs/modules.md and dsp.New.
// Each tuple is [default, min, max, integer?] at 8000 Hz.
const signal = [0, -1000000, 1000000], gate = [0, 0, 1];
const oscillator = { freq: [440, 0, 3600], reset: gate };
const constructors = {
  sequence: {},
  constant: { value: signal },
  sine: oscillator, triangle: oscillator, saw: oscillator,
  pulse: { ...oscillator, duty: [0.5, 0.01, 0.99] },
  wavetable: { ...oscillator, bits: [4, 1, 16, true] },
  noise: { freq: [8000, 0, 8000], reset: gate, short: [0, 0, 1, true] },
  adsr: { gate, trigger: gate, attack: [0.01, 0, 60], decay: [0.1, 0, 60], sustain: [0.7, 0, 1], release: [0.2, 0, 60] },
  vca: { in: signal, gain: [1, -16, 16] },
  mixer: { a: signal, b: signal, c: signal, d: signal, gain_a: [1, -16, 16], gain_b: [1, -16, 16], gain_c: [1, -16, 16], gain_d: [1, -16, 16] },
  pan: { in: signal, pan: [0, -1, 1] },
  lowpass: { in: signal, cutoff: [2000, 1, 3600] },
  delay: { in: signal, time: [0.25, 0, 2], feedback: [0.3, -0.99, 0.99], mix: [0.25, 0, 1] },
  drive: { in: signal, amount: [2, 0, 100] },
  bitcrush: { in: signal, bits: [8, 1, 16], rate: [8000, 0, 8000] },
};

test('every exported control matches DSP constructor defaults and inclusive bounds', () => {
  assert.deepEqual(Object.keys(MODULES).sort(), Object.keys(constructors).sort());
  for (const [type, params] of Object.entries(constructors)) {
    assert.deepEqual(Object.keys({ ...MODULES[type].inputs, ...MODULES[type].params }).sort(), Object.keys(params).sort());
    for (const [name, [value, min, max, integer = false]] of Object.entries(params)) {
      const spec = parameterSpec(type, name, 8000);
      assert.deepEqual(Object.keys(spec).sort(), ['default', 'integer', 'log', 'max', 'min', 'step']);
      assert.deepEqual([spec.default, spec.min, spec.max, spec.integer], [value, min, max, integer], `${type}.${name}`);
      assert.ok(Number.isFinite(spec.step) && spec.step > 0 && spec.step <= max - min);
      assert.equal(typeof spec.log, 'boolean');
      const project = { sample_rate: 8000, nodes: [{ id: 'node', type }] };
      for (const accepted of [min, max, value]) {
        assert.equal(editParameter(project, { nodeIndex: 0, name, value: accepted }).nodes[0].params[name], accepted);
      }
      for (const rejected of [min - 0.001, max + 0.001, NaN, Infinity, -Infinity, String(value), null]) {
        assert.throws(() => editParameter(project, { nodeIndex: 0, name, value: rejected }), undefined, `${type}.${name}: ${rejected}`);
      }
      assert.equal(project.nodes[0].params, undefined);
    }
  }
});

test('sample-rate dependent bounds and unknown/prototype names', () => {
  for (const sr of [8000, 44100, 48000, 96000]) {
    for (const type of ['sine', 'pulse', 'triangle', 'saw', 'wavetable']) assert.equal(parameterSpec(type, 'freq', sr).max, sr * 0.45);
    assert.equal(parameterSpec('lowpass', 'cutoff', sr).max, sr * 0.45);
    assert.equal(parameterSpec('noise', 'freq', sr).max, sr);
    assert.equal(parameterSpec('bitcrush', 'rate', sr).max, sr);
  }
  for (const sr of [7999, 96001, 8000.5, '48000', null, NaN, Infinity]) assert.equal(parameterSpec('sine', 'freq', sr), null);
  for (const [type, name] of [['sine', 'gain'], ['sequence', 'freq'], ['missing', 'value'], ['__proto__', 'value'], ['sine', 'constructor'], ['sine', 'toString'], ['output', 'in']]) {
    assert.equal(parameterSpec(type, name, 48000), null);
  }
  assert.deepEqual(parameterSpec('output', 'gain', 48000), { min: 0, max: 16, default: 0, integer: false, step: 0.01, log: false });
});

test('integer static controls differ from continuous bitcrush and gate inputs', () => {
  for (const [type, name, value] of [['wavetable', 'bits', 4.5], ['noise', 'short', 0.5]]) {
    assert.throws(() => editParameter({ nodes: [{ type }] }, { nodeIndex: 0, name, value }), /integer/);
  }
  for (const [type, name, value] of [['bitcrush', 'bits', 4.5], ['sine', 'reset', 0.5], ['adsr', 'gate', 0.5]]) {
    assert.equal(editParameter({ nodes: [{ type }] }, { nodeIndex: 0, name, value }).nodes[0].params[name], value);
  }
});

test('materialization completes all constructor defaults and is idempotent', () => {
  const project = { sample_rate: 8000, nodes: Object.keys(constructors).map(type => ({ id: type, type })), output: { left: 'pan.left', right: 'pan.right' } };
  assert.equal(materializeDefaults(project), true);
  for (const node of project.nodes) {
    assert.deepEqual(node.params || {}, Object.fromEntries(Object.entries(constructors[node.type]).map(([name, [value]]) => [name, value])), node.type);
  }
  assert.deepEqual(project.output, { left: 'pan.left', right: 'pan.right', gain: 0 });
  assert.equal(materializeDefaults(project), false);
});

test('materialization preserves zero, explicit invalid values, unknown nodes and metadata', () => {
  const unknown = { type: 'future', params: { frequency: 12 }, arbitrary: [1, 2] };
  const project = { nodes: [
    { type: 'mixer', params: { gain_a: 0, gain_b: -2, custom: 8 } },
    { type: 'adsr', params: { attack: 0, sustain: 0, release: null } },
    { type: 'sine', params: { freq: 'invalid', reset: 0 } },
    unknown,
    { type: 'vca', params: null },
    { type: 'noise', params: [] },
    null,
  ], output: { gain: 0 }, _ui: { selected: 'x' } };
  materializeDefaults(project);
  assert.deepEqual(project.nodes[0].params, { gain_a: 0, gain_b: -2, custom: 8, a: 0, b: 0, c: 0, d: 0, gain_c: 1, gain_d: 1 });
  assert.deepEqual(project.nodes[1].params, { attack: 0, sustain: 0, release: null, gate: 0, trigger: 0, decay: 0.1 });
  assert.deepEqual(project.nodes[2].params, { freq: 'invalid', reset: 0 });
  assert.equal(project.nodes[3], unknown);
  assert.deepEqual(unknown, { type: 'future', params: { frequency: 12 }, arbitrary: [1, 2] });
  assert.deepEqual(project.nodes[4].params, { in: 0, gain: 1 });
  assert.deepEqual(project.nodes[5].params, []);
  assert.equal(project.output.gain, 0);
  assert.deepEqual(project._ui, { selected: 'x' });
  for (const gain of [0.75, null, 'invalid']) {
    const p = { output: { gain } }; materializeDefaults(p); assert.equal(p.output.gain, gain);
  }
  assert.equal(materializeDefaults(null), false);
});

function patch() {
  return {
    sample_rate: 48000,
    nodes: [{ id: 'osc', type: 'sine' }, { id: 'other', type: 'pulse' }, { id: 'amp', type: 'vca' }, { id: 'mix', type: 'mixer' }, { id: 'pan', type: 'pan' }, { id: 'seq', type: 'sequence', track: 'lead' }],
    connections: [{ from: 'osc.out', to: 'amp.in' }, { from: 'osc.out', to: 'mix.a' }, { from: 'amp.out', to: 'mix.b' }, { from: 'mix.out', to: 'pan.in' }],
    output: { left: 'pan.left', right: 'pan.right', gain: 0.5 },
    _ui: { panes: { rack: true } },
  };
}

test('parameter edits clone the complete candidate and only edit the selected control', () => {
  const project = patch(), original = structuredClone(project);
  const candidate = editParameter(project, { nodeIndex: 0, name: 'freq', value: 220 });
  assert.deepEqual(project, original);
  const expected = structuredClone(project); expected.nodes[0].params = { freq: 220 };
  assert.deepEqual(candidate, expected);
  candidate._ui.panes.rack = false; candidate.connections[0].from = 'other.out';
  assert.deepEqual(project, original);
  assert.equal(editParameter(project, { nodeIndex: null, name: 'gain', value: 0 }).output.gain, 0);
  for (const value of [-1, 17, Infinity, '1']) assert.throws(() => editParameter(project, { nodeIndex: null, name: 'gain', value }));
  for (const nodeIndex of [undefined, -1, 1.5, '0', 6, NaN]) assert.throws(() => editParameter(project, { nodeIndex, name: 'freq', value: 440 }));
  for (const name of ['__proto__', 'out', 'not_a_parameter']) assert.throws(() => editParameter(project, { nodeIndex: 0, name, value: 0 }));
  assert.throws(() => editParameter({ nodes: [{ type: 'output' }] }, { nodeIndex: 0, name: 'gain', value: 1 }));
});

test('source fan-out reconnection changes exactly the indexed route', () => {
  const project = patch(), original = structuredClone(project);
  const candidate = reconnectProject(project, { connectionIndex: 1, end: 'from', ref: 'other.out' });
  const expected = structuredClone(original); expected.connections[1].from = 'other.out';
  assert.deepEqual(candidate, expected);
  assert.deepEqual(project, original);
  candidate.nodes[0].id = 'changed'; candidate._ui.panes.rack = false;
  assert.deepEqual(project, original);
});

test('destination rewiring preserves other wires and rejects occupied inputs', () => {
  const project = patch(), original = structuredClone(project);
  const candidate = reconnectProject(project, { connectionIndex: 1, end: 'to', ref: 'mix.c' });
  const expected = structuredClone(project); expected.connections[1].to = 'mix.c';
  assert.deepEqual(candidate, expected);
  assert.throws(() => reconnectProject(project, { connectionIndex: 1, end: 'to', ref: 'mix.b' }), /occupied/);
  assert.deepEqual(reconnectProject(project, { connectionIndex: 1, end: 'to', ref: 'mix.a' }), project);
  assert.deepEqual(project, original);
});

test('cycles are rejected for either end, including self edges and delay feedback', () => {
  const project = patch(), original = structuredClone(project);
  assert.throws(() => reconnectProject(project, { connectionIndex: 0, end: 'from', ref: 'mix.out' }), /cycle/);
  assert.throws(() => reconnectProject(project, { connectionIndex: 3, end: 'to', ref: 'amp.gain' }), /cycle/);
  assert.throws(() => reconnectProject(project, { connectionIndex: 0, end: 'from', ref: 'amp.out' }), /cycle/);
  project.nodes[2].type = 'delay';
  assert.throws(() => reconnectProject(project, { connectionIndex: 0, end: 'from', ref: 'amp.out' }), /cycle/);
  project.nodes[2].type = 'vca'; assert.deepEqual(project, original);
});

test('stereo output sources are independent and permit shared sources', () => {
  const project = patch(), original = structuredClone(project);
  const candidate = reconnectProject(project, { outputChannel: 'left', end: 'from', ref: 'pan.right' });
  const expected = structuredClone(project); expected.output.left = 'pan.right';
  assert.deepEqual(candidate, expected);
  assert.equal(reconnectProject(project, { outputChannel: 'right', end: 'from', ref: 'seq.velocity' }).output.right, 'seq.velocity');
  assert.throws(() => reconnectProject(project, { outputChannel: 'right', end: 'to', ref: 'osc.out' }));
  assert.throws(() => reconnectProject(project, { outputChannel: 'center', end: 'from', ref: 'osc.out' }));
  assert.throws(() => reconnectProject(project, { outputChannel: 'left', connectionIndex: 0, end: 'from', ref: 'osc.out' }));
  assert.deepEqual(project, original);
});

test('actual port directions, strict references and ambiguous IDs are validated', () => {
  const project = patch(), original = structuredClone(project);
  for (const ref of ['osc.freq', 'pan.out', 'seq.out', 'missing.out', 'osc.out.extra', ' osc.out', 'osc.out\n', '__proto__.out', null, 1]) {
    assert.throws(() => reconnectProject(project, { connectionIndex: 0, end: 'from', ref }), undefined, String(ref));
    assert.throws(() => reconnectProject(project, { outputChannel: 'left', end: 'from', ref }), undefined, String(ref));
  }
  for (const ref of ['amp.out', 'mix.gain_a', 'seq.freq', 'pan.left', 'pan.right']) {
    assert.throws(() => reconnectProject(project, { connectionIndex: 0, end: 'to', ref }), /input/);
  }
  for (const connectionIndex of [undefined, -1, 4, '0', 0.5, NaN]) assert.throws(() => reconnectProject(project, { connectionIndex, end: 'from', ref: 'other.out' }));
  assert.deepEqual(project, original);
  project.nodes.push({ id: 'osc', type: 'sine' });
  assert.throws(() => reconnectProject(project, { connectionIndex: 0, end: 'from', ref: 'other.out' }), /duplicate/);
});

test('node identifiers use the same length, character and end rules as the score schema', () => {
  for (const id of ['osc\n', '1osc', 'a.b', 'a/b', 'a'.repeat(65), '']) {
    const project = patch(); project.nodes[1].id = id;
    assert.throws(() => reconnectProject(project, { connectionIndex: 0, end: 'from', ref: `${id}.out` }), /id/);
  }
  for (const id of ['_source-2', 'a'.repeat(64), '__proto__', 'constructor']) {
    const project = patch(); project.nodes[1].id = id;
    assert.equal(reconnectProject(project, { connectionIndex: 0, end: 'from', ref: `${id}.out` }).connections[0].from, `${id}.out`);
  }
});
