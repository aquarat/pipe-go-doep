import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayout, setWindow, restoreQueue, pruneLayout } from './workspace-layout.js';

test('windows open, move and close without mutating the previous layout', () => {
  const a = setWindow({}, 'modules', 'lead', { left: 10.4, top: 20, width: 360, height: 500 });
  const b = setWindow(a, 'panes', 'rack', { left: -1900, top: 0, width: 1200, height: 850 });
  const c = setWindow(b, 'modules', 'lead', { left: 30, top: 40, width: 50, height: 99999 });
  assert.deepEqual(a, { panes: {}, modules: { lead: { left: 10, top: 20, width: 360, height: 500 } } });
  assert.deepEqual(c.modules.lead, { left: 30, top: 40, width: 200, height: 8000 });
  assert.deepEqual(c.panes.rack, { left: -1900, top: 0, width: 1200, height: 850 });
  assert.deepEqual(setWindow(c, 'modules', 'lead', null).modules, {});
  // Geometry-less updates keep the last known geometry.
  assert.deepEqual(setWindow(c, 'modules', 'lead', {}).modules.lead, c.modules.lead);
  assert.throws(() => setWindow(c, 'tabs', 'x', null));
});

test('restore queue skips missing targets and tolerates damaged storage', () => {
  const layout = normalizeLayout({ panes: { rack: { width: 900, height: 700 }, gone: {} }, modules: { lead: 'bad', $scope: { left: 'x', width: 800, height: 600 } }, extra: 1 });
  assert.deepEqual(restoreQueue(layout, { panes: ['rack'], modules: ['lead', '$scope'] }), [
    { kind: 'panes', id: 'rack', geometry: { left: null, top: null, width: 900, height: 700 } },
    { kind: 'modules', id: 'lead', geometry: undefined },
    { kind: 'modules', id: '$scope', geometry: { left: null, top: null, width: 800, height: 600 } },
  ]);
  assert.deepEqual(pruneLayout(layout, { panes: ['rack'], modules: [] }), { panes: { rack: layout.panes.rack }, modules: {} });
  assert.deepEqual(normalizeLayout(null), { panes: {}, modules: {} });
});
