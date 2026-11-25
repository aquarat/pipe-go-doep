// Pop-out window layout per project: which panes/modules are detached and where.
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const KINDS = ['panes', 'modules'];

export function normalizeGeometry(value) {
  const g = object(value), whole = n => Number.isFinite(n) ? Math.round(n) : null;
  const left = whole(g.left), top = whole(g.top), width = whole(g.width), height = whole(g.height);
  if (width === null || height === null) return null;
  return {
    left: left === null ? null : Math.max(-20000, Math.min(20000, left)),
    top: top === null ? null : Math.max(-20000, Math.min(20000, top)),
    width: Math.max(200, Math.min(8000, width)), height: Math.max(150, Math.min(8000, height)),
  };
}

export function normalizeLayout(value) {
  const layout = { panes: {}, modules: {} };
  for (const kind of KINDS) {
    for (const [id, geometry] of Object.entries(object(object(value)[kind]))) {
      // A detached window without known geometry still restores at a default size.
      layout[kind][id] = normalizeGeometry(geometry) || {};
    }
  }
  return layout;
}

/** Returns a new layout with a window opened/moved (geometry) or closed (null). */
export function setWindow(layout, kind, id, geometry) {
  if (!KINDS.includes(kind)) throw Error(`Unknown window kind ${kind}.`);
  const next = normalizeLayout(layout);
  if (geometry === null) delete next[kind][id];
  else next[kind][id] = normalizeGeometry(geometry) || next[kind][id] || {};
  return next;
}

/** Windows to reopen, dropping modules/panes that no longer exist. */
export function restoreQueue(layout, { panes = [], modules = [] } = {}) {
  const valid = { panes: new Set(panes), modules: new Set(modules) };
  const normal = normalizeLayout(layout);
  return KINDS.flatMap(kind => Object.entries(normal[kind])
    .filter(([id]) => valid[kind].has(id))
    .map(([id, geometry]) => ({ kind, id, geometry: Object.keys(geometry).length ? geometry : undefined })));
}

/** Layout with entries for vanished modules/panes removed. */
export function pruneLayout(layout, existing) {
  const keep = restoreQueue(layout, existing), next = { panes: {}, modules: {} };
  for (const { kind, id, geometry } of keep) next[kind][id] = geometry || {};
  return next;
}
