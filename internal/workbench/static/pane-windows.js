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
    const text = record.child ? 'Pop in' : 'Pop out';
    record.control.textContent = text;
    record.control.setAttribute('aria-label', `${text} ${record.title}`);
    record.control.title = `${text} ${record.title}`;
    record.pane.classList.toggle('pane-is-detached', !!record.child);
  }

  function queueLayout(record) {
    const host = record.child || record.parent;
    if (record.frame || host.closed || destroyed) return;
    record.frameHost = host;
    record.frame = host.requestAnimationFrame(() => {
      record.frame = 0;
      if (!destroyed) notify(onLayout, record.name);
    });
  }

  function cancelLayout(record) {
    if (record.frame) record.frameHost.cancelAnimationFrame(record.frame);
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

  function dock(name) {
    const record = records.get(name);
    if (!record?.child) return false;
    const child = record.child;
    record.child = null;
    cancelLayout(record);
    record.childCleanup.splice(0).forEach(remove => remove());
    const states = mediaState([...record.content.childNodes]);
    // Anchors preserve the exact sibling order, including text and comments.
    for (const { node, anchor } of record.slots) {
      if (node.parentNode === record.content) anchor.replaceWith(node);
      else anchor.remove();
    }
    // Include content appended by the app while this pane was detached.
    record.pane.append(...record.content.childNodes);
    record.slots = []; record.content = null;
    record.placeholder.remove(); record.placeholder = null;
    updateButton(record);
    restoreMedia(states);
    if (!child.closed) child.close();
    notify(onLayout, name); queueLayout(record);
    notify(onChange, name, false);
    return true;
  }

  function popOut(name) {
    const record = records.get(name);
    if (destroyed || !record) return false;
    if (record.child && !record.child.closed) { record.child.focus(); return true; }
    if (record.child) dock(name);
    let child;
    try { child = record.parent.open('', '_blank', 'popup=yes,width=1200,height=850,resizable=yes,scrollbars=yes'); }
    catch (error) { report(`Could not open ${record.title}: ${error.message}`); return false; }
    if (!child) { report(`Pop-up blocked. Allow pop-ups for this site to pop out ${record.title}.`); return false; }
    const removers = record.childCleanup;
    try {
      const doc = child.document;
      doc.title = `${record.title} — Pipe Go Doep`;
      doc.documentElement.lang = record.doc.documentElement.lang || 'en';
      doc.documentElement.className = record.doc.documentElement.className;
      doc.body.className = `${record.doc.body.className} pane-window`;
      const viewport = doc.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'; doc.head.append(viewport);
      // Copy styles only, never scripts, app state or project HTML.
      const styles = [];
      for (const source of record.doc.querySelectorAll('link[rel~="stylesheet"], style')) {
        const copy = doc.importNode(source, true);
        if (source.tagName === 'LINK') {
          copy.href = source.href;
          styles.push(new Promise(resolve => {
            listen(copy, 'load', resolve, removers);
            listen(copy, 'error', () => { report(`Could not load pop-out stylesheet: ${copy.href}`); resolve(); }, removers);
          }));
        }
        doc.head.append(copy);
      }
      const header = element(doc, 'header', 'pane-window-header');
      const heading = element(doc, 'h1', 'pane-window-title', record.title);
      header.append(heading, button(doc, 'Pop in', `Pop in ${record.title}`, () => dock(name), removers));
      const main = element(doc, 'main', 'pane-window-main');
      const content = element(doc, 'section', `${record.pane.className} pane-window-content`);
      content.dataset.pane = name; content.setAttribute('aria-label', record.title);
      main.append(content); doc.body.append(header, main);
      const placeholder = element(record.doc, 'div', 'pane-window-placeholder');
      placeholder.append(element(record.doc, 'span', '', `${record.title} is open in a separate window.`),
        button(record.doc, 'Pop in', `Pop in ${record.title}`, () => dock(name), removers));
      const nodes = [...record.pane.childNodes].filter(node => node !== record.summary);
      const states = mediaState(nodes);
      record.child = child; record.content = content; record.placeholder = placeholder;
      record.slots = nodes.map(node => {
        const anchor = record.doc.createComment('pane-window slot');
        node.before(anchor); content.append(node);
        return { node, anchor };
      });
      record.pane.append(placeholder); updateButton(record);
      listen(child, 'beforeunload', () => dock(name), removers);
      listen(child, 'pagehide', () => dock(name), removers);
      listen(child, 'resize', () => queueLayout(record), removers);
      restoreMedia(states);
      cancelLayout(record);
      // Rebind observers/rAF immediately; measure again once all CSS has loaded.
      notify(onLayout, name); queueLayout(record);
      Promise.all(styles).then(() => { if (record.child === child && !destroyed) queueLayout(record); });
      notify(onChange, name, true);
      child.focus();
      return true;
    } catch (error) {
      if (record.child) dock(name);
      else { removers.splice(0).forEach(remove => remove()); child.close(); }
      report(`Could not pop out ${record.title}: ${error.message}`);
      return false;
    }
  }

  function dockAll() { for (const name of records.keys()) dock(name); }
  function refresh() {
    if (destroyed) return;
    for (const record of records.values()) {
      if (record.child?.closed) dock(record.name);
      else { notify(onLayout, record.name); queueLayout(record); }
    }
  }

  const parents = new Set();
  for (const pane of panes) {
    const name = pane.dataset.pane;
    const summary = [...pane.children].find(node => node.tagName === 'SUMMARY');
    if (!name || !summary || records.has(name)) continue;
    const doc = pane.ownerDocument, parent = doc.defaultView;
    const title = summary.querySelector('h2')?.textContent.trim() || name;
    const record = { name, title, pane, summary, doc, parent, child: null, childCleanup: [], slots: [], frame: 0 };
    record.control = button(doc, 'Pop out', `Pop out ${title}`, () => record.child ? dock(name) : popOut(name), cleanup);
    summary.append(record.control); records.set(name, record); parents.add(parent);
  }
  for (const parent of parents) {
    listen(parent, 'beforeunload', dockAll, cleanup);
    listen(parent, 'pagehide', dockAll, cleanup);
  }
  return {
    popOut, dock, dockAll, refresh,
    destroy() {
      if (destroyed) return;
      dockAll(); destroyed = true;
      for (const record of records.values()) { cancelLayout(record); record.control.remove(); }
      cleanup.splice(0).forEach(remove => remove()); records.clear();
    },
  };
}
