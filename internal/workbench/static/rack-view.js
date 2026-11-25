import { MODULES, parameterSpec } from './rack-model.js';
const COLORS = { audio: '#7bd2e5', pitch: '#c3e879', gate: '#f1b36e', control: '#c49df1', left: '#81dabb', right: '#f293ac' };
const OUTPUT = '$rack-output';
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => typeof value === 'string' ? value : '';
const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function split(ref) {
  const value = text(ref), dot = value.indexOf('.');
  return dot > 0 ? { id: value.slice(0, dot), port: value.slice(dot + 1) } : { id: value, port: '' };
}
function signal(port, type) {
  if (port === 'left' || port === 'right') return port;
  if (port === 'freq') return 'pitch';
  if (['gate', 'trigger', 'reset'].includes(port)) return 'gate';
  if (['in', 'a', 'b', 'c', 'd'].includes(port)) return 'audio';
  return port === 'out' && !['adsr', 'constant'].includes(type) ? 'audio' : 'control';
}
function valueText(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toPrecision(5))) : 'invalid';
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  return typeof value === 'boolean' ? String(value) : 'invalid';
}
function functionIcon(doc, type, title) {
  const ns = 'http://www.w3.org/2000/svg', svg = doc.createElementNS(ns, 'svg');
  svg.classList.add('rack-function-icon'); svg.setAttribute('viewBox', '0 0 32 24'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title);
  const label = doc.createElementNS(ns, 'title'); label.textContent = title; svg.append(label);
  const paths = {
    sine: 'M2 12 C6 -2 10 -2 16 12 S26 26 30 12', pulse: 'M2 19 V5 H14 V19 H26 V5 H30', triangle: 'M2 18 L9 5 L23 19 L30 6', saw: 'M2 19 L15 5 V19 L29 5 V19',
    wavetable: 'M2 18 H6 V13 H10 V7 H15 V3 H19 V7 H23 V13 H27 V18 H30', noise: 'M2 13 L4 5 L7 19 L10 9 L13 16 L16 3 L19 20 L23 10 L26 17 L30 5',
    adsr: 'M2 20 L8 3 L15 12 H23 L30 20', mixer: 'M6 3 V21 M16 3 V21 M26 3 V21 M2 8 H10 M12 16 H20 M22 10 H30',
    lowpass: 'M2 5 H13 Q18 5 21 12 L28 21', delay: 'M3 20 V3 M10 20 V8 M17 20 V12 M24 20 V16 M30 20 V18',
    drive: 'M2 20 H7 Q12 20 16 12 T25 4 H30', bitcrush: 'M2 20 H7 V15 H12 V10 H17 V5 H22 V10 H27 V15 H30',
    vca: 'M6 3 L27 12 L6 21 Z M2 12 H6 M27 12 H31', pan: 'M2 12 H12 M12 12 L25 4 H30 M12 12 L25 20 H30',
    constant: 'M2 12 H30 M16 4 V20', sequence: 'M2 19 H8 V11 H15 V4 H22 V15 H30', output: 'M2 5 H21 L28 2 V9 L21 5 M2 19 H21 L28 15 V22 L21 19',
  };
  const path = doc.createElementNS(ns, 'path'); path.setAttribute('d', own(paths, type) ? paths[type] : 'M3 4 H29 V20 H3 Z M10 12 H22'); svg.append(path); return svg;
}
function dialPosition(name, value, sr, type) {
  const { min = 0, max = 1, log = false } = parameterSpec(type, name, sr) || {};
  const v = clamp(number(value, min), min, max);
  const fraction = log
    ? Math.log1p(v - min) / Math.log1p(max - min) : (v - min) / (max - min);
  return -135 + fraction * 270;
}

/** Native patch rack. Gestures preview locally; the coordinator commits edits. */
export function createRackView(root, { onStateChange = () => {}, onReveal = () => {}, onEditParameter = () => false, onPreviewParameter = () => {}, onCancelParameter = () => {}, onRevealParameter = () => {}, onReconnect = () => false, onError = () => {} } = {}) {
  const doc = root.ownerDocument;
  let project = {}, state = {}, nodes = [], edges = [], byID = new Map(), ownership = new Map();
  let cards = new Map(), jacks = new Map(), cableElements = [], frame = 0, scrollFrame = 0, destroyed = false, restoring = false;
  const disposers = [];
  let gesture = null, selectedCable = null, revision = 0, cablePreview = null, observer = null, observedWindow = null;
  const currentWindow = () => root.ownerDocument.defaultView;
  const cancelFrame = value => { if (value) value.win.cancelAnimationFrame(value.id); };
  function requestFrame(callback) { const win = currentWindow(); return { win, id: win.requestAnimationFrame(callback) }; }
  function report(error) { onError(error instanceof Error ? error.message : String(error)); }
  function invoke(callback, value) { try { Promise.resolve(callback(value)).catch(report); } catch (error) { report(error); } }
  // Remove every capture/listener before callbacks: a commit may replace this DOM.
  function startGesture(event, target, move, finish) {
    if (event.button !== 0 || gesture || destroyed) return false;
    const win = currentWindow(), pointer = event.pointerId;
    let done = false;
    const cleanup = () => {
      win.removeEventListener('pointermove', moving); win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', pointerCancel); win.removeEventListener('keydown', key, true); win.removeEventListener('blur', cancel);
      target.removeEventListener('lostpointercapture', pointerCancel);
      if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
      gesture = null;
    };
    const end = (cancelled, e) => { if (done) return; done = true; cleanup(); finish(cancelled, e); };
    const moving = e => { if (e.pointerId === pointer) { if (currentWindow() !== win) cancel(); else move(e); } };
    const up = e => { if (e.pointerId === pointer) end(false, e); };
    const cancel = () => end(true);
    const pointerCancel = e => { if (e.pointerId === pointer) cancel(); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
    gesture = { cancel };
    win.addEventListener('pointermove', moving); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', pointerCancel);
    win.addEventListener('keydown', key, true); win.addEventListener('blur', cancel); target.addEventListener('lostpointercapture', pointerCancel);
    try { target.setPointerCapture(pointer); } catch { cancel(); return false; }
    event.preventDefault(); return true;
  }
  function el(tag, cls, content) {
    const result = doc.createElement(tag);
    if (cls) result.className = cls;
    if (content !== undefined) result.textContent = content;
    return result;
  }
  function listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    disposers.push(() => target.removeEventListener(event, handler, options));
  }
  function button(label, action, cls = '') {
    const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', action); return b;
  }
  function save(partial) { state = { ...state, ...partial }; onStateChange(partial); }
  root.classList.add('rack-view');
  const toolbar = el('div', 'rack-toolbar');
  const brand = el('div', 'rack-brand', 'PATCH BAY');
  brand.append(el('span', '', 'MODULAR SIGNAL RACK'));
  const trackLabel = el('label', 'rack-field', 'Focus');
  const tracks = el('select'); tracks.setAttribute('aria-label', 'Focus track'); trackLabel.append(tracks);
  const searchLabel = el('label', 'rack-field', 'Find');
  const search = el('input'); search.type = 'search'; search.placeholder = 'Module / type'; search.setAttribute('aria-label', 'Find rack module'); searchLabel.append(search);
  const zoomLabel = el('label', 'rack-field', 'Zoom');
  const zoom = el('select'); zoom.setAttribute('aria-label', 'Rack zoom');
  for (const value of [0.5, 0.65, 0.8, 1, 1.2, 1.5]) { const option = el('option', '', `${Math.round(value * 100)}%`); option.value = value; zoom.append(option); }
  zoomLabel.append(zoom);
  const clear = button('Clear selection', () => select(''));
  const reset = button('Reset view', () => { save({ zoom: 0.8, track: '', query: '', selected: '', scrollLeft: 0, scrollTop: 0 }); syncControls(); applyFocus(); refreshLayout(); });
  toolbar.append(brand, trackLabel, searchLabel, zoomLabel, clear, reset);
  const legend = el('div', 'rack-legend');
  for (const [kind, color] of Object.entries(COLORS)) { const item = el('span', '', kind === 'pitch' ? 'pitch / Hz' : kind); item.style.setProperty('--signal', color); legend.append(item); }
  legend.append(el('small', '', 'Drag dials ↑↓ · Shift fine · arrows adjust · click for exact JSON · select a cable, then drag either plug · Esc cancels'));
  const viewport = el('div', 'rack-viewport'); viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Patch rack');
  const spacer = el('div', 'rack-spacer'), canvas = el('div', 'rack-canvas'), rows = el('div', 'rack-rows');
  const cables = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); cables.classList.add('rack-cables'); cables.setAttribute('aria-label', 'Patch cables');
  canvas.append(rows, cables); spacer.append(canvas); viewport.append(spacer);
  const inspector = el('div', 'rack-inspector'), summary = el('div', 'rack-summary'); summary.setAttribute('role', 'status');
  const details = el('div', 'rack-details'); inspector.append(summary, details);
  root.replaceChildren(toolbar, legend, viewport, inspector);

  listen(tracks, 'change', () => {
    save({ track: tracks.value }); applyFocus();
    const first = nodes.find(n => ownership.get(n.key)?.has(state.track));
    if (first) cards.get(first.key).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  listen(search, 'input', () => { save({ query: search.value }); applyFocus(); });
  listen(zoom, 'change', () => {
    const ratio = Number(zoom.value) / state.zoom;
    save({ zoom: Number(zoom.value), scrollLeft: viewport.scrollLeft * ratio, scrollTop: viewport.scrollTop * ratio }); refreshLayout();
  });
  listen(viewport, 'scroll', () => {
    if (restoring || destroyed || scrollFrame) return;
    scrollFrame = requestFrame(() => { scrollFrame = 0; if (!restoring && !destroyed) save({ scrollLeft: viewport.scrollLeft, scrollTop: 0 }); });
  }, { passive: true });
  listen(root, 'keydown', event => { if (event.key === 'Escape') select(''); });

  function select(key, reveal = false) {
    selectedCable = null;
    save({ selected: key }); applyFocus();
    if (reveal) onReveal(key === OUTPUT ? '/output' : byID.get(key)?.pointer || '/nodes');
  }
  function syncControls() { tracks.value = state.track; search.value = state.query; zoom.value = String(state.zoom); }
  function makeModel() {
    nodes = array(project.nodes).map((raw, index) => {
      const node = object(raw), id = text(node.id), type = text(node.type);
      return { ...node, id, type, key: `node:${index}`, pointer: `/nodes/${index}`, index, spec: own(MODULES, type) ? MODULES[type] : { inputs: {}, outputs: [], title: type || 'Incomplete module', family: 'unknown' } };
    });
    byID = new Map(nodes.map(n => [n.key, n]));
    const ids = new Map();
    nodes.forEach(n => { if (!ids.has(n.id)) ids.set(n.id, n); });
    function endpoint(ref, direction) {
      const parsed = split(ref), node = ids.get(parsed.id);
      const names = node ? direction === 'input' ? Object.keys(node.spec.inputs) : node.spec.outputs || ['out'] : [];
      return { ...parsed, key: node?.key, valid: !!node && names.includes(parsed.port), direction };
    }
    edges = array(project.connections).map((c, index) => ({ connectionIndex: index, from: endpoint(object(c).from, 'output'), to: endpoint(object(c).to, 'input'), pointer: `/connections/${index}`, label: `${text(object(c).from) || '?'} → ${text(object(c).to) || '?'}` }));
    for (const channel of ['left', 'right']) {
      const ref = object(project.output)[channel];
      if (typeof ref === 'string' && ref) edges.push({ outputChannel: channel, from: endpoint(ref, 'output'), to: { key: OUTPUT, id: 'output', port: channel, direction: 'input', valid: true }, pointer: `/output/${channel}`, label: `${ref} → output.${channel}` });
    }
    ownership = new Map(nodes.map(n => [n.key, new Set(n.type === 'sequence' && text(n.track) ? [n.track] : [])]));
    ownership.set(OUTPUT, new Set());
    // Reachability follows actual cables, not naming conventions. Bounded for invalid cyclic drafts.
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false;
      for (const e of edges) {
        const source = ownership.get(e.from.key), target = ownership.get(e.to.key);
        if (!source || !target) continue;
        for (const track of source) if (!target.has(track)) { target.add(track); changed = true; }
      }
      if (!changed) break;
    }
    // Unsequenced sources (noise, modulation) inherit the tracks they feed.
    const unowned = new Set(nodes.filter(n => !ownership.get(n.key).size).map(n => n.key));
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false;
      for (const e of edges) {
        if (!unowned.has(e.from.key)) continue;
        for (const track of ownership.get(e.to.key) || []) {
          const source = ownership.get(e.from.key);
          if (!source.has(track)) { source.add(track); changed = true; }
        }
      }
      if (!changed) break;
    }
  }
  function jackKey(key, direction, port) { return JSON.stringify([key, direction, port]); }
  function wireControl(param, node, name, initial, spec) {
    const nodeIndex = node.key === OUTPUT ? null : node.index;
    let value = number(initial, spec?.default ?? 0), pending = false;
    const change = () => ({ nodeIndex, name, value });
    const paint = next => {
      value = next;
      param.querySelector('.rack-param-value').textContent = valueText(value);
      param.querySelector('.rack-dial').style.setProperty('--angle', `${dialPosition(name, value, number(project.sample_rate, 44100), node.type)}deg`);
      param.setAttribute('aria-valuenow', value); param.setAttribute('aria-valuetext', valueText(value));
    };
    const normalize = next => clamp(Number((spec.integer ? Math.round(next) : next).toPrecision(10)), spec.min, spec.max);
    const increment = (next, units) => {
      const step = spec.step || (spec.integer ? 1 : .01);
      return spec.log && !spec.integer
        ? (Math.max(0, next) + step) * Math.exp(units * .025) - step
        : next + units * step;
    };
    const commit = async previous => {
      if (value === previous) return;
      const version = revision, edit = change(), hadFocus = root.ownerDocument.activeElement === param;
      const rollback = () => {
        if (version === revision && !destroyed) paint(previous);
        invoke(onCancelParameter, { nodeIndex, name, value: previous });
      };
      pending = true; param.setAttribute('aria-busy', 'true');
      try { if (!await onEditParameter(edit)) rollback(); }
      catch (error) { rollback(); report(error); }
      finally {
        pending = false; param.removeAttribute('aria-busy');
        if (hadFocus && version !== revision && !destroyed && root.ownerDocument.activeElement === root.ownerDocument.body) {
          const replacement = [...(cards.get(node.key)?.querySelectorAll('.rack-param') || [])].find(control => control.dataset.parameter === name);
          replacement?.focus({ preventScroll: true });
        }
      }
    };
    param.dataset.parameter = name;
    param.setAttribute('aria-label', `${node.id}: ${name}. Drag vertically or use arrows; Shift fine. Click to reveal exact JSON.${edges.some(e => e.to.key === node.key && e.to.port === name) ? ' Patched input overrides this base value.' : ''}`);
    if (spec) {
      param.setAttribute('role', 'slider'); param.setAttribute('aria-valuemin', spec.min); param.setAttribute('aria-valuemax', spec.max); paint(value);
      param.addEventListener('pointerdown', event => {
        if (pending || event.button !== 0 || gesture) return;
        param.focus({ preventScroll: true });
        const previous = value, startY = event.clientY;
        let lastY = startY, raw = value, dragged = false, previewFrame = 0, finished = false;
        const move = e => {
          if (!dragged && Math.abs(e.clientY - startY) < 3) return;
          dragged = true;
          raw = clamp(increment(raw, (lastY - e.clientY) * (e.shiftKey ? .1 : 1) / (spec.integer ? 8 : 2)), spec.min, spec.max);
          lastY = e.clientY; paint(normalize(raw)); param.classList.add('is-editing');
          if (!previewFrame) previewFrame = requestFrame(() => {
            previewFrame = 0;
            if (!finished && !destroyed) invoke(onPreviewParameter, change());
          });
        };
        startGesture(event, param, move, (cancelled, e) => {
          if (!cancelled) move(e);
          finished = true; cancelFrame(previewFrame); previewFrame = 0;
          param.classList.remove('is-editing');
          if (cancelled || (dragged && value === previous)) {
            paint(previous); invoke(onCancelParameter, { nodeIndex, name, value: previous });
          } else if (dragged) void commit(previous);
          else invoke(onRevealParameter, change());
        });
      });
      param.addEventListener('keydown', event => {
        const sign = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
        if (!sign) return;
        event.preventDefault(); if (pending || gesture) return;
        const previous = value;
        paint(normalize(increment(value, sign * (event.shiftKey && !spec.integer ? .1 : 1)))); void commit(previous);
      });
    }
    param.addEventListener('click', event => { if (!event.detail || !spec) invoke(onRevealParameter, change()); });
  }
  function selectCable(edge) { selectedCable = edge; state = { ...state, selected: '' }; save({ selected: '' }); applyFocus(); }
  function beginCable(event, target, edge, end, onClick = () => {}) {
    if (event.button !== 0 || gesture) return;
    selectCable(edge);
    const direction = end === 'from' ? 'output' : 'input';
    const targets = [...root.querySelectorAll('.rack-jack')].filter(jack =>
      jack.dataset.direction === direction && jack.dataset.nodeKey !== OUTPUT && !jack.classList.contains('is-invalid') &&
      (end === 'from' || !edges.some(e => e !== edge && e.to.key === jack.dataset.nodeKey && e.to.port === jack.dataset.port)));
    targets.forEach(jack => jack.classList.add('is-drop-target'));
    let hovered = null, moved = false;
    const move = e => {
      moved ||= Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) >= 3;
      hovered?.classList.remove('is-drop-hover');
      hovered = root.ownerDocument.elementsFromPoint(e.clientX, e.clientY).map(element => element.closest?.('.rack-jack')).find(jack => targets.includes(jack)) || null;
      hovered?.classList.add('is-drop-hover');
      if (moved) { cablePreview = { edge, end, clientX: e.clientX, clientY: e.clientY }; refreshLayout(); }
    };
    const cleanup = () => { targets.forEach(jack => jack.classList.remove('is-drop-target', 'is-drop-hover')); cablePreview = null; refreshLayout(); };
    if (!startGesture(event, target, move, (cancelled, e) => {
      if (!cancelled) move(e);
      const drop = hovered; cleanup();
      if (cancelled) return;
      if (!moved) { onClick(); return; }
      if (!drop) { report('Drop on a highlighted compatible jack; the cable has been restored.'); return; }
      const node = byID.get(drop.dataset.nodeKey), ref = `${node.id}.${drop.dataset.port}`;
      if (ref === `${edge[end].id}.${edge[end].port}`) return;
      const change = edge.outputChannel ? { outputChannel: edge.outputChannel, end, ref } : { connectionIndex: edge.connectionIndex, end, ref };
      invoke(onReconnect, change);
    })) cleanup();
  }
  function makeJack(node, direction, port, valid = true) {
    const connected = edges.filter(e => (direction === 'input' ? e.to : e.from).key === node.key && (direction === 'input' ? e.to : e.from).port === port);
    const color = COLORS[signal(port, node.type)];
    const fallback = own(object(node.params), port) ? node.params[port] : node.spec.inputs[port];
    const reveal = () => {
      if (node.key === OUTPUT) onReveal(`/output/${port}`);
      else if (direction === 'input' && parameterSpec(node.type, port, number(project.sample_rate, 44100))) invoke(onRevealParameter, { nodeIndex: node.index, name: port, value: fallback });
      else if (connected.length === 1) { selectCable(connected[0]); onReveal(connected[0].pointer); }
      else select(node.key);
    };
    const dragEdge = () => connected.includes(selectedCable) ? selectedCable : connected.length === 1 ? connected[0] : null;
    const b = button('', event => { if (event.detail && dragEdge() && node.key !== OUTPUT) return; reveal(); }, 'rack-jack');
    b.style.setProperty('--signal', color); b.dataset.port = port; b.dataset.direction = direction; b.dataset.nodeKey = node.key;
    b.addEventListener('pointerdown', event => {
      const edge = dragEdge();
      if (edge && !(edge.outputChannel && direction === 'input')) beginCable(event, b, edge, direction === 'input' ? 'to' : 'from', reveal);
    });
    b.classList.toggle('is-connected', connected.length > 0); b.classList.toggle('is-invalid', !valid);
    const ring = el('span', 'rack-jack-ring'); ring.setAttribute('aria-hidden', 'true');
    b.append(ring, el('span', 'rack-jack-label', `${port}${valid ? '' : ' ?'}`));
    if (direction === 'input' && node.key !== OUTPUT) {
      const value = el('small', 'rack-jack-value', `${connected.length ? 'PATCH' : own(object(node.params), port) ? 'SET' : 'DEF'} ${valueText(fallback)}`);
      b.querySelector('.rack-jack-label').append(value);
    }
    b.title = `${node.id || 'Stereo output'}.${port} · ${direction}${connected.length ? ` · ${connected.map(e => e.label).join('; ')}` : direction === 'input' && fallback !== undefined ? ` · default ${valueText(fallback)}` : ' · unconnected'}`;
    b.setAttribute('aria-label', b.title);
    jacks.set(jackKey(node.key, direction, port), ring);
    return b;
  }
  function makeCard(node) {
    const card = el('article', `rack-module rack-family-${node.spec.family}`); card.dataset.nodeKey = node.key; card.dataset.moduleType = node.type;
    cards.set(node.key, card);
    for (let i = 0; i < 4; i++) card.append(el('i', `rack-screw rack-screw-${i}`));
    const head = button('', () => select(node.key, true), 'rack-module-head');
    head.append(functionIcon(doc, node.type, node.spec.title), el('span', 'rack-module-number', node.key === OUTPUT ? 'STEREO / OUT' : `${String(node.index + 1).padStart(2, '0')} / ${node.type || '?'}`), el('strong', '', node.id || 'Untitled module'), el('small', '', node.spec.title));
    card.append(head);
    const params = el('div', 'rack-params');
    if (node.type === 'sequence') {
      const display = el('div', 'rack-sequence-display');
      display.append(el('small', '', 'SCORE CONTROL'), el('strong', '', text(node.track) || 'No track assigned'), el('span', '', 'FREQ · GATE · VEL · TRIG'));
      params.append(display);
    }
    const defaults = node.key === OUTPUT ? {} : { ...node.spec.inputs, ...node.spec.params }, actual = object(node.params);
    const names = new Set([...Object.keys(defaults), ...Object.keys(actual)]);
    for (const name of names) {
      if (['in', 'a', 'b', 'c', 'd', 'gate', 'trigger', 'reset'].includes(name)) continue;
      const value = own(actual, name) ? actual[name] : defaults[name];
      const patched = edges.some(e => e.to.key === node.key && e.to.port === name);
      const param = el('button', 'rack-param'); param.type = 'button';
      param.title = `${name}: ${valueText(value)} (${own(actual, name) ? 'project value' : 'default'}${patched ? '; replaced by patched input during rendering' : ''})`;
      const dial = el('span', 'rack-dial'); dial.setAttribute('aria-hidden', 'true'); dial.style.setProperty('--angle', `${dialPosition(name, value, clamp(number(project.sample_rate, 44100), 8000, 96000), node.type)}deg`);
      param.append(dial, el('span', 'rack-param-name', node.type === 'mixer' && name.startsWith('gain_') ? `CH ${name.slice(-1).toUpperCase()} · GAIN` : name.replaceAll('_', ' ')), el('strong', 'rack-param-value', valueText(value)), el('small', 'rack-param-source', patched ? 'PATCHED · base' : own(actual, name) ? 'SET' : 'DEFAULT'));
      wireControl(param, node, name, value, parameterSpec(node.type, name, number(project.sample_rate, 44100)));
      params.append(param);
    }
    if (!params.childNodes.length) params.append(el('p', 'rack-note', 'Signal routing'));
    card.append(params);
    const ports = el('div', 'rack-ports');
    for (const direction of ['input', 'output']) {
      const column = el('div', 'rack-port-column'); column.append(el('small', '', direction === 'input' ? 'INPUTS' : 'OUTPUTS'));
      const standard = direction === 'input' ? Object.keys(node.spec.inputs) : node.spec.outputs || ['out'];
      const names = new Set(standard);
      for (const edge of edges) { const endpoint = direction === 'input' ? edge.to : edge.from; if (endpoint.key === node.key && endpoint.port) names.add(endpoint.port); }
      for (const port of names) column.append(makeJack(node, direction, port, standard.includes(port)));
      if (!names.size) column.append(el('span', 'rack-no-ports', '—'));
      ports.append(column);
    }
    card.append(ports);
    if (node.type === 'mixer') card.append(el('div', 'rack-sum-label', 'Σ OUT = A·gA + B·gB + C·gC + D·gD'));
    return card;
  }
  function render() {
    cards = new Map(); jacks = new Map(); cableElements = []; rows.replaceChildren(); cables.replaceChildren(); tracks.replaceChildren();
    const trackIDs = [...new Set([...array(project.tracks).map(t => text(object(t).id)), ...nodes.filter(n => n.type === 'sequence').map(n => text(n.track))].filter(Boolean))];
    const all = el('option', '', 'All tracks / full patch'); all.value = ''; tracks.append(all);
    for (const id of trackIDs) { const option = el('option', '', id); option.value = id; tracks.append(option); }
    if (!trackIDs.includes(state.track)) state.track = '';
    const groups = new Map(trackIDs.map(id => [id, []])); groups.set(null, []);
    for (const node of nodes) {
      const owners = ownership.get(node.key), track = owners.size === 1 ? [...owners][0] : null;
      (groups.get(track) || groups.get(null)).push(node);
    }
    groups.get(null).push({ key: OUTPUT, id: 'Stereo output', type: 'output', pointer: '/output', params: { gain: own(object(project.output), 'gain') ? project.output.gain : 0 }, spec: { title: 'Render bus · left / right', family: 'output', inputs: { left: 0, right: 0 }, outputs: [], params: {} } });
    for (const [track, members] of groups) {
      if (!members.length) continue;
      const row = el('section', 'rack-row'), heading = el('h3', 'rack-row-title');
      heading.append(el('span', '', track === null ? 'Shared sources / mix / output' : track), el('small', '', `${members.length} modules`));
      const modules = el('div', 'rack-module-grid'); members.forEach(n => modules.append(makeCard(n))); row.append(heading, modules); rows.append(row);
    }
    if (!nodes.length) rows.prepend(el('p', 'rack-empty', 'No modules yet. Add nodes and connections in the JSON editor to build the rack.'));
    for (const edge of edges) {
      const group = doc.createElementNS(cables.namespaceURI, 'g'), shadow = doc.createElementNS(cables.namespaceURI, 'path'), wire = doc.createElementNS(cables.namespaceURI, 'path'), hit = doc.createElementNS(cables.namespaceURI, 'path');
      group.classList.add('rack-cable'); shadow.classList.add('rack-cable-shadow'); wire.classList.add('rack-cable-wire');
      hit.classList.add('rack-cable-hit'); hit.setAttribute('role', 'button'); hit.setAttribute('tabindex', '0'); hit.setAttribute('aria-label', `Select cable: ${edge.label}`);
      hit.addEventListener('click', () => selectCable(edge));
      hit.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); selectCable(edge); } });
      const kind = edge.to.key === OUTPUT ? edge.to.port : signal(edge.to.port, byID.get(edge.to.key)?.type);
      group.style.setProperty('--signal', COLORS[kind] || COLORS.audio);
      group.append(shadow, wire, hit);
      const handles = {};
      for (const end of edge.outputChannel ? ['from'] : ['from', 'to']) {
        const handle = doc.createElementNS(cables.namespaceURI, 'circle'); handle.classList.add('rack-cable-end'); handle.dataset.end = end; handle.setAttribute('r', '8');
        const title = doc.createElementNS(cables.namespaceURI, 'title'); title.textContent = `Drag ${end === 'from' ? 'source' : 'destination'}: ${edge.label}`; handle.append(title);
        handle.addEventListener('pointerdown', event => beginCable(event, handle, edge, end));
        group.append(handle); handles[end] = handle;
      }
      cables.append(group); cableElements.push({ edge, group, shadow, wire, hit, handles });
    }
    syncControls(); applyFocus(); refreshLayout();
  }
  function matches(key) {
    const node = byID.get(key), query = state.query.trim().toLowerCase();
    return (!state.track || ownership.get(key)?.has(state.track)) && (!query || `${node?.id || 'Stereo output'} ${node?.type || 'output'}`.toLowerCase().includes(query));
  }
  function applyFocus() {
    const selected = state.selected, related = new Set(selected ? [selected] : []);
    for (const edge of edges) if (edge.from.key === selected || edge.to.key === selected) { related.add(edge.from.key); related.add(edge.to.key); }
    for (const [key, card] of cards) {
      card.classList.toggle('is-dimmed', !matches(key) || (!!selected && !related.has(key)));
      card.classList.toggle('is-selected', selected === key);
      card.querySelector('.rack-module-head').setAttribute('aria-pressed', String(selected === key));
    }
    for (const { edge, group } of cableElements) {
      const active = selectedCable ? edge === selectedCable : selected ? edge.from.key === selected || edge.to.key === selected : matches(edge.from.key) && matches(edge.to.key);
      group.classList.toggle('is-dimmed', !active); group.classList.toggle('is-selected', !!selected && active);
      group.classList.toggle('is-cable-selected', edge === selectedCable);
      group.querySelector('.rack-cable-hit').setAttribute('aria-pressed', String(edge === selectedCable));
      if ((selected || selectedCable) && active) cables.append(group);
    }
    clear.disabled = !selected && !selectedCable;
    const unresolved = edges.filter(e => !e.from.valid || !e.to.valid);
    summary.textContent = `${nodes.length} modules · ${array(project.connections).length} patch cables · ${edges.filter(e => e.to.key === OUTPUT).length}/2 output routes${unresolved.length ? ` · ${unresolved.length} unresolved routes` : ''}`;
    details.replaceChildren();
    const node = byID.get(selected);
    if (selected && (node || selected === OUTPUT)) {
      const title = el('div', 'rack-detail-title'); title.append(el('strong', '', node?.id || 'Stereo output'), button('Reveal JSON ↗', () => onReveal(node?.pointer || '/output'))); details.append(title);
      const routes = edges.filter(e => e.from.key === selected || e.to.key === selected);
      if (!routes.length) details.append(el('p', 'rack-note', 'No cables connected.'));
      const list = el('div', 'rack-route-list');
      for (const e of routes) list.append(button(e.label, () => selectCable(e), 'rack-route'));
      details.append(list);
    } else if (selectedCable) {
      details.append(el('strong', '', selectedCable.label), el('p', 'rack-note', selectedCable.outputChannel ? 'Drag the highlighted source plug to an output jack. The stereo bus destination is fixed.' : 'Drag either highlighted plug to a compatible jack. Select a different cable below to disambiguate fan-out.'), button('Reveal cable JSON ↗', () => onReveal(selectedCable.pointer)));
    } else details.append(el('p', 'rack-note', 'Select a faceplate to trace connections, or a cable to move its plugs. Dials preview configured/base values while dragging and commit on release.'));
    const routePicker = el('details', 'rack-route-picker'); routePicker.append(el('summary', '', `Select cable (${edges.length})`));
    const routeList = el('div', 'rack-route-list');
    for (const edge of edges) { const choice = button(edge.label, () => selectCable(edge), 'rack-route'); choice.setAttribute('aria-pressed', String(edge === selectedCable)); routeList.append(choice); }
    routePicker.append(routeList); details.append(routePicker);
    if (unresolved.length) {
      const errors = el('details', 'rack-unresolved'); errors.append(el('summary', '', 'Incomplete routing in this draft'));
      for (const e of unresolved) errors.append(button(e.label, () => onReveal(e.pointer), 'rack-route'));
      details.append(errors);
    }
  }
  function layout() {
    frame = 0;
    if (destroyed || !viewport.clientWidth) return;
    const scale = state.zoom;
    canvas.style.width = `${Math.max(274, viewport.clientWidth / scale)}px`; canvas.style.transform = `scale(${scale})`;
    // The scaled spacer, rather than the unscaled canvas, owns scroll extent.
    const width = canvas.offsetWidth, height = rows.offsetHeight + 48;
    canvas.style.height = `${height}px`; spacer.style.width = `${width * scale}px`; spacer.style.height = `${height * scale}px`;
    cables.setAttribute('viewBox', `0 0 ${width} ${height}`); cables.setAttribute('width', width); cables.setAttribute('height', height);
    const origin = canvas.getBoundingClientRect(), positions = new Map();
    for (const [key, ring] of jacks) { const r = ring.getBoundingClientRect(); positions.set(key, { x: (r.left + r.width / 2 - origin.left) / scale, y: (r.top + r.height / 2 - origin.top) / scale }); }
    cableElements.forEach(({ edge, group, shadow, wire, hit, handles }, index) => {
      let a = positions.get(jackKey(edge.from.key, 'output', edge.from.port)), b = positions.get(jackKey(edge.to.key, 'input', edge.to.port));
      if (cablePreview?.edge === edge) {
        const point = { x: (cablePreview.clientX - origin.left) / scale, y: (cablePreview.clientY - origin.top) / scale };
        if (cablePreview.end === 'from') a = point; else b = point;
      }
      group.style.display = a && b ? '' : 'none';
      if (!a || !b) return;
      const sag = 30 + Math.min(100, Math.abs(a.x - b.x) * 0.13) + index % 5 * 5;
      const d = `M ${a.x} ${a.y} C ${a.x} ${a.y + sag}, ${b.x} ${b.y + sag}, ${b.x} ${b.y}`;
      shadow.setAttribute('d', d); wire.setAttribute('d', d); hit.setAttribute('d', d);
      for (const [end, handle] of Object.entries(handles)) { const point = end === 'from' ? a : b; handle.setAttribute('cx', point.x); handle.setAttribute('cy', point.y); }
    });
    restoring = true;
    if (!gesture) viewport.scrollLeft = state.scrollLeft;
    restoring = false;
  }
  function refreshLayout() {
    if (destroyed) return;
    const win = currentWindow();
    if (observedWindow !== win) {
      gesture?.cancel(); observer?.disconnect(); observedWindow?.removeEventListener('resize', refreshLayout);
      cancelFrame(frame); frame = 0; cancelFrame(scrollFrame); scrollFrame = 0;
      observedWindow = win;
      observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(refreshLayout) : null;
      observer?.observe(viewport); win.addEventListener('resize', refreshLayout);
    }
    if (!frame) frame = requestFrame(layout);
  }
  return {
    setProject(next, view = {}) {
      if (destroyed) return;
      gesture?.cancel(); revision++; selectedCable = null;
      project = object(next); view = object(view);
      const z = number(view.zoom, 0.8);
      state = { zoom: [0.5, 0.65, 0.8, 1, 1.2, 1.5].includes(z) ? z : 0.8, track: text(view.track), query: text(view.query), selected: text(view.selected), scrollLeft: Math.max(0, number(view.scrollLeft, 0)), scrollTop: Math.max(0, number(view.scrollTop, 0)) };
      makeModel(); if (!byID.has(state.selected) && state.selected !== OUTPUT) state.selected = ''; render();
    },
    refreshLayout,
    destroy() { destroyed = true; gesture?.cancel(); observer?.disconnect(); observedWindow?.removeEventListener('resize', refreshLayout); cancelFrame(frame); cancelFrame(scrollFrame); disposers.forEach(dispose => dispose()); root.replaceChildren(); root.classList.remove('rack-view'); },
  };
}
