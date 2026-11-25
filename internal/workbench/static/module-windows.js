import { openDetachedWindow } from './detached-window.js';

export const SCOPE_MODULE_ID = '$scope';
const MODULE_SIZE = Object.freeze({ width: 420, height: 560 });
const SCOPE_SIZE = Object.freeze({ width: 800, height: 600 });

// Rack module windows: the app renders a module's faceplate into the host
// element this returns. Always opened by the main window.
export function createModuleWindows({ opener = globalThis.window, onChange = () => {}, onLayout = () => {}, onError = () => {} } = {}) {
  const records = new Map();
  let destroyed = false;
  const report = error => { try { onError(error instanceof Error ? error.message : String(error)); } catch { /* Ignore. */ } };
  const notify = (callback, ...args) => { try { callback(...args); } catch (error) { report(error); } };

  // reason: 'api' (dock or Pop in), 'user' (window closed), 'opener' (main page unloading).
  function close(id, reason) {
    const record = records.get(id);
    if (!record) return false;
    records.delete(id);
    const geometry = record.handle.geometry();
    record.removers.splice(0).forEach(remove => remove());
    // Re-render in the rack while the child document is still alive, then close.
    notify(onChange, id, false, geometry, reason);
    record.handle.close();
    return true;
  }

  function popOut(id, { title = id, geometry = null } = {}) {
    if (destroyed || typeof id !== 'string' || !id) return null;
    const existing = records.get(id);
    if (existing) { existing.handle.focus(); return existing.host; }
    let opening = true, failed = false, handle = null;
    const current = () => handle && records.get(id)?.handle === handle;
    handle = openDetachedWindow({
      opener, title, bodyClass: 'module-window', geometry,
      defaultSize: id === SCOPE_MODULE_ID ? SCOPE_SIZE : MODULE_SIZE,
      onClose: reason => { if (current()) close(id, reason); },
      onGeometry: next => { if (current()) notify(onChange, id, true, next); },
      onLayout: () => { if (current()) notify(onLayout, id); },
      onError: message => { if (opening) failed = true; report(message); },
    });
    opening = false;
    if (!handle) {
      if (!failed) report(`Pop-up blocked. Allow pop-ups for this site to pop out ${title}.`);
      return null;
    }
    const removers = [];
    const doc = handle.document, host = handle.content;
    host.classList.add('module-window-host');
    host.dataset.module = id;
    host.setAttribute('aria-label', title);
    const popIn = doc.createElement('button');
    popIn.type = 'button'; popIn.className = 'detached-window-button module-window-pop-in';
    popIn.textContent = 'Pop in'; popIn.title = `Pop in ${title}`; popIn.setAttribute('aria-label', `Pop in ${title}`);
    const click = event => { event.preventDefault(); dock(id); };
    popIn.addEventListener('click', click);
    removers.push(() => popIn.removeEventListener('click', click));
    handle.actions.append(popIn);
    records.set(id, { id, title, handle, host, removers });
    notify(onChange, id, true, handle.geometry());
    handle.focus();
    return host;
  }

  const dock = id => close(id, 'api');
  const dockAll = () => { for (const id of [...records.keys()]) dock(id); };

  return {
    popOut, dock, dockAll,
    focus(id) { const record = records.get(id); if (!record) return false; record.handle.focus(); return true; },
    host: id => records.get(id)?.host || null,
    ids: () => [...records.keys()],
    isOpen: id => records.has(id),
    geometry: id => records.get(id)?.handle.geometry() || null,
    destroy() { if (destroyed) return; dockAll(); destroyed = true; },
  };
}
