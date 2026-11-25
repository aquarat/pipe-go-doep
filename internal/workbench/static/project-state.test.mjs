import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProject, UUID, escapePointer, atPointer, setPointer, soundSignature, storeProjectState, readProjectState, listSavedProjects } from './project-state.js';

test('legacy identity and metadata round trip without changing sound', () => {
  const old = { version: 1, title: 'test', nodes: [], seed: 42 };
  const before = soundSignature(old), project = prepareProject(structuredClone(old));
  assert.match(project.id, UUID); assert.deepEqual(project._ui.tree_expanded, []);
  assert.equal(soundSignature(project), before);
  project._ui.tree_expanded.push('', '/nodes');
  const reopened = prepareProject(JSON.parse(JSON.stringify(project)));
  assert.equal(reopened.id, project.id); assert.deepEqual(reopened._ui.tree_expanded, ['', '/nodes']);
  assert.equal(soundSignature(reopened), before);
});

test('JSON Pointer escaping and prototype keys remain ordinary data', () => {
  const p = JSON.parse('{"a/b":{"~key":2},"__proto__":{"safe":3}}');
  assert.equal(escapePointer('a/b~'), 'a~1b~0');
  assert.equal(atPointer(p, '/a~1b/~0key'), 2);
  setPointer(p, '/a~1b/~0key', 4); assert.equal(p['a/b']['~key'], 4);
  setPointer(p, '/__proto__/safe', 5); assert.equal(p.__proto__.safe, 5);
  assert.equal({}.safe, undefined);
  assert.throws(() => setPointer(p, '/constructor/prototype/x', 1));
});

test('browser state is isolated by project UUID', () => {
  const data = new Map(), storage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), key: i => [...data.keys()][i], get length() { return data.size; } };
  const a = prepareProject({}).id, b = prepareProject({}).id;
  storeProjectState(storage, a, { title: 'A', draft: '{}', panes: { json: true } });
  storeProjectState(storage, b, { title: 'B', draft: '{}', panes: { json: false } });
  assert.equal(readProjectState(storage, a).panes.json, true);
  assert.equal(readProjectState(storage, b).panes.json, false);
  assert.equal(listSavedProjects(storage).length, 2);
});
