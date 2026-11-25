import { MODULES, parameterSpec } from './rack-model.js';
const COLORS = { audio: '#7bd2e5', pitch: '#c3e879', gate: '#f1b36e', control: '#c49df1', left: '#81dabb', right: '#f293ac' };
const OUTPUT = '$rack-output', SCOPE = '$rack-scope';
const CHANNELS = ['x', 'y1', 'y2', 'y3', 'y4'];
// Matches scope-view.js COLOURS.
const CHANNEL_COLORS = { x: '#f2f5f0', y1: '#ffd84a', y2: '#45e0f0', y3: '#ff5ed6', y4: '#6ff27c' };
// Eurorack-style widths: 1 HP is HP CSS pixels; cells are the jack/dial grid pitch.
const HP = 15, CELL = 44, FRAME = 16, SCOPE_HP = 24, STUB_MIN_HP = 7, SCOPE_STUB_HP = 12;
// Popped-out faceplates scale between these factors to fill their window.
const MIN_WINDOW_SCALE = .6, MAX_WINDOW_SCALE = 3;
const LABEL_MARGIN = 13, LABEL_STAGGER = [0.5, 0.24, 0.76, 0.37, 0.63];
const JACK_ONLY = ['in', 'a', 'b', 'c', 'd', 'gate', 'trigger', 'reset'];
let instances = 0;
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => typeof value === 'string' ? value : '';
const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const shortTitle = title => text(title).split(' · ')[0];
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
    scope: 'M2 3 H30 V21 H2 Z M4 13 C8 4 11 4 14 12 S21 21 24 12 S27 7 28 9',
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
function splitPorts(cols, inputs, outputs) {
  if (!outputs) return { inCols: cols, outCols: 0, rows: Math.ceil(inputs / cols) };
  if (!inputs) return { inCols: 0, outCols: Math.min(outputs, cols), rows: Math.ceil(outputs / cols) };
  let best = null;
  for (let out = 1; out < cols; out++) {
    const rows = Math.max(Math.ceil(inputs / (cols - out)), Math.ceil(outputs / out));
    if (!best || rows < best.rows) best = { inCols: cols - out, outCols: out, rows };
  }
  return best;
}
/** Narrowest grid (in cells) fitting dials and jacks in about three rows, so faceplates share a height. */
export function arrangeModule(controls, inputs, outputs, extraRows = 0) {
  let shape = null;
  for (let cols = 2; cols <= 8; cols++) {
    shape = { cols, ...splitPorts(cols, inputs, outputs), controlRows: Math.ceil(controls / cols) };
    if (extraRows + shape.controlRows + shape.rows <= 3) break;
  }
  return { ...shape, hp: Math.ceil((shape.cols * CELL + FRAME) / HP) };
}

/** Native patch rack. Gestures preview locally; the coordinator commits edits. */
export function createRackView(root, { onStateChange = () => {}, onReveal = () => {}, onEditParameter = () => false, onPreviewParameter = () => {}, onCancelParameter = () => {}, onRevealParameter = () => {}, onReconnect = () => false, onProbe = () => false, onError = () => {}, onPopOutModule = () => {}, onPopInModule = () => {}, scopeScreen = null } = {}) {
  const instance = ++instances;
  // Elements are created in the document they will live in: the rack's, or a module window's.
  let buildDoc = null;
  const docNow = () => buildDoc || root.ownerDocument;
  const hasScope = !!scopeScreen && typeof scopeScreen === 'object' && scopeScreen.nodeType === 1;
  let project = {}, state = {}, nodes = [], edges = [], probes = [], scopeMode = 'yt', byID = new Map(), ownership = new Map(), firstByID = new Map();
  // detached: module id -> host element; windows: node key -> rendered window faceplate.
  let detached = new Map(), windows = new Map(), renderedHosts = new Set(), hostCleanups = [], loaded = false;
  const fits = new WeakMap(), fitted = new WeakMap(), pendingFits = new Map();
  let cards = new Map(), jacks = new Map(), cableElements = [], ghost = null, measure = null, widest = 0, frame = 0, scrollFrame = 0, destroyed = false, restoring = false;
  const disposers = [], textWidths = new Map();
  let gesture = null, selectedCable = null, revision = 0, cablePreview = null, observer = null, observedWindow = null;
  const currentWindow = () => root.ownerDocument.defaultView;
  const cancelFrame = value => { if (value) value.win.cancelAnimationFrame(value.id); };
  function requestFrame(callback, win = currentWindow()) { return { win, id: win.requestAnimationFrame(callback) }; }
  function report(error) { onError(error instanceof Error ? error.message : String(error)); }
  function invoke(callback, value) { try { Promise.resolve(callback(value)).catch(report); } catch (error) { report(error); } }
  // Remove every capture/listener before callbacks: a commit may replace this DOM.
  function startGesture(event, target, move, finish) {
    if (event.button !== 0 || gesture || destroyed) return false;
    // The target's own window: module faceplates may live in a pop-out window.
    const win = target.ownerDocument.defaultView, pointer = event.pointerId;
    let done = false;
    const cleanup = () => {
      win.removeEventListener('pointermove', moving); win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', pointerCancel); win.removeEventListener('keydown', key, true); win.removeEventListener('blur', cancel);
      target.removeEventListener('lostpointercapture', pointerCancel);
      if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
      gesture = null;
    };
    const end = (cancelled, e) => { if (done) return; done = true; cleanup(); finish(cancelled, e); };
    const moving = e => { if (e.pointerId === pointer) { if (target.ownerDocument.defaultView !== win) cancel(); else move(e); } };
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
    const result = docNow().createElement(tag);
    if (cls) result.className = cls;
    if (content !== undefined) result.textContent = content;
    return result;
  }
  function svg(tag, cls) { const result = docNow().createElementNS('http://www.w3.org/2000/svg', tag); if (cls) result.classList.add(cls); return result; }
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
  if (hasScope) { const item = el('span', 'rack-legend-probe', 'probe'); item.style.setProperty('--signal', CHANNEL_COLORS.y1); legend.append(item); }
  legend.append(el('small', '', `Drag dials ↑↓ · Shift fine · arrows adjust · click for exact JSON · select a cable, then drag either plug${hasScope ? ' · drag from a scope jack to probe' : ''} · Esc cancels`));
  const viewport = el('div', 'rack-viewport'); viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Patch rack');
  const spacer = el('div', 'rack-spacer'), canvas = el('div', 'rack-canvas'), rows = el('div', 'rack-rows');
  const cables = svg('svg', 'rack-cables'); cables.setAttribute('aria-label', 'Patch cables');
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
  listen(root, 'keydown', event => {
    if (event.key === 'Escape') select('');
    const target = event.target, editable = target?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName);
    if (['Delete', 'Backspace'].includes(event.key) && selectedCable?.probeChannel && !editable && !gesture && !scopeScreen.contains(target)) {
      event.preventDefault(); unplug(selectedCable.probeChannel);
    }
  });

  function select(key, reveal = false) {
    selectedCable = null;
    save({ selected: key }); applyFocus();
    if (reveal) onReveal(key === OUTPUT ? '/output' : byID.get(key)?.pointer || '/nodes');
  }
  function syncControls() { tracks.value = state.track; search.value = state.query; zoom.value = String(state.zoom); }
  function nodeTitle(key) {
    if (key === OUTPUT) return 'Stereo output';
    if (key === SCOPE) return 'Oscilloscope';
    return shortTitle(byID.get(key)?.spec.title) || 'missing module';
  }
  // Cable captions: "port id [Title]" per end; short form drops the titles.
  function endCaption(end, full) {
    if (end.key === OUTPUT) return `${end.port === 'left' ? 'L' : 'R'}${full ? ' [Stereo output]' : ''}`;
    if (end.key === SCOPE) return `${end.port.toUpperCase()}${full ? ' [Oscilloscope]' : ''}`;
    return `${end.port || '?'} ${end.id || '?'}${full ? ` [${nodeTitle(end.key)}]` : ''}`;
  }
  function caption(edge) { edge.caption = `${endCaption(edge.from, true)} → ${endCaption(edge.to, true)}`; edge.shortCaption = `${endCaption(edge.from, false)} → ${endCaption(edge.to, false)}`; return edge; }
  function makeModel() {
    nodes = array(project.nodes).map((raw, index) => {
      const node = object(raw), id = text(node.id), type = text(node.type);
      return { ...node, id, type, key: `node:${index}`, pointer: `/nodes/${index}`, index, spec: own(MODULES, type) ? MODULES[type] : { inputs: {}, outputs: [], title: type || 'Incomplete module', family: 'unknown' } };
    });
    byID = new Map(nodes.map(n => [n.key, n]));
    const ids = new Map();
    nodes.forEach(n => { if (!ids.has(n.id)) ids.set(n.id, n); });
    firstByID = ids;
    const portNames = (node, direction) => node ? direction === 'input' ? Object.keys(node.spec.inputs) : node.spec.outputs || ['out'] : [];
    function endpoint(ref, direction) {
      const parsed = split(ref), node = ids.get(parsed.id);
      return { ...parsed, key: node?.key, valid: !!node && portNames(node, direction).includes(parsed.port), direction };
    }
    edges = array(project.connections).map((c, index) => caption({ connectionIndex: index, from: endpoint(object(c).from, 'output'), to: endpoint(object(c).to, 'input'), pointer: `/connections/${index}`, label: `${text(object(c).from) || '?'} → ${text(object(c).to) || '?'}` }));
    for (const channel of ['left', 'right']) {
      const ref = object(project.output)[channel];
      if (typeof ref === 'string' && ref) edges.push(caption({ outputChannel: channel, from: endpoint(ref, 'output'), to: { key: OUTPUT, id: 'output', port: channel, direction: 'input', valid: true }, pointer: `/output/${channel}`, label: `${ref} → output.${channel}` }));
    }
    const scope = object(object(project._ui).scope), inputs = object(scope.inputs);
    scopeMode = scope.mode === 'xy' ? 'xy' : 'yt';
    probes = !hasScope ? [] : CHANNELS.filter(channel => own(inputs, channel)).map(channel => {
      const ref = object(inputs[channel]);
      let from, source;
      if (own(ref, 'bus')) {
        const bus = ref.bus === 'left' || ref.bus === 'right' ? ref.bus : '';
        from = { key: bus ? OUTPUT : undefined, id: 'output', port: bus || text(ref.bus), direction: 'input', valid: !!bus };
        source = `output.${bus || '?'}`;
      } else {
        const direction = ref.direction === 'input' ? 'input' : 'output', node = ids.get(text(ref.node));
        from = { id: text(ref.node), port: text(ref.port), key: node?.key, direction, valid: !!node && ref.direction === direction && portNames(node, direction).includes(ref.port) };
        source = `${from.id || '?'}.${from.port || '?'} (${text(ref.direction) || '?'})`;
      }
      return caption({ probeChannel: channel, ref, from, to: { key: SCOPE, id: 'scope', port: channel, direction: 'input', valid: true }, pointer: `/_ui/scope/inputs/${channel}`, label: `${source} → scope.${channel}` });
    });
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
      const version = revision, edit = change(), hadFocus = param.ownerDocument.activeElement === param;
      const rollback = () => {
        if (version === revision && !destroyed) paint(previous);
        invoke(onCancelParameter, { nodeIndex, name, value: previous });
      };
      pending = true; param.setAttribute('aria-busy', 'true');
      try { if (!await onEditParameter(edit)) rollback(); }
      catch (error) { rollback(); report(error); }
      finally {
        pending = false; param.removeAttribute('aria-busy');
        if (hadFocus && version !== revision && !destroyed) {
          const replacement = [...((windows.get(node.key) || cards.get(node.key))?.querySelectorAll('.rack-param') || [])].find(control => control.dataset.parameter === name);
          if (replacement && replacement.ownerDocument.activeElement === replacement.ownerDocument.body) replacement.focus({ preventScroll: true });
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
          }, param.ownerDocument.defaultView);
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
  function hoveredJack(e, targets) {
    return root.ownerDocument.elementsFromPoint(e.clientX, e.clientY).map(element => element.closest?.('.rack-jack')).find(jack => targets.includes(jack)) || null;
  }
  function beginCable(event, target, edge, end, onClick = () => {}) {
    if (event.button !== 0 || gesture) return;
    selectCable(edge);
    const direction = end === 'from' ? 'output' : 'input';
    const targets = [...root.querySelectorAll('.rack-jack')].filter(jack =>
      jack.dataset.direction === direction && jack.dataset.nodeKey !== OUTPUT && jack.dataset.nodeKey !== SCOPE && !jack.classList.contains('is-invalid') &&
      (end === 'from' || !edges.some(e => e !== edge && e.to.key === jack.dataset.nodeKey && e.to.port === jack.dataset.port)));
    targets.forEach(jack => jack.classList.add('is-drop-target'));
    let hovered = null, moved = false;
    const move = e => {
      moved ||= Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) >= 3;
      hovered?.classList.remove('is-drop-hover');
      hovered = hoveredJack(e, targets);
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
  function unplug(channel) { invoke(onProbe, { channel, ref: null }); }
  // Probe gestures start at a scope jack or at the module plug of a selected probe cable.
  function beginProbe(event, target, channel, onClick = () => {}) {
    if (event.button !== 0 || gesture || destroyed) return;
    const probe = probes.find(p => p.probeChannel === channel);
    if (probe) selectCable(probe);
    const targets = [...root.querySelectorAll('.rack-jack')].filter(jack => jack.dataset.nodeKey !== SCOPE && !jack.classList.contains('is-invalid'));
    targets.forEach(jack => jack.classList.add('is-drop-target', 'is-probe-target'));
    root.classList.add('is-probing');
    let hovered = null, moved = false;
    const move = e => {
      moved ||= Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) >= 3;
      hovered?.classList.remove('is-drop-hover');
      hovered = hoveredJack(e, targets);
      hovered?.classList.add('is-drop-hover');
      if (moved) { cablePreview = { probeChannel: channel, edge: probe?.from.valid ? probe : null, end: 'from', clientX: e.clientX, clientY: e.clientY }; refreshLayout(); }
    };
    const cleanup = () => { targets.forEach(jack => jack.classList.remove('is-drop-target', 'is-probe-target', 'is-drop-hover')); root.classList.remove('is-probing'); cablePreview = null; refreshLayout(); };
    if (!startGesture(event, target, move, (cancelled, e) => {
      if (!cancelled) move(e);
      const drop = hovered; cleanup();
      if (cancelled) return;
      if (!moved) { onClick(); return; }
      if (!drop) { if (probe) unplug(channel); return; }
      const { nodeKey, port, direction } = drop.dataset;
      const ref = nodeKey === OUTPUT ? { bus: port } : { node: byID.get(nodeKey).id, port, direction };
      const current = probe?.ref;
      if (current && (ref.bus ? current.bus === ref.bus : current.node === ref.node && current.port === ref.port && current.direction === ref.direction)) return;
      invoke(onProbe, { channel, ref });
    })) cleanup();
  }
  function probesAt(key, direction, port) { return probes.filter(p => p.from.key === key && p.from.direction === direction && p.from.port === port); }
  // `live` jacks are in the rack: they anchor cables and start cable/probe drags.
  // Window faceplate jacks only select and reveal (cables cannot cross windows).
  function makeJack(node, direction, port, valid = true, live = true) {
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
    const b = button('', event => { if (live && event.detail && dragEdge() && node.key !== OUTPUT) return; reveal(); }, 'rack-jack');
    b.style.setProperty('--signal', color); b.dataset.port = port; b.dataset.direction = direction; b.dataset.nodeKey = node.key;
    if (live) b.addEventListener('pointerdown', event => {
      const edge = dragEdge();
      if (edge && !(edge.outputChannel && direction === 'input')) beginCable(event, b, edge, direction === 'input' ? 'to' : 'from', reveal);
    });
    b.classList.toggle('is-connected', connected.length > 0); b.classList.toggle('is-invalid', !valid);
    const probed = probesAt(node.key, direction, port);
    if (probed.length) { b.classList.add('is-probed'); b.style.setProperty('--probe', CHANNEL_COLORS[probed[0].probeChannel]); }
    const ring = el('span', 'rack-jack-ring'); ring.setAttribute('aria-hidden', 'true');
    b.append(ring, el('span', 'rack-jack-label', `${port}${valid ? '' : ' ?'}`));
    if (direction === 'input' && node.key !== OUTPUT) {
      const value = el('small', 'rack-jack-value', `${connected.length ? 'PATCH' : own(object(node.params), port) ? 'SET' : 'DEF'} ${valueText(fallback)}`);
      b.querySelector('.rack-jack-label').append(value);
    }
    const routes = [...connected.map(e => e.label), ...probed.map(p => `probed by scope ${p.probeChannel.toUpperCase()}`)];
    b.title = `${node.id || 'Stereo output'}.${port} · ${direction}${routes.length ? ` · ${routes.join('; ')}` : direction === 'input' && fallback !== undefined ? ` · default ${valueText(fallback)}` : ' · unconnected'}`;
    b.setAttribute('aria-label', b.title);
    if (live) jacks.set(jackKey(node.key, direction, port), ring);
    return b;
  }
  function makeHead(node, onClick) {
    const head = button('', onClick, 'rack-module-head');
    head.append(functionIcon(docNow(), node.type, node.spec.title), el('span', 'rack-module-number', node.key === OUTPUT ? 'STEREO / OUT' : node.key === SCOPE ? 'PROBE / MONITOR' : `${String(node.index + 1).padStart(2, '0')} / ${node.type || '?'}`), el('strong', '', node.id || 'Untitled module'), el('small', '', node.spec.title));
    return head;
  }
  // Pop-out id: node id (first node with that id only) or '$scope'; '' when not poppable.
  function moduleID(node) {
    if (node.key === SCOPE) return '$scope';
    return node.key !== OUTPUT && node.id && firstByID.get(node.id) === node ? node.id : '';
  }
  function hostFor(node) {
    const id = moduleID(node), host = id ? detached.get(id) : null;
    return host?.nodeType === 1 && host.ownerDocument?.defaultView ? host : null;
  }
  function popOutButton(node) {
    const id = moduleID(node), name = node.key === SCOPE ? 'oscilloscope' : node.id;
    // Synchronous: the coordinator must open the window inside this click's user gesture.
    const b = button('⧉', () => invoke(onPopOutModule, id), 'rack-module-pop');
    b.title = `Pop ${name} out into its own window`; b.setAttribute('aria-label', b.title);
    return b;
  }
  // mode: 'rack' (faceplate), 'stub' (popped-out stand-in) or 'window' (faceplate in its window).
  function makeShell(node, hp, mode = 'rack') {
    const card = el('article', `rack-module rack-family-${node.spec.family}`); card.dataset.nodeKey = node.key; card.dataset.moduleType = node.type;
    card.dataset.hp = hp;
    if (mode === 'window') { card.classList.add('is-window'); windows.set(node.key, card); }
    else { card.style.width = `${hp * HP}px`; widest = Math.max(widest, hp * HP); cards.set(node.key, card); }
    for (let i = 0; i < 4; i++) card.append(el('i', `rack-screw rack-screw-${i}`));
    if (mode === 'rack' && moduleID(node)) card.append(popOutButton(node));
    return card;
  }
  function modulePorts(node) {
    const ports = {};
    for (const direction of ['input', 'output']) {
      const standard = direction === 'input' ? Object.keys(node.spec.inputs) : node.spec.outputs || ['out'];
      const names = new Set(standard);
      for (const edge of edges) { const endpoint = direction === 'input' ? edge.to : edge.from; if (endpoint.key === node.key && endpoint.port) names.add(endpoint.port); }
      ports[direction] = [...names].map(port => [port, standard.includes(port)]);
    }
    return ports;
  }
  function makePortPanel(node, ports, shape, live) {
    const portPanel = el('div', 'rack-ports'), groups = {};
    for (const direction of ['input', 'output']) {
      if (!ports[direction].length) continue;
      const group = el('div', `rack-port-group is-${direction}`); group.setAttribute('role', 'group'); group.setAttribute('aria-label', direction === 'input' ? 'Inputs' : 'Outputs');
      const cols = direction === 'input' ? shape.inCols : shape.outCols;
      group.style.setProperty('--n', cols); group.style.flexGrow = cols;
      for (const [port, valid] of ports[direction]) group.append(makeJack(node, direction, port, valid, live));
      portPanel.append(group); groups[direction] = group;
    }
    return { portPanel, groups };
  }
  // Balanced rows: four dials in three columns become 2 + 2 rather than 3 + 1.
  const paramColumns = (count, cols) => Math.max(1, Math.ceil(count / Math.max(1, Math.ceil(count / cols))));
  function makeCard(node, mode = 'rack') {
    const defaults = node.key === OUTPUT ? {} : { ...node.spec.inputs, ...node.spec.params }, actual = object(node.params);
    const controls = [...new Set([...Object.keys(defaults), ...Object.keys(actual)])].filter(name => !JACK_ONLY.includes(name));
    const ports = modulePorts(node), extraRows = node.type === 'sequence' ? 1 : 0;
    const shape = arrangeModule(controls.length, ports.input.length, ports.output.length, extraRows);
    const card = makeShell(node, shape.hp, mode);
    card.style.setProperty('--cols', shape.cols);
    card.append(makeHead(node, () => select(node.key, true)));
    const params = el('div', 'rack-params');
    params.style.setProperty('--param-cols', paramColumns(controls.length, shape.cols));
    if (node.type === 'sequence') {
      const display = el('div', 'rack-sequence-display');
      display.append(el('small', '', 'SCORE CONTROL'), el('strong', '', text(node.track) || 'No track assigned'));
      params.append(display);
    }
    for (const name of controls) {
      const value = own(actual, name) ? actual[name] : defaults[name];
      const patched = edges.some(e => e.to.key === node.key && e.to.port === name);
      const param = el('button', 'rack-param'); param.type = 'button';
      param.title = `${name}: ${valueText(value)} (${own(actual, name) ? 'project value' : 'default'}${patched ? '; replaced by patched input during rendering' : ''})`;
      const dial = el('span', 'rack-dial'); dial.setAttribute('aria-hidden', 'true'); dial.style.setProperty('--angle', `${dialPosition(name, value, clamp(number(project.sample_rate, 44100), 8000, 96000), node.type)}deg`);
      param.append(dial, el('span', 'rack-param-name', node.type === 'mixer' && name.startsWith('gain_') ? `GAIN ${name.slice(-1).toUpperCase()}` : name.replaceAll('_', ' ')), el('strong', 'rack-param-value', valueText(value)), el('small', 'rack-param-source', patched ? 'PATCHED' : own(actual, name) ? 'SET' : 'DEFAULT'));
      wireControl(param, node, name, value, parameterSpec(node.type, name, number(project.sample_rate, 44100)));
      params.append(param);
    }
    if (!params.childNodes.length) params.append(el('p', 'rack-note', 'Signal routing'));
    card.append(params);
    if (node.type === 'mixer') card.append(el('div', 'rack-sum-label', 'Σ OUT = A·gA + B·gB + C·gC + D·gD'));
    const { portPanel, groups } = makePortPanel(node, ports, shape, mode === 'rack');
    card.append(portPanel);
    if (mode === 'window') fits.set(card, { params, groups, controls: controls.length, inputs: ports.input.length, outputs: ports.output.length, extraRows });
    return card;
  }
  function makeScopeJacks(live) {
    const panel = el('div', 'rack-ports rack-scope-jacks'); panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Oscilloscope inputs');
    for (const channel of CHANNELS) {
      const probe = probes.find(p => p.probeChannel === channel), name = channel.toUpperCase();
      const choose = () => { if (probe) selectCable(probe); else select(SCOPE); };
      const b = button('', event => { if (!live || !event.detail) choose(); }, 'rack-jack rack-scope-jack');
      b.dataset.port = channel; b.dataset.direction = 'input'; b.dataset.nodeKey = SCOPE; b.dataset.channel = channel;
      b.style.setProperty('--signal', CHANNEL_COLORS[channel]);
      b.classList.toggle('is-connected', !!probe); b.classList.toggle('is-unresolved', !!probe && !probe.from.valid);
      if (live) b.addEventListener('pointerdown', event => beginProbe(event, b, channel, choose));
      const ring = el('span', 'rack-jack-ring'); ring.setAttribute('aria-hidden', 'true');
      const label = el('span', 'rack-jack-label', name);
      if (channel === 'x' && scopeMode === 'yt') label.append(el('small', 'rack-scope-note', 'XY mode'));
      label.append(el('small', 'rack-jack-value', probe ? probe.from.valid ? endCaption(probe.from, false) : 'unresolved' : '—'));
      b.append(ring, label);
      b.title = `Oscilloscope ${name}${channel === 'x' && scopeMode === 'yt' ? ' (used in XY mode)' : ''} · ${probe ? probe.caption + (probe.from.valid ? '' : ' (unresolved)') : live ? 'unplugged; drag onto any module or output jack to probe' : 'unplugged; patch from the rack'}`;
      b.setAttribute('aria-label', b.title);
      if (live) jacks.set(jackKey(SCOPE, 'input', channel), ring);
      panel.append(b);
    }
    return panel;
  }
  const scopeNode = () => ({ key: SCOPE, id: 'Oscilloscope', type: 'scope', spec: { title: 'Probe monitor · observes, never changes sound', family: 'scope' } });
  function makeScopeCard(mode = 'rack') {
    const node = scopeNode();
    const card = makeShell(node, SCOPE_HP, mode);
    card.append(makeHead(node, () => select(SCOPE)));
    // In a window the scope screen fills the remaining height (scope-view.css fill mode).
    const screen = el('div', `rack-scope-screen${mode === 'window' ? ' scope-fill' : ''}`); screen.append(scopeScreen); card.append(screen);
    card.append(makeScopeJacks(mode === 'rack'));
    return card;
  }
  // Stands in for a popped-out module: same live jacks, so cables and probes attach here.
  function makeStub(node) {
    const id = moduleID(node), scope = node.key === SCOPE, name = scope ? 'oscilloscope' : node.id;
    const ports = scope ? null : modulePorts(node);
    const shape = scope ? null : arrangeModule(0, ports.input.length, ports.output.length);
    const card = makeShell(node, scope ? SCOPE_STUB_HP : Math.max(STUB_MIN_HP, shape.hp), 'stub');
    card.classList.add('rack-module-stub'); card.dataset.detached = 'true';
    card.append(makeHead(node, () => scope ? select(SCOPE) : select(node.key, true)));
    const panel = el('div', 'rack-stub-panel');
    const badge = el('span', 'rack-stub-badge', 'In window'); badge.setAttribute('role', 'status');
    const focus = button('Focus', () => invoke(onPopOutModule, id), 'rack-stub-focus');
    focus.title = `Bring the ${name} window to the front`; focus.setAttribute('aria-label', focus.title);
    const popIn = button('Pop in', () => invoke(onPopInModule, id), 'rack-stub-popin');
    popIn.title = `Pop ${name} back into the rack`; popIn.setAttribute('aria-label', popIn.title);
    const actions = el('div', 'rack-stub-actions'); actions.append(focus, popIn);
    panel.append(badge, actions); card.append(panel);
    card.append(scope ? makeScopeJacks(true) : makePortPanel(node, ports, shape, true).portPanel);
    return card;
  }
  // Renders a popped-out faceplate into its window's host element, in that document.
  function renderWindow(node, host) {
    const previous = buildDoc; buildDoc = host.ownerDocument;
    try {
      const wrapper = el('div', 'rack-view rack-module-window'); wrapper.dataset.nodeKey = node.key;
      wrapper.addEventListener('keydown', event => { if (event.key === 'Escape' && !gesture) select(''); });
      const card = node.key === SCOPE ? makeScopeCard('window') : makeCard(node, 'window');
      if (node.key === SCOPE) { wrapper.classList.add('is-scope'); wrapper.append(card); }
      else { const sizer = el('div', 'rack-module-window-sizer'); sizer.append(card); wrapper.append(sizer); }
      host.replaceChildren(wrapper); renderedHosts.add(host); fitted.delete(host);
      const win = host.ownerDocument.defaultView, onResize = () => refreshLayout();
      win.addEventListener('resize', onResize);
      hostCleanups.push(() => win.removeEventListener('resize', onResize));
    } finally { buildDoc = previous; }
  }
  // Pick the dial/jack column count that lets the faceplate scale up most in its window.
  function fitWindow(host) {
    const wrapper = host.firstElementChild, sizer = wrapper?.firstElementChild, card = sizer?.firstElementChild, fit = card && fits.get(card);
    const win = host.ownerDocument.defaultView;
    if (!fit || !win || !wrapper.isConnected) return;
    const style = win.getComputedStyle(wrapper);
    const availableWidth = wrapper.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availableHeight = wrapper.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const key = `${availableWidth}x${availableHeight}`;
    if (fitted.get(host) === key || availableWidth <= 0 || availableHeight <= 0) return;
    const apply = cols => {
      const ports = splitPorts(cols, fit.inputs, fit.outputs), width = Math.ceil((cols * CELL + FRAME) / HP) * HP;
      card.style.width = `${width}px`; card.style.setProperty('--cols', cols); card.dataset.windowCols = cols;
      fit.params.style.setProperty('--param-cols', paramColumns(fit.controls, cols));
      for (const [direction, group] of Object.entries(fit.groups)) {
        const n = direction === 'input' ? ports.inCols : ports.outCols;
        group.style.setProperty('--n', n); group.style.flexGrow = n;
      }
      return { cols, width, height: card.offsetHeight };
    };
    card.style.transform = '';
    const most = clamp(Math.max(fit.controls, fit.inputs + fit.outputs, 2), 2, 8);
    let best = null;
    for (let cols = 2; cols <= most; cols++) {
      const size = apply(cols), scale = Math.min(availableWidth / size.width, availableHeight / size.height);
      if (!best || scale > best.scale + .01) best = { ...size, scale };
    }
    if (best.cols !== most) apply(best.cols);
    const scale = clamp(best.scale, MIN_WINDOW_SCALE, MAX_WINDOW_SCALE);
    card.style.transform = `scale(${scale})`; card.dataset.windowScale = scale.toFixed(3);
    sizer.style.width = `${best.width * scale}px`; sizer.style.height = `${best.height * scale}px`;
    fitted.set(host, key);
  }
  function layoutWindows() {
    for (const host of renderedHosts) {
      const win = host.ownerDocument.defaultView;
      if (!win || pendingFits.has(host)) continue;
      pendingFits.set(host, win.requestAnimationFrame(() => { pendingFits.delete(host); if (!destroyed && renderedHosts.has(host)) fitWindow(host); }));
    }
  }
  function releaseHosts(keep = new Set()) {
    hostCleanups.splice(0).forEach(cleanup => cleanup());
    for (const [host, id] of pendingFits) { host.ownerDocument.defaultView?.cancelAnimationFrame(id); pendingFits.delete(host); }
    for (const host of renderedHosts) if (!keep.has(host)) host.replaceChildren();
    renderedHosts = new Set();
  }
  function cableGroup(edge, kind, handleEnds) {
    const group = svg('g', 'rack-cable'), shadow = svg('path', 'rack-cable-shadow'), wire = svg('path', 'rack-cable-wire'), hit = svg('path', 'rack-cable-hit');
    const defs = svg('defs'), labelPath = svg('path', 'rack-cable-label-path'), label = svg('text', 'rack-cable-label'), textPath = svg('textPath');
    labelPath.id = `rack${instance}-cable${cableElements.length}`; defs.append(labelPath);
    textPath.setAttribute('href', `#${labelPath.id}`); label.append(textPath); label.setAttribute('dy', '-3.5'); label.setAttribute('aria-hidden', 'true');
    hit.setAttribute('role', 'button'); hit.setAttribute('tabindex', '0'); hit.setAttribute('aria-label', `Select ${edge.probeChannel ? 'probe' : 'cable'}: ${edge.label}`);
    hit.addEventListener('click', () => selectCable(edge));
    hit.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); selectCable(edge); } });
    group.style.setProperty('--signal', edge.probeChannel ? CHANNEL_COLORS[edge.probeChannel] : COLORS[kind] || COLORS.audio);
    if (edge.probeChannel) { group.classList.add('is-probe'); group.dataset.channel = edge.probeChannel; }
    group.append(defs, shadow, wire, label, hit);
    const handles = {};
    for (const end of handleEnds) {
      const handle = svg('circle', 'rack-cable-end'); handle.dataset.end = end; handle.setAttribute('r', '8');
      const title = svg('title'); title.textContent = `Drag ${edge.probeChannel ? 'probe' : end === 'from' ? 'source' : 'destination'}: ${edge.label}`; handle.append(title);
      handle.addEventListener('pointerdown', event => edge.probeChannel ? beginProbe(event, handle, edge.probeChannel) : beginCable(event, handle, edge, end));
      group.append(handle); handles[end] = handle;
    }
    cables.append(group);
    const item = { edge, group, shadow, wire, hit, handles, label, textPath, labelPath };
    cableElements.push(item);
    return item;
  }
  function render() {
    cards = new Map(); windows = new Map(); jacks = new Map(); cableElements = []; widest = 0; rows.replaceChildren(); cables.replaceChildren(); tracks.replaceChildren();
    const popped = [];
    const place = node => { const host = hostFor(node); if (!host) return node.key === SCOPE ? makeScopeCard() : makeCard(node); popped.push([node, host]); return makeStub(node); };
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
    let first = true;
    for (const [track, members] of groups) {
      if (!members.length) continue;
      const row = el('section', 'rack-row'), heading = el('h3', 'rack-row-title');
      heading.append(el('span', '', track === null ? 'Shared sources / mix / output' : track), el('small', '', `${members.length} modules`));
      const modules = el('div', 'rack-module-grid');
      // The scope leads the rack; the scope screen element is moved, never recreated.
      if (first && hasScope) modules.append(place(scopeNode()));
      first = false;
      members.forEach(n => modules.append(place(n))); row.append(heading, modules); rows.append(row);
    }
    const hosts = new Set(popped.map(([, host]) => host));
    releaseHosts(hosts);
    for (const [node, host] of popped) renderWindow(node, host);
    if (!nodes.length) rows.prepend(el('p', 'rack-empty', 'No modules yet. Add nodes and connections in the JSON editor to build the rack.'));
    for (const edge of edges) {
      const kind = edge.to.key === OUTPUT ? edge.to.port : signal(edge.to.port, byID.get(edge.to.key)?.type);
      cableGroup(edge, kind, edge.outputChannel ? ['from'] : ['from', 'to']);
    }
    for (const probe of probes) cableGroup(probe, 'probe', ['from']);
    ghost = null;
    if (hasScope) {
      ghost = { group: svg('g', 'rack-cable'), shadow: svg('path', 'rack-cable-shadow'), wire: svg('path', 'rack-cable-wire') };
      ghost.group.classList.add('is-probe', 'is-ghost'); ghost.group.style.display = 'none'; ghost.group.append(ghost.shadow, ghost.wire); cables.append(ghost.group);
    }
    measure = svg('text', 'rack-cable-label'); measure.classList.add('rack-cable-measure'); measure.setAttribute('visibility', 'hidden'); measure.setAttribute('aria-hidden', 'true'); cables.append(measure);
    syncControls(); applyFocus(); refreshLayout();
  }
  function matches(key) {
    const query = state.query.trim().toLowerCase();
    if (key === SCOPE) return (!state.track && !query) || (!state.track && 'oscilloscope scope probe'.includes(query)) || probes.some(p => p.from.key && matches(p.from.key));
    const node = byID.get(key);
    return (!state.track || ownership.get(key)?.has(state.track)) && (!query || `${node?.id || 'Stereo output'} ${node?.type || 'output'}`.toLowerCase().includes(query));
  }
  function allCables() { return [...edges, ...probes]; }
  function applyFocus() {
    const selected = state.selected, related = new Set(selected ? [selected] : []);
    for (const edge of allCables()) if (edge.from.key === selected || edge.to.key === selected) { related.add(edge.from.key); related.add(edge.to.key); }
    for (const [key, card] of cards) {
      card.classList.toggle('is-dimmed', !matches(key) || (!!selected && !related.has(key)));
      card.classList.toggle('is-selected', selected === key);
      card.querySelector('.rack-module-head').setAttribute('aria-pressed', String(selected === key));
    }
    // A popped-out faceplate is never dimmed in its own window; its rack stub is.
    for (const [key, card] of windows) {
      card.classList.toggle('is-selected', selected === key);
      card.querySelector('.rack-module-head').setAttribute('aria-pressed', String(selected === key));
    }
    for (const { edge, group } of cableElements) {
      const active = selectedCable ? edge === selectedCable : selected ? edge.from.key === selected || edge.to.key === selected : matches(edge.from.key) && (edge.probeChannel || matches(edge.to.key));
      group.classList.toggle('is-dimmed', !active); group.classList.toggle('is-selected', !!selected && active);
      group.classList.toggle('is-cable-selected', edge === selectedCable);
      group.querySelector('.rack-cable-hit').setAttribute('aria-pressed', String(edge === selectedCable));
      if ((selected || selectedCable) && active) {
        // Raising a cable must not drop keyboard focus from its hit path (Delete unplugs probes).
        const focused = root.ownerDocument.activeElement, refocus = group.contains(focused);
        cables.insertBefore(group, ghost?.group || measure);
        if (refocus) focused.focus({ preventScroll: true });
      }
    }
    clear.disabled = !selected && !selectedCable;
    const unresolved = edges.filter(e => !e.from.valid || !e.to.valid), dangling = probes.filter(p => !p.from.valid);
    summary.textContent = `${nodes.length} modules · ${array(project.connections).length} patch cables · ${edges.filter(e => e.to.key === OUTPUT).length}/2 output routes${hasScope ? ` · ${probes.length}/5 scope probes` : ''}${unresolved.length ? ` · ${unresolved.length} unresolved routes` : ''}${dangling.length ? ` · ${dangling.length} unresolved probes` : ''}`;
    details.replaceChildren();
    const node = byID.get(selected);
    const unplugButton = probe => button(`Unplug ${probe.probeChannel.toUpperCase()}`, () => unplug(probe.probeChannel), 'rack-unplug');
    if (selected === SCOPE && hasScope) {
      const title = el('div', 'rack-detail-title'); title.append(el('strong', '', 'Oscilloscope'), el('span', 'rack-note', `Mode ${scopeMode.toUpperCase()}. Drag from a scope jack onto any highlighted module or output jack.`)); details.append(title);
      const list = el('div', 'rack-route-list');
      for (const channel of CHANNELS) {
        const probe = probes.find(p => p.probeChannel === channel);
        const choice = button(`${channel.toUpperCase()}: ${probe ? `${probe.caption}${probe.from.valid ? '' : ' (unresolved)'}` : 'unplugged'}`, () => probe && selectCable(probe), 'rack-route');
        choice.disabled = !probe; list.append(choice);
      }
      details.append(list);
    } else if (selected && (node || selected === OUTPUT)) {
      const title = el('div', 'rack-detail-title'); title.append(el('strong', '', node?.id || 'Stereo output'), button('Reveal JSON ↗', () => onReveal(node?.pointer || '/output'))); details.append(title);
      const routes = allCables().filter(e => e.from.key === selected || e.to.key === selected);
      if (!routes.length) details.append(el('p', 'rack-note', 'No cables connected.'));
      const list = el('div', 'rack-route-list');
      for (const e of routes) list.append(button(e.label, () => selectCable(e), 'rack-route'));
      details.append(list);
    } else if (selectedCable?.probeChannel) {
      const row = el('div', 'rack-detail-title');
      row.append(el('strong', '', selectedCable.caption), unplugButton(selectedCable), button('Reveal probe JSON ↗', () => onReveal(selectedCable.pointer)));
      details.append(row, el('p', 'rack-note', 'Drag the highlighted plug at the module end to another jack, or drop it on empty space to unplug. Delete/Backspace also unplugs. Probes never change the sound.'));
    } else if (selectedCable) {
      details.append(el('strong', '', selectedCable.label), el('p', 'rack-note', selectedCable.outputChannel ? 'Drag the highlighted source plug to an output jack. The stereo bus destination is fixed.' : 'Drag either highlighted plug to a compatible jack. Select a different cable below to disambiguate fan-out.'), button('Reveal cable JSON ↗', () => onReveal(selectedCable.pointer)));
    } else details.append(el('p', 'rack-note', `Select a faceplate to trace connections, or a cable to move its plugs. Dials preview configured/base values while dragging and commit on release.${hasScope ? ' Drag from an oscilloscope jack to probe any jack.' : ''}`));
    const every = allCables();
    const routePicker = el('details', 'rack-route-picker'); routePicker.append(el('summary', '', `Select cable (${every.length})`));
    const routeList = el('div', 'rack-route-list');
    for (const edge of every) { const choice = button(edge.label, () => selectCable(edge), 'rack-route'); choice.setAttribute('aria-pressed', String(edge === selectedCable)); routeList.append(choice); }
    routePicker.append(routeList); details.append(routePicker);
    if (unresolved.length || dangling.length) {
      const errors = el('details', 'rack-unresolved'); errors.append(el('summary', '', 'Incomplete routing in this draft'));
      for (const e of unresolved) errors.append(button(e.label, () => onReveal(e.pointer), 'rack-route'));
      for (const p of dangling) {
        const row = el('div', 'rack-unresolved-probe');
        row.append(button(`Unresolved probe ${p.label}`, () => onReveal(p.pointer), 'rack-route'), unplugButton(p));
        errors.append(row);
      }
      details.append(errors);
    }
  }
  function textWidth(value) {
    if (textWidths.has(value)) return textWidths.get(value);
    measure.textContent = value;
    const width = measure.getComputedTextLength();
    if (width > 0) textWidths.set(value, width);
    return width || value.length * 5.4;
  }
  // Labels follow the hanging curve but always read left to right.
  function placeLabel({ edge, label, textPath, labelPath }, a, b, sag, index) {
    const reversed = b.x < a.x, [p, q] = reversed ? [b, a] : [a, b];
    labelPath.setAttribute('d', `M ${p.x} ${p.y} C ${p.x} ${p.y + sag}, ${q.x} ${q.y + sag}, ${q.x} ${q.y}`);
    const room = labelPath.getTotalLength() - 2 * LABEL_MARGIN;
    let value = edge.caption, width = textWidth(value), fit = 'full';
    if (width > room) { value = edge.shortCaption; width = textWidth(value); fit = 'short'; }
    if (width > room) fit = 'hidden';
    label.dataset.fit = fit; label.dataset.reversed = String(reversed);
    label.style.display = fit === 'hidden' ? 'none' : '';
    if (fit === 'hidden') return;
    if (textPath.textContent !== value) textPath.textContent = value;
    textPath.setAttribute('startOffset', (LABEL_MARGIN + (room - width) * LABEL_STAGGER[index % LABEL_STAGGER.length]).toFixed(1));
  }
  const curve = (a, b, sag) => `M ${a.x} ${a.y} C ${a.x} ${a.y + sag}, ${b.x} ${b.y + sag}, ${b.x} ${b.y}`;
  // The hit stroke stops short of both plugs so jacks under cable ends stay clickable/draggable.
  function hitCurve(a, b, sag) {
    const points = [a, { x: a.x, y: a.y + sag }, { x: b.x, y: b.y + sag }, b];
    const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const at = t => { const u = 1 - t; return { x: u * u * u * points[0].x + 3 * u * u * t * points[1].x + 3 * u * t * t * points[2].x + t * t * t * points[3].x, y: u * u * u * points[0].y + 3 * u * u * t * points[1].y + 3 * u * t * t * points[2].y + t * t * t * points[3].y }; };
    // Sampled arc length: leave about 26 px uncovered at each plug (the jack ring and its label).
    let t0 = 0.3, length = 0, previous = points[0];
    for (let i = 1; i <= 24; i++) { const point = at(i / 80); length += Math.hypot(point.x - previous.x, point.y - previous.y); previous = point; if (length >= 26) { t0 = i / 80; break; } }
    const t1 = 1 - t0;
    const splitAt = ([p0, p1, p2, p3], t) => {
      const a1 = lerp(p0, p1, t), b1 = lerp(p1, p2, t), c1 = lerp(p2, p3, t), a2 = lerp(a1, b1, t), b2 = lerp(b1, c1, t), m = lerp(a2, b2, t);
      return [[p0, a1, a2, m], [m, b2, c1, p3]];
    };
    const [p0, p1, p2, p3] = splitAt(splitAt(points, t1)[0], t0 / t1)[1];
    return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
  }
  function layout() {
    frame = 0;
    if (destroyed || !viewport.clientWidth) return;
    const scale = state.zoom;
    canvas.style.width = `${Math.max(274, widest + 66, viewport.clientWidth / scale)}px`; canvas.style.transform = `scale(${scale})`;
    // The scaled spacer, rather than the unscaled canvas, owns scroll extent.
    const width = canvas.offsetWidth, height = rows.offsetHeight + 48;
    canvas.style.height = `${height}px`; spacer.style.width = `${width * scale}px`; spacer.style.height = `${height * scale}px`;
    cables.setAttribute('viewBox', `0 0 ${width} ${height}`); cables.setAttribute('width', width); cables.setAttribute('height', height);
    const origin = canvas.getBoundingClientRect(), positions = new Map();
    for (const [key, ring] of jacks) { const r = ring.getBoundingClientRect(); positions.set(key, { x: (r.left + r.width / 2 - origin.left) / scale, y: (r.top + r.height / 2 - origin.top) / scale }); }
    const pointer = cablePreview && { x: (cablePreview.clientX - origin.left) / scale, y: (cablePreview.clientY - origin.top) / scale };
    const sagFor = (a, b, index) => 30 + Math.min(100, Math.abs(a.x - b.x) * 0.13) + index % 5 * 5;
    cableElements.forEach((item, index) => {
      const { edge, group, shadow, wire, hit, handles } = item;
      let a = positions.get(jackKey(edge.from.key, edge.from.direction, edge.from.port)), b = positions.get(jackKey(edge.to.key, 'input', edge.to.port));
      if (cablePreview?.edge === edge) { if (cablePreview.end === 'from') a = pointer; else b = pointer; }
      group.style.display = a && b && (!edge.probeChannel || edge.from.valid) ? '' : 'none';
      if (group.style.display) return;
      const sag = sagFor(a, b, index), d = curve(a, b, sag);
      shadow.setAttribute('d', d); wire.setAttribute('d', d); hit.setAttribute('d', hitCurve(a, b, sag));
      for (const [end, handle] of Object.entries(handles)) { const point = end === 'from' ? a : b; handle.setAttribute('cx', point.x); handle.setAttribute('cy', point.y); }
      placeLabel(item, a, b, sag, index);
    });
    if (ghost) {
      const target = cablePreview?.probeChannel && !cablePreview.edge && positions.get(jackKey(SCOPE, 'input', cablePreview.probeChannel));
      ghost.group.style.display = target ? '' : 'none';
      if (target) {
        const d = curve(pointer, target, sagFor(pointer, target, 0));
        ghost.group.style.setProperty('--signal', CHANNEL_COLORS[cablePreview.probeChannel]); ghost.shadow.setAttribute('d', d); ghost.wire.setAttribute('d', d);
      }
    }
    restoring = true;
    if (!gesture) viewport.scrollLeft = state.scrollLeft;
    restoring = false;
  }
  function refreshLayout() {
    if (destroyed) return;
    layoutWindows();
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
      makeModel(); if (!byID.has(state.selected) && state.selected !== OUTPUT && !(hasScope && state.selected === SCOPE)) state.selected = ''; loaded = true; render();
    },
    /** Map<module id ('$scope' for the oscilloscope), host element> of open module windows. */
    setDetached(map) {
      if (destroyed) return;
      detached = new Map(map instanceof Map ? map : []);
      if (!loaded) return;
      gesture?.cancel(); render();
    },
    refreshLayout,
    destroy() { destroyed = true; gesture?.cancel(); releaseHosts(); observer?.disconnect(); observedWindow?.removeEventListener('resize', refreshLayout); cancelFrame(frame); cancelFrame(scrollFrame); disposers.forEach(dispose => dispose()); root.replaceChildren(); root.classList.remove('rack-view', 'is-probing'); },
  };
}
