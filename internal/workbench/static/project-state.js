// UI identity, JSON Pointer addressing and browser-local project state.
export const STORAGE_PREFIX = 'pipe-go-doep.project.v2.';
export const LAST_PROJECT_KEY = 'pipe-go-doep.last-project.v2';
export const LEGACY_DRAFT_KEY = 'pipe-go-doep.score.v1';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newUUID() {
  // getRandomValues works on LAN HTTP, where randomUUID may be unavailable.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function prepareProject(value, fallbackID) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('A project must be a JSON object.');
  if (!value.id) value.id = UUID.test(fallbackID || '') ? fallbackID : newUUID();
  if (!UUID.test(value.id)) throw Error('Project id must be a UUID.');
  value.id = value.id.toLowerCase();
  if (!value._ui) value._ui = { tree_expanded: [] };
  if (typeof value._ui !== 'object' || Array.isArray(value._ui)) throw Error('_ui must be an object.');
  if (!value._ui.tree_expanded) value._ui.tree_expanded = [];
  if (!Array.isArray(value._ui.tree_expanded) || value._ui.tree_expanded.some(p => typeof p !== 'string')) {
    throw Error('_ui.tree_expanded must be an array of JSON Pointer strings.');
  }
  if (value._ui.tree_expanded.length > 4096) throw Error('Tree state exceeds 4096 expanded branches.');
  const seen = new Set();
  for (const path of value._ui.tree_expanded) {
    pointerParts(path);
    if (new TextEncoder().encode(path).length > 1024 || seen.has(path)) throw Error('Tree state contains an oversized or duplicate path.');
    seen.add(path);
  }
  return value;
}

export function escapePointer(part) { return String(part).replace(/~/g, '~0').replace(/\//g, '~1'); }
export function pointerParts(path) {
  if (path === '') return [];
  if (typeof path !== 'string' || !path.startsWith('/') || /~(?:[^01]|$)/.test(path)) throw Error('Invalid JSON Pointer.');
  return path.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}
export function atPointer(project, path) {
  return pointerParts(path).reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, project);
}
export function setPointer(project, path, value) {
  const keys = pointerParts(path);
  if (!keys.length) throw Error('Use the source editor to replace the whole project.');
  let parent = project;
  for (const key of keys.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw Error('The selected field no longer exists.');
    parent = parent[key];
  }
  const key = keys.at(-1);
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw Error('The selected field no longer exists.');
  // defineProperty preserves own JSON keys such as __proto__ without invoking a setter.
  Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
}

export function soundSignature(project) {
  const { id, _ui, title, ...sound } = project;
  return JSON.stringify(sound);
}

export function readProjectState(storage, id) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_PREFIX + id) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function storeProjectState(storage, id, value) {
  storage.setItem(STORAGE_PREFIX + id, JSON.stringify(value));
  storage.setItem(LAST_PROJECT_KEY, id);
}

export function listSavedProjects(storage) {
  const projects = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const id = key.slice(STORAGE_PREFIX.length), state = readProjectState(storage, id);
    if (UUID.test(id) && typeof state.draft === 'string') projects.push({ id, title: state.title || 'Untitled project', updated: state.updated || 0 });
  }
  return projects.sort((a, b) => b.updated - a.updated);
}
