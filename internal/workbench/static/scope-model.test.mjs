import test from 'node:test';
import assert from 'node:assert/strict';
import { probeList, probeLabels, setProbe, setScopeMode, scopeState } from './scope-model.js';

const project = {
  nodes: [{ id: 'lead', type: 'pulse' }, { id: 'mix', type: 'mixer' }],
  _ui: { tree_expanded: ['/nodes'] },
};

test('probes patch, relabel and unplug without touching sound fields or the original', () => {
  const a = setProbe(project, 'y1', { node: 'lead', port: 'out', direction: 'output' });
  const b = setProbe(a, 'x', { bus: 'left' });
  assert.equal(project._ui.scope, undefined);
  assert.deepEqual(b._ui.tree_expanded, ['/nodes']);
  assert.equal(b.nodes, project.nodes);
  assert.deepEqual(probeList(b), [{ channel: 'x', bus: 'left' }, { channel: 'y1', node: 'lead', port: 'out', direction: 'output' }]);
  assert.deepEqual(probeLabels(b), { x: 'L [Stereo output]', y1: 'out lead [Pulse oscillator]' });
  const c = setProbe(b, 'y1', null);
  assert.deepEqual(probeList(c), [{ channel: 'x', bus: 'left' }]);
  assert.equal(scopeState(setScopeMode(c, 'xy')).mode, 'xy');
  assert.deepEqual(scopeState(setScopeMode(c, 'xy')).inputs, { x: { bus: 'left' } });
});

test('dangling and malformed references are handled safely', () => {
  const dangling = setProbe(project, 'y2', { node: 'gone', port: 'out', direction: 'output' });
  assert.equal(probeLabels(dangling).y2, 'out gone [missing module]');
  assert.equal(probeList({ _ui: { scope: { inputs: { y3: { node: 'lead' }, z: { bus: 'left' } } } } }).length, 0);
  assert.throws(() => setProbe(project, 'y5', { bus: 'left' }));
  assert.throws(() => setProbe(project, 'y1', { bus: 'centre' }));
  assert.throws(() => setScopeMode(project, 'polar'));
});
