import { openDetachedWindow } from './detached-window.js';

// One app, several documents: adopt the real nodes, never clone a component.
export function createPaneWindows({ panes, onLayout = () => {}, onError = () => {}, onChange = () => {} }) {
  const records = new Map();
  const cleanup = [];
  let destroyed = false;
  const report = error => onError(error instanceof Error ? error.message : String(error));
  const notify = (callback, ...args) => { try { callback(...args); } catch (error) { report(error); } };
  const listen = (target, type, action, removers) => {
    target.addEventListener(type, action);
    removers.push(() => target.removeEventListener(type, action));
  };
  const element = (doc, tag, className, text) => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (doc, text, label, action, removers) => {
    const node = element(doc, 'button', 'pane-window-button', text);
    node.type = 'button'; node.setAttribute('aria-label', label); node.title = label;
    listen(node, 'click', event => { event.preventDefault(); event.stopPropagation(); action(); }, removers);
    // Keep keyboard activation native, but do not let summary handlers toggle.
    for (const type of ['keydown', 'keyup']) listen(node, type, event => event.stopPropagation(), removers);
    return node;
  };

  function updateButton(record) {
    const text = record.handle ? 'Pop in' : 'Pop out';
    record.control.textContent = text;
    record.control.setAttribute('aria-label', `${text} ${record.title}`);
    record.control.title = `${text} ${record.title}`;
    record.pane.classList.toggle('pane-is-detached', !!record.handle);
  }

  function queueLayout(record) {
    const host = record.handle?.window || record.parent;
    if (record.frame || host.closed || destroyed) return;
    record.frameHost = host;
    record.frame = host.requestAnimationFrame(() => {
      record.frame = 0;
      if (!destroyed) notify(onLayout, record.name);
    });
  }

  function cancelLayout(record) {
    if (record.frame) { try { record.frameHost.cancelAnimationFrame(record.frame); } catch { /* Window already gone. */ } }
    record.frame = 0;
  }

  function mediaState(nodes) {
    return nodes.flatMap(node => node.nodeType === 1 ? [
      ...(node.matches('audio,video') ? [node] : []), ...node.querySelectorAll('audio,video'),
    ] : []).map(node => ({ node, playing: !node.paused, time: node.currentTime }));
  }

  function restoreMedia(states) {
    for (const { node, playing, time } of states) {
      if (node.currentTime !== time) { try { node.currentTime = time; } catch { /* Metadata may still be loading. */ } }
      if (playing) node.play()?.catch(error => report(`Playback could not resume after moving the pane: ${error.message}`));
    }
  }

  // reason: 'api' (this API or a Pop in button), 'user' (child closed), 'opener' (main page unloading).
  function dock(name, reason = 'api') {
    const record = records.get(name);
    if (!record?.handle) return false;
    const handle = record.handle;
    record.handle = null;
    const geometry = handle.geometry();
    cancelLayout(record);
    record.childCleanup.splice(0).forEach(remove => remove());
    if (record.content) {
      const states = mediaState([...record.content.childNodes]);
      // Anchors preserve the exact sibling order, including text and comments.
      for (const { node, anchor } of record.slots) {
        if (node.parentNode === record.content) anchor.replaceWith(node);
        else anchor.remove();
      }
      // Include content appended by the app while this pane was detached.
      record.pane.append(...record.content.childNodes);
      restoreMedia(states);
    }
    record.slots = []; record.content = null;
    record.placeholder?.remove(); record.placeholder = null;
    updateButton(record);
    handle.close();
    notify(onLayout, name); queueLayout(record);
    notify(onChange, name, false, geometry, reason);
    return true;
  }

  function popOut(name, geometry) {
    const record = records.get(name);
    if (destroyed || !record) return false;
    if (record.handle && !record.handle.window.closed) { record.handle.focus(); return true; }
    if (record.handle) dock(name, 'user');
    let opening = true, failed = false, handle = null;
    handle = openDetachedWindow({
      opener: record.parent, title: record.title, bodyClass: 'pane-window', geometry,
      onClose: reason => { if (handle && record.handle === handle) dock(name, reason); },
      onGeometry: current => { if (handle && record.handle === handle) notify(onChange, name, true, current); },
      onLayout: () => { if (handle && record.handle === handle) queueLayout(record); },
      onError: message => { if (opening) failed = true; report(message); },
    });
    opening = false;
    if (!handle) {
      if (!failed) report(`Pop-up blocked. Allow pop-ups for this site to pop out ${record.title}.`);
      return false;
    }
    const removers = record.childCleanup;
    try {
      const doc = handle.document;
      handle.header.classList.add('pane-window-header');
      handle.title.classList.add('pane-window-title');
      handle.actions.append(button(doc, 'Pop in', `Pop in ${record.title}`, () => dock(name), removers));
      handle.content.classList.add('pane-window-main');
      const content = element(doc, 'section', `${record.pane.className} pane-window-content`);
      content.dataset.pane = name; content.setAttribute('aria-label', record.title);
      handle.content.append(content);
      const placeholder = element(record.doc, 'div', 'pane-window-placeholder');
      placeholder.append(element(record.doc, 'span', '', `${record.title} is open in a separate window.`),
        button(record.doc, 'Pop in', `Pop in ${record.title}`, () => dock(name), removers));
      const nodes = [...record.pane.childNodes].filter(node => node !== record.summary);
      const states = mediaState(nodes);
      record.handle = handle; record.content = content; record.placeholder = placeholder;
      record.slots = nodes.map(node => {
        const anchor = record.doc.createComment('pane-window slot');
        node.before(anchor); content.append(node);
        return { node, anchor };
      });
      record.pane.append(placeholder); updateButton(record);
      restoreMedia(states);
      cancelLayout(record);
      // Rebind observers/rAF immediately; measure again once all CSS has loaded.
      notify(onLayout, name); queueLayout(record);
      notify(onChange, name, true, handle.geometry());
      handle.focus();
      return true;
    } catch (error) {
      if (record.handle) dock(name);
      else { removers.splice(0).forEach(remove => remove()); handle.close(); }
      report(`Could not pop out ${record.title}: ${error.message}`);
      return false;
    }
  }

  function dockAll(reason = 'api') { for (const name of records.keys()) dock(name, reason); }
  function refresh() {
    if (destroyed) return;
    for (const record of records.values()) {
      if (record.handle?.window.closed) dock(record.name, 'user');
      else { notify(onLayout, record.name); queueLayout(record); }
    }
  }

  for (const pane of panes) {
    const name = pane.dataset.pane;
    const summary = [...pane.children].find(node => node.tagName === 'SUMMARY');
    if (!name || !summary || records.has(name)) continue;
    const doc = pane.ownerDocument, parent = doc.defaultView;
    const title = summary.querySelector('h2')?.textContent.trim() || name;
    const record = { name, title, pane, summary, doc, parent, handle: null, content: null, placeholder: null, childCleanup: [], slots: [], frame: 0 };
    record.control = button(doc, 'Pop out', `Pop out ${title}`, () => record.handle ? dock(name) : popOut(name), cleanup);
    summary.append(record.control); records.set(name, record);
  }
  // Opener unload is handled per window by detached-window.js (reason 'opener').
  return {
    popOut, dock: name => dock(name), dockAll: () => dockAll(), refresh,
    isDetached: name => !!records.get(name)?.handle,
    destroy() {
      if (destroyed) return;
      dockAll(); destroyed = true;
      for (const record of records.values()) { cancelLayout(record); record.control.remove(); }
      cleanup.splice(0).forEach(remove => remove());
      records.clear();
    },
  };
}
