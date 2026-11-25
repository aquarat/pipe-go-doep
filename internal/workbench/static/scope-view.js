// Oscilloscope view for live probe data. Pure helpers are exported for tests;
// nothing touches the DOM at module load.

export const CHANNELS = ['x', 'y1', 'y2', 'y3', 'y4'];
export const COLOURS = { x: '#f2f5f0', y1: '#ffd84a', y2: '#45e0f0', y3: '#ff5ed6', y4: '#6ff27c' };
export const TIMEBASES = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
export const SCALES = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50,
  100, 200, 500, 1000, 2000, 5000, 10000];
export const PERSISTENCE = { off: 1, short: .35, long: .1, infinite: 0 };
export const DIVISIONS = { x: 10, y: 8 };
const TRIGGER_MODES = ['auto', 'normal', 'free'];
const NAMES = { x: 'X', y1: 'Y1', y2: 'Y2', y3: 'Y3', y4: 'Y4' };
const DEFAULTS = Object.freeze({ timebase: 2, triggerSource: '', triggerLevel: 0, triggerSlope: 'rising',
  triggerMode: 'auto', persistence: 'short' });

// Absolute-frame ring: slot = frame mod size, and a per-slot frame stamp makes a
// slot valid only for the frame that last wrote it. Later writes of the same
// frame overwrite (loops, seeks, grains); frames never written read as NaN.
export function createProbeRing(seconds = 1) {
  let rate = 0, size = 0, stamps = null, data = [];
  const map = new Int8Array(CHANNELS.length);
  function allocate(sampleRate) {
    rate = sampleRate;
    size = 2 ** Math.ceil(Math.log2(Math.max(1024, Math.min(sampleRate, 384000) * seconds)));
    stamps = new Float64Array(size).fill(-1);
    data = CHANNELS.map(() => new Float32Array(size));
  }
  return {
    get sampleRate() { return rate; },
    get size() { return size; },
    clear() { stamps?.fill(-1); },
    write(block) {
      const { position, frames, sampleRate, channels, data: values } = block || {};
      if (!Number.isSafeInteger(position) || position < 0 || !Number.isInteger(frames) || frames < 0 ||
          !(sampleRate > 0) || !Array.isArray(channels) || !(values instanceof Float32Array) ||
          values.length !== frames * channels.length) return false;
      if (sampleRate !== rate) allocate(sampleRate);
      const stride = channels.length;
      for (let c = 0; c < CHANNELS.length; c++) map[c] = channels.indexOf(CHANNELS[c]);
      for (let i = Math.max(0, frames - size); i < frames; i++) {
        const frame = position + i, slot = frame % size, base = i * stride;
        stamps[slot] = frame;
        for (let c = 0; c < CHANNELS.length; c++) data[c][slot] = map[c] < 0 ? NaN : values[base + map[c]];
      }
      return true;
    },
    value(channel, frame) {
      if (!stamps || frame < 0) return NaN;
      const slot = frame % size;
      return stamps[slot] === frame ? data[channel][slot] : NaN;
    },
  };
}

// Latest frame f in (from, to] where the signal crosses level between f-1 and f.
export function findTrigger(source, channel, from, to, level, rising = true) {
  let next = source.value(channel, to);
  for (let f = to; f > from; f--) {
    const previous = source.value(channel, f - 1);
    if (rising ? previous < level && next >= level : previous > level && next <= level) return f;
    next = previous;
  }
  return -1;
}

// min/max over [from, to) plus a frequency estimate from hysteretic crossings of
// the midpoint. Writes into `out` to avoid allocation.
export function analyse(source, channel, from, to, sampleRate, out = {}) {
  let min = Infinity, max = -Infinity, valid = 0;
  for (let f = from; f < to; f++) {
    const v = source.value(channel, f);
    if (v === v) { valid++; if (v < min) min = v; if (v > max) max = v; }
  }
  out.valid = valid; out.min = valid ? min : NaN; out.max = valid ? max : NaN; out.frequency = NaN;
  const span = max - min;
  if (valid < 4 || !(span > 1e-9) || !Number.isFinite(span)) return out;
  const mid = (min + max) / 2, low = mid - span * .1, high = mid + span * .1;
  let armed = false, first = -1, last = -1, count = 0;
  for (let f = from; f < to; f++) {
    const v = source.value(channel, f);
    if (v !== v) { armed = false; continue; }
    if (v < low) armed = true;
    else if (armed && v >= high) { armed = false; if (first < 0) first = f; last = f; count++; }
  }
  if (count >= 2 && last > first) out.frequency = (count - 1) * sampleRate / (last - first);
  return out;
}

export const valueToY = (v, scale, offset, height) => height / 2 - (v / scale + offset) * height / DIVISIONS.y;
export const valueToX = (v, scale, offset, width) => width / 2 + (v / scale + offset) * width / DIVISIONS.x;
const limit = (n, size) => n < -size ? -size : n > size * 2 ? size * 2 : n;

// Plots [from, from+count) across width: samples when sparse, per-column min/max
// envelopes when dense. Returns the number of valid samples visited.
export function traceYT(source, channel, from, count, width, height, scale, offset, path) {
  let valid = 0, pen = false;
  if (count <= width * 2) {
    for (let i = 0; i < count; i++) {
      const v = source.value(channel, from + i);
      if (v !== v) { pen = false; continue; }
      const x = i * width / count, y = limit(valueToY(v, scale, offset, height), height);
      if (pen) path.lineTo(x, y); else { path.moveTo(x, y); pen = true; }
      valid++;
    }
    return valid;
  }
  const columns = Math.max(1, Math.ceil(width));
  for (let px = 0; px < columns; px++) {
    const start = from + Math.floor(px * count / columns), end = from + Math.floor((px + 1) * count / columns);
    let min = Infinity, max = -Infinity;
    for (let f = start; f < end; f++) {
      const v = source.value(channel, f);
      if (v === v) { valid++; if (v < min) min = v; if (v > max) max = v; }
    }
    if (min > max) { pen = false; continue; }
    const top = limit(valueToY(max, scale, offset, height), height), bottom = limit(valueToY(min, scale, offset, height), height);
    if (pen) path.lineTo(px, bottom); else { path.moveTo(px, bottom); pen = true; }
    path.lineTo(px, top);
  }
  return valid;
}

// Y channel against X over [from, to). Returns the number of points plotted.
export function traceXY(source, xChannel, yChannel, from, to, width, height, xScale, xOffset, yScale, yOffset, path) {
  let points = 0, pen = false;
  for (let f = from; f < to; f++) {
    const xv = source.value(xChannel, f), yv = source.value(yChannel, f);
    if (xv !== xv || yv !== yv) { pen = false; continue; }
    const x = limit(valueToX(xv, xScale, xOffset, width), width), y = limit(valueToY(yv, yScale, yOffset, height), height);
    if (pen) path.lineTo(x, y); else { path.moveTo(x, y); pen = true; }
    points++;
  }
  return points;
}

export function nearestScale(perDivision) {
  for (const scale of SCALES) if (scale >= perDivision * .999) return scale;
  return SCALES.at(-1);
}

export function formatValue(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e4) return `${+(v / 1000).toFixed(a >= 1e5 ? 0 : 1)}k`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a === 0) return '0';
  if (a >= .01) return v.toFixed(3).replace(/\.?0+$/, '');
  return v.toExponential(1);
}
const formatHz = hz => !Number.isFinite(hz) ? '— Hz' : hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 1e4 ? 1 : 2)} kHz` : `${hz.toFixed(hz >= 100 ? 0 : 1)} Hz`;
const formatTime = ms => ms < 1 ? `${+(ms * 1000).toFixed(0)} µs` : `${ms} ms`;
const formatScale = scale => scale >= 1000 ? `${scale / 1000}k` : scale < 1 ? `${+(scale * 1000).toFixed(0)}m` : String(scale);

export function createScopeView(root, { getPosition, onStateChange, onModeChange } = {}) {
  const make = (tag, className, props = {}) => {
    const element = root.ownerDocument.createElement(tag);
    if (className) element.className = className;
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') element.textContent = value;
      else if (key in element && typeof value !== 'string') element[key] = value;
      else element.setAttribute(key, value);
    }
    return element;
  };
  const option = (value, text) => make('option', '', { value: String(value), text });
  const callback = (fn, value) => { try { fn?.(value); } catch (error) { console.error(error); } };

  // ---- DOM ----
  root.classList.add('scope-view');
  root.replaceChildren();
  const screen = make('div', 'scope-screen');
  const gridCanvas = make('canvas', 'scope-grid', { 'aria-hidden': 'true' });
  const traceCanvas = make('canvas', 'scope-trace', { role: 'img', 'aria-label': 'Oscilloscope trace' });
  // Inline layout so canvas pixel size can never feed back into the measured
  // screen size, even before (or without) the stylesheet in a pop-out window.
  screen.style.position = 'relative'; screen.style.overflow = 'hidden';
  for (const canvas of [gridCanvas, traceCanvas]) Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  const status = make('div', 'scope-status', { role: 'status' });
  const statusTitle = make('strong'), statusHint = make('small');
  status.append(statusTitle, statusHint);
  const hud = make('div', 'scope-hud', { 'aria-hidden': 'true' });
  const hudTime = make('span'), hudTrigger = make('span');
  hud.append(hudTime, hudTrigger);
  screen.append(gridCanvas, traceCanvas, hud, status);

  const controls = make('div', 'scope-controls');
  const row = make('div', 'scope-row');
  const modeGroup = make('div', 'scope-seg', { role: 'group', 'aria-label': 'Display mode' });
  const modeButtons = ['yt', 'xy'].map(value => {
    const button = make('button', 'scope-ctl', { type: 'button', text: value.toUpperCase(), title: value === 'yt' ? 'Signals against time' : 'Each Y against X' });
    button.dataset.mode = value; modeGroup.append(button); return button;
  });
  const field = (label, control, className = '') => {
    const wrapper = make('label', `scope-field ${className}`.trim()); wrapper.append(make('span', '', { text: label }), control); return wrapper;
  };
  const timebase = make('select', 'scope-ctl scope-timebase', { 'aria-label': 'Timebase per division' });
  for (const ms of TIMEBASES) timebase.append(option(ms, `${formatTime(ms)}/div`));
  const triggerSource = make('select', 'scope-ctl scope-trigger-source', { 'aria-label': 'Trigger source' });
  const triggerSlope = make('button', 'scope-ctl scope-trigger-slope', { type: 'button' });
  const triggerMode = make('select', 'scope-ctl scope-trigger-mode', { 'aria-label': 'Trigger mode' });
  for (const value of TRIGGER_MODES) triggerMode.append(option(value, value[0].toUpperCase() + value.slice(1)));
  const triggerLevel = make('input', 'scope-ctl scope-trigger-level', { type: 'number', step: 'any', 'aria-label': 'Trigger level' });
  const persistence = make('select', 'scope-ctl scope-persistence', { 'aria-label': 'XY persistence' });
  for (const value of Object.keys(PERSISTENCE)) persistence.append(option(value, value[0].toUpperCase() + value.slice(1)));
  const autoButton = make('button', 'scope-ctl scope-auto', { type: 'button', text: 'Auto', title: 'Fit scales and trigger level to the signals' });
  const triggerFields = make('span', 'scope-trigger');
  triggerFields.append(field('Trig', triggerSource), triggerSlope, triggerMode, field('Lvl', triggerLevel));
  const persistField = field('Persist', persistence, 'scope-persist');
  row.append(modeGroup, field('Time', timebase), triggerFields, persistField, autoButton);
  const channelList = make('div', 'scope-channels');
  const rows = CHANNELS.map(channel => {
    const element = make('div', 'scope-channel', { hidden: true });
    element.dataset.channel = channel;
    element.style.setProperty('--scope-colour', COLOURS[channel]);
    const chip = make('span', 'scope-chip', { text: NAMES[channel] });
    const label = make('span', 'scope-label');
    const scale = make('select', 'scope-ctl scope-scale', { 'aria-label': `${NAMES[channel]} scale per division` });
    for (const value of SCALES) scale.append(option(value, `${formatScale(value)}/div`));
    const offset = make('input', 'scope-ctl scope-offset', { type: 'number', step: '0.1', min: '-8', max: '8', title: 'Position (divisions)', 'aria-label': `${NAMES[channel]} position in divisions` });
    const readout = make('output', 'scope-readout');
    element.append(chip, label, scale, offset, readout);
    channelList.append(element);
    return { element, label, scale, offset, readout, text: '' };
  });
  controls.append(row, channelList);
  root.append(screen, controls);

  // ---- state ----
  const ring = createProbeRing(1);
  const view = { ...DEFAULTS, scales: Object.fromEntries(CHANNELS.map(c => [c, .5])), offsets: Object.fromEntries(CHANNELS.map(c => [c, 0])) };
  let mode = 'yt', patched = new Set(), labels = {}, unresolved = new Set(), blockUnresolved = new Set();
  let host = null, frame = 0, observer = null, destroyed = false;
  let width = 0, height = 0, dpr = 1, gridDirty = true, sized = false, dirty = true;
  let hasData = false, lastFrame = NaN, lastLive, lastPlaying, lastXY = NaN, triggered = false;
  let readoutAt = -Infinity, statusKey = '', hudKey = '';
  const window_ = { from: 0, count: 0 };
  const stats = {};
  const gridContext = gridCanvas.getContext('2d'), traceContext = traceCanvas.getContext('2d');

  const index = channel => CHANNELS.indexOf(channel);
  const resolved = channel => patched.has(channel) && !unresolved.has(channel) && !blockUnresolved.has(channel);
  const triggerChannel = () => {
    if (patched.has(view.triggerSource)) return view.triggerSource;
    return ['y1', 'y2', 'y3', 'y4', 'x'].find(c => patched.has(c)) || '';
  };
  const current = { frame: 0, sampleRate: 44100, playing: false, live: true };
  function position() {
    let p;
    try { p = getPosition?.(); } catch (error) { console.error(error); }
    current.frame = Number.isFinite(p?.frame) ? Math.max(0, Math.floor(p.frame)) : 0;
    current.sampleRate = p?.sampleRate > 0 ? p.sampleRate : ring.sampleRate || 44100;
    current.playing = !!p?.playing; current.live = p?.live !== false;
    return current;
  }

  // ---- controls ----
  function syncControls() {
    root.dataset.mode = mode;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    timebase.value = String(view.timebase);
    triggerSlope.textContent = view.triggerSlope === 'rising' ? '↗' : '↘';
    triggerSlope.title = `Trigger on ${view.triggerSlope} edge`;
    triggerSlope.setAttribute('aria-label', triggerSlope.title);
    triggerMode.value = view.triggerMode;
    if (root.ownerDocument.activeElement !== triggerLevel) triggerLevel.value = String(view.triggerLevel);
    persistence.value = view.persistence;
    const source = triggerChannel();
    triggerSource.replaceChildren(...['y1', 'y2', 'y3', 'y4', 'x'].filter(c => patched.has(c)).map(c => option(c, NAMES[c])));
    if (!source) triggerSource.append(option('', '—'));
    triggerSource.value = source;
    triggerFields.hidden = mode !== 'yt'; persistField.hidden = mode !== 'xy';
    for (const [i, channel] of CHANNELS.entries()) {
      const r = rows[i];
      r.element.hidden = !patched.has(channel);
      const bad = patched.has(channel) && !resolved(channel);
      r.element.classList.toggle('is-unresolved', bad);
      const text = (labels[channel] || 'patched') + (bad ? ' · unresolved' : '');
      r.label.textContent = text; r.label.title = text;
      r.scale.value = String(view.scales[channel]);
      if (root.ownerDocument.activeElement !== r.offset) r.offset.value = String(view.offsets[channel]);
    }
    hudKey = ''; dirty = true;
  }
  function change(partial) {
    syncControls(); schedule();
    callback(onStateChange, partial);
  }
  for (const button of modeButtons) button.addEventListener('click', () => {
    if (button.dataset.mode === mode) return;
    mode = button.dataset.mode; lastXY = NaN; syncControls(); schedule();
    callback(onModeChange, mode);
  });
  timebase.addEventListener('change', () => { view.timebase = Number(timebase.value); lastXY = NaN; change({ timebase: view.timebase }); });
  triggerSource.addEventListener('change', () => { view.triggerSource = triggerSource.value; change({ triggerSource: view.triggerSource }); });
  triggerSlope.addEventListener('click', () => {
    view.triggerSlope = view.triggerSlope === 'rising' ? 'falling' : 'rising'; change({ triggerSlope: view.triggerSlope });
  });
  triggerMode.addEventListener('change', () => { view.triggerMode = triggerMode.value; change({ triggerMode: view.triggerMode }); });
  triggerLevel.addEventListener('change', () => {
    const value = Number(triggerLevel.value);
    if (triggerLevel.value === '' || !Number.isFinite(value)) { triggerLevel.value = String(view.triggerLevel); return; }
    view.triggerLevel = value; change({ triggerLevel: value });
  });
  persistence.addEventListener('change', () => { view.persistence = persistence.value; lastXY = NaN; change({ persistence: view.persistence }); });
  for (const [i, channel] of CHANNELS.entries()) {
    rows[i].scale.addEventListener('change', () => { view.scales[channel] = Number(rows[i].scale.value); lastXY = NaN; change({ scales: { ...view.scales } }); });
    rows[i].offset.addEventListener('change', () => {
      const value = Number(rows[i].offset.value);
      if (rows[i].offset.value === '' || !Number.isFinite(value)) { rows[i].offset.value = String(view.offsets[channel]); return; }
      view.offsets[channel] = Math.max(-8, Math.min(8, value)); lastXY = NaN;
      change({ offsets: { ...view.offsets } });
    });
  }
  autoButton.addEventListener('click', () => {
    const p = position(), rate = ring.sampleRate || p.sampleRate;
    const span = Math.max(windowFrames(rate), Math.round(rate * .1));
    let changed = false;
    for (const channel of CHANNELS) {
      if (!resolved(channel)) continue;
      analyse(ring, index(channel), p.frame - span, p.frame, rate, stats);
      if (!stats.valid) continue;
      const range = Math.max(stats.max - stats.min, Math.abs(stats.max), Math.abs(stats.min)) || 1;
      const scale = nearestScale(range / 6);
      view.scales[channel] = scale;
      view.offsets[channel] = stats.max - stats.min > 1e-9 ? Math.round(-(stats.max + stats.min) / 2 / scale * 10) / 10 : 0;
      if (channel === triggerChannel()) view.triggerLevel = Number(((stats.max + stats.min) / 2).toPrecision(3));
      changed = true;
    }
    if (changed) { lastXY = NaN; change({ scales: { ...view.scales }, offsets: { ...view.offsets }, triggerLevel: view.triggerLevel }); }
  });

  // ---- window binding ----
  function bind() {
    const win = root.ownerDocument.defaultView;
    if (win === host && host && !host.closed) return;
    if (frame && host && !host.closed) host.cancelAnimationFrame(frame);
    frame = 0; observer?.disconnect(); observer = null; host = win;
    if (!host) return;
    if (host.ResizeObserver) { observer = new host.ResizeObserver(() => { sized = false; dirty = true; }); observer.observe(screen); }
    sized = false; dirty = true;
  }
  function schedule() {
    if (destroyed) return;
    bind();
    if (!frame && host) frame = host.requestAnimationFrame(tick);
  }
  function measure() {
    const cssWidth = screen.clientWidth, cssHeight = screen.clientHeight;
    const ratio = host?.devicePixelRatio || 1;
    const w = Math.round(cssWidth * ratio), h = Math.round(cssHeight * ratio);
    if (w !== width || h !== height || ratio !== dpr) {
      width = w; height = h; dpr = ratio;
      gridCanvas.width = traceCanvas.width = w; gridCanvas.height = traceCanvas.height = h;
      gridDirty = true; lastXY = NaN;
    }
    sized = true;
  }

  // ---- drawing ----
  function drawGrid() {
    gridDirty = false;
    const g = gridContext, w = width, h = height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#060c0e'; g.fillRect(0, 0, w, h);
    g.lineWidth = Math.max(1, dpr * .75);
    g.strokeStyle = '#1f3036';
    g.beginPath();
    for (let i = 1; i < DIVISIONS.x; i++) { const x = Math.round(i * w / DIVISIONS.x) + .5; g.moveTo(x, 0); g.lineTo(x, h); }
    for (let i = 1; i < DIVISIONS.y; i++) { const y = Math.round(i * h / DIVISIONS.y) + .5; g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.strokeStyle = '#3b525a';
    g.beginPath();
    const cx = Math.round(w / 2) + .5, cy = Math.round(h / 2) + .5, tick = 3 * dpr;
    g.moveTo(cx, 0); g.lineTo(cx, h); g.moveTo(0, cy); g.lineTo(w, cy);
    for (let i = 1; i < DIVISIONS.x * 5; i++) { const x = Math.round(i * w / DIVISIONS.x / 5) + .5; g.moveTo(x, cy - tick); g.lineTo(x, cy + tick); }
    for (let i = 1; i < DIVISIONS.y * 5; i++) { const y = Math.round(i * h / DIVISIONS.y / 5) + .5; g.moveTo(cx - tick, y); g.lineTo(cx + tick, y); }
    g.stroke();
    g.strokeStyle = '#4d646c'; g.strokeRect(.5, .5, w - 1, h - 1);
  }
  const windowFrames = rate => Math.max(2, Math.round(view.timebase / 1000 * DIVISIONS.x * rate));
  function setStatus(title, hint = '') {
    const key = title + '\n' + hint;
    if (key === statusKey) return;
    statusKey = key; statusTitle.textContent = title; statusHint.textContent = hint; status.hidden = !title;
  }
  function updateHud(rate) {
    const source = triggerChannel();
    const key = `${mode}|${view.timebase}|${source}|${view.triggerSlope}|${view.triggerLevel}|${view.triggerMode}|${triggered}|${view.persistence}|${rate}`;
    if (key === hudKey) return;
    hudKey = key;
    if (mode === 'xy') {
      hudTime.textContent = `XY · ${formatTime(view.timebase * DIVISIONS.x)} window`;
      hudTrigger.textContent = `Persist ${view.persistence}`;
      hudTrigger.style.color = '';
    } else {
      hudTime.textContent = `${formatTime(view.timebase)}/div`;
      const state = view.triggerMode === 'free' ? 'Free' : triggered ? "Trig'd" : view.triggerMode === 'normal' ? 'Wait' : 'Auto';
      hudTrigger.textContent = source ? `${NAMES[source]} ${view.triggerSlope === 'rising' ? '↗' : '↘'} ${formatValue(view.triggerLevel)} · ${state}` : state;
      hudTrigger.style.color = source ? COLOURS[source] : '';
    }
  }
  function drawMarkers(t) {
    t.globalAlpha = 1;
    const size = 5 * dpr;
    for (const channel of CHANNELS) {
      if (!resolved(channel) || (mode === 'xy' && channel === 'x')) continue;
      const y = limit(valueToY(0, view.scales[channel], view.offsets[channel], height), height);
      if (y < 0 || y > height) continue;
      t.fillStyle = COLOURS[channel];
      t.beginPath(); t.moveTo(0, y - size); t.lineTo(size * 1.4, y); t.lineTo(0, y + size); t.fill();
    }
    const source = triggerChannel();
    if (mode === 'yt' && source && view.triggerMode !== 'free' && resolved(source)) {
      const y = valueToY(view.triggerLevel, view.scales[source], view.offsets[source], height);
      t.fillStyle = COLOURS[source];
      if (y >= 0 && y <= height) { t.beginPath(); t.moveTo(width, y - size); t.lineTo(width - size * 1.4, y); t.lineTo(width, y + size); t.fill(); }
      t.beginPath(); t.moveTo(width / 2 - size, 0); t.lineTo(width / 2 + size, 0); t.lineTo(width / 2, size * 1.4); t.fill();
    }
  }
  function drawYT(p, rate) {
    const t = traceContext, count = windowFrames(rate);
    let from = p.frame - count;
    triggered = false;
    const source = triggerChannel();
    if (view.triggerMode !== 'free' && source && resolved(source)) {
      const pre = count >> 1, latest = p.frame - (count - pre);
      const span = Math.min(Math.max(count, Math.round(rate * .05)) * 2, Math.max(0, (ring.size >> 1) - count));
      const found = findTrigger(ring, index(source), latest - span, latest, view.triggerLevel, view.triggerSlope === 'rising');
      if (found >= 0) { from = found - pre; triggered = true; }
      else if (view.triggerMode === 'normal' && hasData) { updateHud(rate); return -1; }
    }
    window_.from = from; window_.count = count;
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, width, height);
    t.lineWidth = Math.max(1, 1.3 * dpr); t.lineJoin = 'round'; t.globalAlpha = .95;
    let valid = 0;
    for (let i = CHANNELS.length - 1; i >= 0; i--) {
      const channel = CHANNELS[i];
      if (!resolved(channel)) continue;
      t.beginPath();
      valid += traceYT(ring, i, from, count, width, height, view.scales[channel], view.offsets[channel], t);
      t.strokeStyle = COLOURS[channel]; t.stroke();
    }
    drawMarkers(t); updateHud(rate);
    return valid;
  }
  function drawXY(p, rate) {
    const t = traceContext, count = windowFrames(rate), fade = PERSISTENCE[view.persistence] ?? 1;
    let from = p.frame - count;
    const incremental = fade < 1 && Number.isFinite(lastXY) && lastXY <= p.frame && p.frame - lastXY < count;
    t.globalCompositeOperation = 'source-over';
    if (incremental) {
      from = Math.max(from, lastXY - 1);
      if (fade > 0) {
        t.globalCompositeOperation = 'destination-out'; t.globalAlpha = fade; t.fillStyle = '#000';
        t.fillRect(0, 0, width, height); t.globalCompositeOperation = 'source-over';
      }
    } else t.clearRect(0, 0, width, height);
    lastXY = p.frame;
    window_.from = p.frame - count; window_.count = count;
    t.lineWidth = Math.max(1, 1.2 * dpr); t.lineJoin = 'round'; t.globalAlpha = .85;
    let valid = 0;
    if (resolved('x')) for (let i = CHANNELS.length - 1; i > 0; i--) {
      const channel = CHANNELS[i];
      if (!resolved(channel)) continue;
      t.beginPath();
      valid += traceXY(ring, 0, i, from, p.frame, width, height, view.scales.x, view.offsets.x, view.scales[channel], view.offsets[channel], t);
      t.strokeStyle = COLOURS[channel]; t.stroke();
    }
    if (!incremental || !valid) drawMarkers(t);
    triggered = false; updateHud(rate);
    return incremental && !valid ? 1 : valid;
  }
  function updateReadouts(rate, now) {
    if (now - readoutAt < 200) return;
    readoutAt = now;
    const span = Math.max(window_.count, Math.round(rate * .05));
    const from = window_.from + window_.count - span;
    for (const [i, channel] of CHANNELS.entries()) {
      const r = rows[i];
      let text = '';
      if (resolved(channel) && hasData) {
        analyse(ring, i, from, from + span, rate, stats);
        text = stats.valid ? `${formatValue(stats.min)} … ${formatValue(stats.max)} · ${formatHz(stats.frequency)}` : '';
      }
      if (text !== r.text) { r.text = text; r.readout.textContent = text; }
    }
  }
  function clearReadouts() {
    readoutAt = -Infinity;
    for (const r of rows) if (r.text) { r.text = ''; r.readout.textContent = ''; }
  }
  function draw(p) {
    if (!sized) measure();
    if (!width || !height) return;
    if (gridDirty) drawGrid();
    const rate = ring.sampleRate || p.sampleRate;
    const live = p.live, any = CHANNELS.some(c => patched.has(c)), anyResolved = CHANNELS.some(resolved);
    let message = '', hint = '';
    if (!live) { message = 'Live synth only'; hint = 'Switch the transport to Live synth to see probes'; }
    else if (!any) { message = 'No signal'; hint = 'Patch a cable into X or Y1–Y4'; }
    else if (!anyResolved) { message = 'Probe unresolved'; hint = 'The probed module or port no longer exists'; }
    else if (mode === 'xy' && !resolved('x')) { message = 'No X signal'; hint = 'XY mode plots each Y against X'; }
    if (message) {
      traceContext.clearRect(0, 0, width, height); lastXY = NaN; triggered = false;
      setStatus(message, hint); updateHud(rate); clearReadouts(); return;
    }
    const valid = mode === 'xy' ? drawXY(p, rate) : drawYT(p, rate);
    if (valid === 0) setStatus('No signal', hasData ? 'No probe data at this position' : p.playing ? 'Waiting for audio…' : 'Press Play to start the live synth');
    else setStatus('');
    updateReadouts(rate, host?.performance?.now() ?? 0);
  }
  function tick() {
    frame = 0;
    if (destroyed) return;
    schedule();
    if (root.ownerDocument.hidden) return;
    const p = position();
    if (p.frame !== lastFrame || p.live !== lastLive || p.playing !== lastPlaying) dirty = true;
    if (!dirty) return;
    dirty = false; lastFrame = p.frame; lastLive = p.live; lastPlaying = p.playing;
    draw(p);
  }

  // ---- public ----
  function applyView(state = {}) {
    if (TIMEBASES.includes(Number(state.timebase))) view.timebase = Number(state.timebase);
    if (typeof state.triggerSource === 'string' && (state.triggerSource === '' || CHANNELS.includes(state.triggerSource))) view.triggerSource = state.triggerSource;
    if (Number.isFinite(state.triggerLevel)) view.triggerLevel = state.triggerLevel;
    if (state.triggerSlope === 'rising' || state.triggerSlope === 'falling') view.triggerSlope = state.triggerSlope;
    if (TRIGGER_MODES.includes(state.triggerMode)) view.triggerMode = state.triggerMode;
    if (state.persistence in PERSISTENCE) view.persistence = state.persistence;
    for (const channel of CHANNELS) {
      const scale = Number(state.scales?.[channel]), offset = state.offsets?.[channel];
      if (SCALES.includes(scale)) view.scales[channel] = scale;
      if (Number.isFinite(offset)) view.offsets[channel] = Math.max(-8, Math.min(8, offset));
    }
  }
  syncControls(); setStatus('No signal', 'Patch a cable into X or Y1–Y4'); schedule();

  return {
    push(block) {
      if (destroyed || !ring.write(block)) return false;
      hasData = true; dirty = true;
      const next = Array.isArray(block.unresolved) ? block.unresolved : [];
      if (next.length !== blockUnresolved.size || next.some(c => !blockUnresolved.has(c))) { blockUnresolved = new Set(next); syncControls(); }
      schedule();
      return true;
    },
    reset() {
      if (destroyed) return;
      ring.clear(); hasData = false; triggered = false; lastXY = NaN; readoutAt = -Infinity;
      if (blockUnresolved.size) { blockUnresolved = new Set(); syncControls(); }
      if (width && height) traceContext.clearRect(0, 0, width, height);
      dirty = true; schedule();
    },
    setInputs({ mode: nextMode, inputs = {}, labels: nextLabels = {}, unresolved: nextUnresolved = [] } = {}) {
      if (destroyed) return;
      if (nextMode === 'yt' || nextMode === 'xy') { if (nextMode !== mode) lastXY = NaN; mode = nextMode; }
      patched = new Set(CHANNELS.filter(c => inputs?.[c]));
      labels = { ...(nextLabels || {}) };
      unresolved = new Set(Array.isArray(nextUnresolved) ? nextUnresolved : []);
      blockUnresolved = new Set();
      syncControls(); schedule();
    },
    setView(state) {
      if (destroyed) return;
      applyView(state); lastXY = NaN; syncControls(); schedule();
    },
    refresh() {
      if (destroyed) return;
      bind(); sized = false; gridDirty = true; dirty = true; lastXY = NaN; schedule();
    },
    get view() { return { mode, ...view, scales: { ...view.scales }, offsets: { ...view.offsets } }; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame && host && !host.closed) host.cancelAnimationFrame(frame);
      frame = 0; observer?.disconnect(); observer = null;
      root.replaceChildren(); root.classList.remove('scope-view'); delete root.dataset.mode;
    },
  };
}
