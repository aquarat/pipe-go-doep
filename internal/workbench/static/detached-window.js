// A same-origin child window that shares the opener's stylesheets but runs no
// scripts of its own. Callers put real opener-owned nodes into `content`.
export const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1200, height: 850 });
const RESIZE_DEBOUNCE_MS = 200;
const POSITION_POLL_MS = 1000;

// { left, top, width, height } in CSS px (screenX/screenY, innerWidth/innerHeight).
// Returns null when unusable. left/top are optional.
export function normalizeGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const width = Math.round(Number(geometry.width)), height = Math.round(Number(geometry.height));
  if (!(width > 0 && height > 0)) return null;
  const result = { width: Math.max(160, width), height: Math.max(120, height) };
  const left = Number(geometry.left), top = Number(geometry.top);
  if (geometry.left != null && geometry.top != null && Number.isFinite(left) && Number.isFinite(top)) {
    return { left: Math.round(left), top: Math.round(top), ...result };
  }
  return result;
}

export function windowFeatures(geometry, defaultSize = DEFAULT_WINDOW_SIZE) {
  const size = normalizeGeometry(geometry) || normalizeGeometry(defaultSize) || DEFAULT_WINDOW_SIZE;
  const features = ['popup=yes', 'resizable=yes', 'scrollbars=yes'];
  if (size.left != null) features.push(`left=${size.left}`, `top=${size.top}`);
  features.push(`width=${size.width}`, `height=${size.height}`);
  return features.join(',');
}

const sameGeometry = (a, b) => !!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

// Must run synchronously inside a user gesture. Returns null when the browser
// blocks the pop-up (or it could not be prepared; that is reported via onError).
export function openDetachedWindow({
  opener = globalThis.window, title = '', bodyClass = '', geometry = null, defaultSize = DEFAULT_WINDOW_SIZE,
  onClose = () => {}, onGeometry = () => {}, onLayout = () => {}, onError = () => {},
} = {}) {
  const report = error => { try { onError(error instanceof Error ? error.message : String(error)); } catch { /* Reporting must not throw. */ } };
  const notify = (callback, ...args) => { try { callback(...args); } catch (error) { report(error); } };
  const label = title || 'window';
  const requested = normalizeGeometry(geometry);
  let child;
  try { child = opener.open('', '_blank', windowFeatures(geometry, defaultSize)); }
  catch (error) { report(`Could not open ${label}: ${error.message}`); return null; }
  if (!child) return null;

  const removers = [];
  let closed = false, frame = 0, debounce = 0, poll = 0, last = null;
  const listen = (target, type, action, options) => {
    target.addEventListener(type, action, options);
    removers.push(() => target.removeEventListener(type, action, options));
  };
  const read = () => {
    try {
      if (child.closed) return null;
      const current = { left: child.screenX, top: child.screenY, width: child.innerWidth, height: child.innerHeight };
      return current.width > 0 && current.height > 0 ? current : null;
    } catch { return null; }
  };
  const currentGeometry = () => ({ ...(read() || last || requested || normalizeGeometry(defaultSize) || DEFAULT_WINDOW_SIZE) });
  const reportGeometry = () => {
    if (closed) return;
    const current = read();
    if (!current || sameGeometry(current, last)) return;
    last = current;
    notify(onGeometry, { ...current });
  };
  const queueLayout = () => {
    if (closed || frame) return;
    try { frame = child.requestAnimationFrame(() => { frame = 0; if (!closed) notify(onLayout); }); }
    catch { frame = 0; }
  };

  function finish(reason) {
    if (closed) return;
    reportGeometry();
    closed = true;
    removers.splice(0).forEach(remove => remove());
    opener.clearTimeout(debounce); opener.clearInterval(poll);
    if (frame) { try { child.cancelAnimationFrame(frame); } catch { /* Window already gone. */ } frame = 0; }
    // Callers move their nodes out while the child document is still alive.
    notify(onClose, reason);
    if (!child.closed) child.close();
  }

  let doc, header, heading, actions, content;
  try {
    const source = opener.document;
    doc = child.document;
    doc.title = title ? `${title} — Pipe Go Doep` : 'Pipe Go Doep';
    doc.documentElement.lang = source.documentElement.lang || 'en';
    doc.documentElement.className = source.documentElement.className;
    doc.body.className = [source.body.className, 'detached-window', bodyClass].filter(Boolean).join(' ');
    const viewport = doc.createElement('meta');
    viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1';
    doc.head.append(viewport);
    // Copy styles only, never scripts, app state or project HTML.
    const styles = [];
    for (const style of source.querySelectorAll('link[rel~="stylesheet"], style')) {
      const copy = doc.importNode(style, true);
      if (style.tagName === 'LINK') {
        copy.href = style.href;
        styles.push(new Promise(resolve => {
          listen(copy, 'load', resolve);
          listen(copy, 'error', () => { report(`Could not load pop-out stylesheet: ${copy.href}`); resolve(); });
        }));
      }
      doc.head.append(copy);
    }
    header = doc.createElement('header'); header.className = 'detached-window-header';
    heading = doc.createElement('h1'); heading.className = 'detached-window-title'; heading.textContent = title;
    actions = doc.createElement('div'); actions.className = 'detached-window-actions';
    content = doc.createElement('main'); content.className = 'detached-window-content';
    header.append(heading, actions);
    doc.body.append(header, content);

    listen(child, 'pagehide', () => finish('user'));
    listen(child, 'beforeunload', () => finish('user'));
    listen(child, 'resize', () => {
      queueLayout();
      opener.clearTimeout(debounce);
      debounce = opener.setTimeout(reportGeometry, RESIZE_DEBOUNCE_MS);
    });
    // Capture runs before the app's own unload listeners on the same window.
    listen(opener, 'pagehide', () => finish('opener'), { capture: true });
    listen(opener, 'beforeunload', () => finish('opener'), { capture: true });
    // There is no move event; poll position and notice closes that skipped pagehide.
    poll = opener.setInterval(() => { if (child.closed) finish('user'); else reportGeometry(); }, POSITION_POLL_MS);
    Promise.all(styles).then(() => { if (!closed) notify(onLayout); });
    last = read();
  } catch (error) {
    closed = true;
    removers.splice(0).forEach(remove => remove());
    opener.clearInterval(poll);
    try { child.close(); } catch { /* Ignore. */ }
    report(`Could not open ${label}: ${error.message}`);
    return null;
  }

  return {
    window: child, document: doc, header, title: heading, actions, content,
    get closed() { return closed; },
    geometry: currentGeometry,
    close() { finish('api'); },
    focus() { if (!closed && !child.closed) child.focus(); },
  };
}
