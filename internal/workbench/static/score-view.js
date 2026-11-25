// Native ES module. Rendering is deliberately independent of the audio engine.
const ROW = 30;
const LANE = 104;
const RULER = 28;
const MAX_STEPS = 262144;
const MAX_ORDERS = 16384;
const MAX_WIDTH = 180000;
const escapePointer = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const format = value => Number(value.toFixed(4)).toString();
const pitchNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
const pitchName = midi => midi == null ? '—' : `${pitchNames[midi % 12]}${Math.floor(midi / 12) - 1}`;

function midiPitch(note, transpose = 0) {
  if (typeof note !== 'string') return null;
  const match = /^([A-Ga-g])([#b]?)(-?\d{1,2})$/.exec(note);
  if (!match) return null;
  const midi = (Number(match[3]) + 1) * 12 + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1].toUpperCase()] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
  return midi >= 0 && midi <= 127 && Number.isInteger(transpose) && midi + transpose >= 0 && midi + transpose <= 127 ? midi + transpose : null;
}

function buildTimeline(project) {
  project = project && typeof project === 'object' ? project : {};
  const bpm = clamp(finite(project.bpm, 120), 1, 1000);
  const beats = clamp(finite(project.beats, 4), 0.000001, 5000);
  const sampleRate = clamp(finite(project.sample_rate, 48000), 8000, 96000);
  const samplesPerBeat = 60 / bpm * sampleRate;
  const musicalEndSample = Math.round(beats * samplesPerBeat);
  const tracks = [];
  let count = 0, orders = 0, extent = beats, truncated = false;
  for (const [index, source] of (Array.isArray(project.tracks) ? project.tracks.slice(0, 32) : []).entries()) {
    const track = source && typeof source === 'object' ? source : {};
    const transpose = finite(track.transpose, 0);
    const model = { index, id: typeof track.id === 'string' ? track.id : `Track ${index + 1}`, transpose, occurrences: [], steps: [], min: 48, max: 72, end: 0 };
    let beat = 0, correction = 0;
    const pitches = [];
    const order = Array.isArray(track.order) ? track.order : [];
    for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
      if (orders++ >= MAX_ORDERS || count >= MAX_STEPS) { truncated = true; break; }
      const name = typeof order[orderIndex] === 'string' ? order[orderIndex] : '(invalid pattern)';
      const pattern = track.patterns && Object.hasOwn(track.patterns, name) && Array.isArray(track.patterns[name]) ? track.patterns[name] : [];
      const occurrence = { name, index: orderIndex, start: beat, end: beat, steps: [], pointer: `/tracks/${index}/patterns/${escapePointer(name)}`, missing: !pattern.length };
      for (let stepIndex = 0; stepIndex < pattern.length; stepIndex++) {
        if (count++ >= MAX_STEPS) { truncated = true; break; }
        const raw = pattern[stepIndex] && typeof pattern[stepIndex] === 'object' ? pattern[stepIndex] : {};
        const duration = clamp(finite(raw.beats, 0), 0, 5000);
        const gate = clamp(finite(raw.gate, 0.85), 0, 1);
        const velocity = clamp(finite(raw.velocity, 1), 0, 1);
        const midi = midiPitch(raw.note, transpose);
        const start = beat;
        // Match the compiler's compensated accumulation of absolute boundaries.
        const increment = duration - correction;
        const next = beat + increment;
        correction = (next - beat) - increment;
        beat = next;
        const startSample = Math.round(start * samplesPerBeat);
        const endBeat = gate === 1 ? beat : Math.min(start + duration * gate, beat);
        const endSample = Math.min(Math.round(endBeat * samplesPerBeat), musicalEndSample);
        const step = { index: stepIndex, occurrence: orderIndex, start, end: beat, duration, gate, velocity, midi, rest: raw.note === '.', note: typeof raw.note === 'string' ? raw.note : '?', pointer: `${occurrence.pointer}/${stepIndex}`, startSample, endSample, gateEnd: endSample / samplesPerBeat, audible: midi !== null && gate > 0 && endSample > startSample };
        occurrence.steps.push(step);
        model.steps.push(step);
        if (midi !== null) pitches.push(midi);
      }
      occurrence.end = beat;
      model.occurrences.push(occurrence);
    }
    if (pitches.length) {
      model.min = Math.max(0, pitches.reduce((a, b) => Math.min(a, b), 127) - 3);
      model.max = Math.min(127, pitches.reduce((a, b) => Math.max(a, b), 0) + 3);
    }
    model.end = beat;
    extent = Math.max(extent, beat);
    tracks.push(model);
  }
  if (Array.isArray(project.tracks) && project.tracks.length > 32) truncated = true;
  return { tracks, bpm, beats, sampleRate, samplesPerBeat, musicalEndSample, extent, truncated };
}

function atBeat(items, beat) {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].start <= beat) low = middle + 1;
    else high = middle;
  }
  const item = items[low - 1];
  return item && beat >= item.start && beat < item.end ? item : null;
}

function playbackPosition(model, track, seconds) {
  const beat = Math.max(0, finite(seconds, 0)) * model.bpm / 60;
  const sample = Math.round(beat * model.samplesPerBeat);
  // The musical end is exclusive, including the release/effect tail.
  if (!track || sample >= model.musicalEndSample) return { beat, occurrence: null, step: null };
  let low = 0, high = track.steps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (track.steps[middle].startSample <= sample) low = middle + 1;
    else high = middle;
  }
  const candidate = track.steps[low - 1];
  const step = candidate && sample < Math.round(candidate.end * model.samplesPerBeat) ? candidate : null;
  return { beat, occurrence: step ? track.occurrences[step.occurrence] : null, step };
}

export function createScoreView(root, { onStateChange = () => {}, onReveal = () => {}, onSeek = () => {}, onScrub = () => {} } = {}) {
  let doc = root.ownerDocument;
  let win = doc.defaultView;
  let observer = null, hostCleanup = [];
  let model = buildTimeline(null), state = {}, seconds = 0, destroyed = false, frame = 0;
  let viewWidth = 640, scale = 32, contentWidth = 640, restoring = false;
  let canvases = [], labels = [], trackerKey = '', activeRow = null;
  let scrub = null, suppressRulerClick = false, rulerTime = 0;
  const cleanup = [];
  const el = (tag, className, text) => {
    const node = root.ownerDocument.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const listen = (node, type, callback) => { node.addEventListener(type, callback); cleanup.push(() => node.removeEventListener(type, callback)); };
  const button = (text, title, action) => { const node = el('button', 'sv-button', text); node.type = 'button'; node.title = title; listen(node, 'click', action); return node; };
  const persist = patch => { Object.assign(state, patch); if (!restoring && !destroyed) onStateChange(patch); };
  const selectedTrack = () => model.tracks[state.trackIndex] || model.tracks[0];
  const selectedOccurrence = () => selectedTrack()?.occurrences[state.occurrenceIndex];
  root.classList.add('score-view');
  const shell = el('div', 'sv-shell');
  const toolbar = el('div', 'sv-toolbar');
  const summary = el('div', 'sv-summary');
  const zoomLabel = el('label', 'sv-zoom', 'Zoom ');
  const zoom = el('input'); zoom.type = 'range'; zoom.min = '4'; zoom.max = '160'; zoom.step = '2'; zoom.setAttribute('aria-label', 'Arrangement zoom, pixels per beat');
  zoomLabel.append(zoom);
  const follow = button('Follow', 'Follow playback in selected track', () => { persist({ follow: !state.follow }); updateControls(); schedule(); });
  const fit = button('Fit score', 'Fit the complete ordered arrangement', () => { persist({ zoom: clamp(viewWidth / model.extent, 0.000001, 160), scrollBeat: 0 }); layout(); });
  const position = el('span', 'sv-position', '0:00');
  toolbar.append(summary, zoomLabel, fit, follow, position);
  const arrangement = el('div', 'sv-arrangement');
  const trackList = el('div', 'sv-tracks');
  const trackHeading = el('div', 'sv-track-heading', 'TRACK / TRANSPOSE');
  trackList.append(trackHeading);
  const scroller = el('div', 'sv-timeline'); scroller.tabIndex = 0; scroller.setAttribute('aria-label', 'Ordered score piano rolls; scroll horizontally to navigate');
  const spacer = el('div', 'sv-timeline-space');
  const viewport = el('div', 'sv-viewport');
  const ruler = el('canvas', 'sv-ruler'); ruler.tabIndex = 0;
  ruler.setAttribute('role', 'slider'); ruler.setAttribute('aria-valuemin', '0');
  ruler.setAttribute('aria-label', 'Beat ruler. Click to seek, drag to scrub, or use arrows, Home and End.');
  viewport.append(ruler); spacer.append(viewport); scroller.append(spacer); arrangement.append(trackList, scroller);
  const legend = el('div', 'sv-legend', '4-beat bar guides · brightness = velocity · solid = gate · dotted = rest / gate 0 · shaded = past musical end');
  const detail = el('section', 'sv-detail');
  const detailToolbar = el('div', 'sv-detail-toolbar');
  const title = el('strong', 'sv-detail-title');
  const previous = button('‹', 'Previous pattern occurrence', () => chooseOccurrence(state.occurrenceIndex - 1));
  const next = button('›', 'Next pattern occurrence', () => chooseOccurrence(state.occurrenceIndex + 1));
  const occurrenceInput = el('input', 'sv-occurrence'); occurrenceInput.type = 'number'; occurrenceInput.min = '1'; occurrenceInput.setAttribute('aria-label', 'Pattern occurrence in order');
  const totalOccurrences = el('span', 'sv-muted');
  const revealPattern = button('Source ↗', 'Reveal this pattern in the JSON tree', () => { const occurrence = selectedOccurrence(); if (occurrence) onReveal(occurrence.pointer); });
  const seekPattern = button('Seek here', 'Seek to this occurrence start', () => { const occurrence = selectedOccurrence(); if (occurrence) onSeek(occurrence.start * 60 / model.bpm); });
  detailToolbar.append(title, previous, occurrenceInput, totalOccurrences, next, seekPattern, revealPattern);
  const columns = el('div', 'sv-tracker-columns');
  for (const text of ['STEP', 'BAR : BEAT', 'WRITTEN → PLAYED', 'BEATS', 'GATE', 'VEL']) columns.append(el('span', '', text));
  const tracker = el('div', 'sv-tracker'); tracker.tabIndex = 0; tracker.setAttribute('aria-label', 'Pattern steps, including rests. Select a step to reveal its JSON source.');
  const trackerSpace = el('div', 'sv-tracker-space'); tracker.append(trackerSpace);
  const selection = el('div', 'sv-selection', 'Select a note or tracker row to reveal its JSON source.');
  const empty = el('div', 'sv-empty');
  detail.append(detailToolbar, columns, tracker, selection);
  shell.append(toolbar, arrangement, legend, empty, detail); root.append(shell);

  function updateControls() {
    zoom.value = String(clamp(state.zoom, 4, 160));
    follow.setAttribute('aria-pressed', String(!!state.follow));
    labels.forEach((label, index) => label.setAttribute('aria-pressed', String(index === state.trackIndex)));
  }

  function chooseTrack(index) {
    persist({ trackIndex: index, occurrenceIndex: 0, selectedStep: -1, trackerScroll: 0 });
    tracker.scrollTop = 0; trackerKey = ''; updateControls(); updateDetail(); schedule();
  }

  function chooseOccurrence(index, playback = false) {
    const track = selectedTrack();
    if (!track?.occurrences.length) return;
    index = clamp(Math.round(finite(index, 0)), 0, track.occurrences.length - 1);
    persist({ occurrenceIndex: index, selectedStep: -1, trackerScroll: 0 });
    tracker.scrollTop = 0; trackerKey = ''; updateDetail();
    if (!playback) {
      const beat = track.occurrences[index].start;
      if (beat * scale < scroller.scrollLeft || beat * scale > scroller.scrollLeft + viewWidth) scroller.scrollLeft = beat * scale;
    }
    schedule();
  }

  function selectStep(step) {
    persist({ selectedStep: step.index });
    selection.textContent = `${step.pointer} · beat ${format(step.start)} · ${step.rest ? 'rest' : `${step.note} → ${pitchName(step.midi)}`} · gate ${format(Math.max(0, step.gateEnd - step.start))} beats${step.start >= model.beats ? ' · outside musical end' : ''}`;
    onReveal(step.pointer); trackerKey = ''; renderTracker(); schedule();
  }

  function updateDetail() {
    const track = selectedTrack(), occurrence = selectedOccurrence();
    detail.hidden = !track;
    title.textContent = track ? `${track.id} / ${occurrence?.name ?? 'No ordered pattern'}` : '';
    occurrenceInput.value = String((occurrence?.index ?? 0) + 1);
    occurrenceInput.max = String(track?.occurrences.length || 1);
    occurrenceInput.disabled = !occurrence;
    totalOccurrences.textContent = `/ ${track?.occurrences.length || 0}`;
    previous.disabled = !occurrence || occurrence.index === 0;
    next.disabled = !occurrence || occurrence.index === track.occurrences.length - 1;
    revealPattern.disabled = seekPattern.disabled = !occurrence;
    selection.textContent = occurrence ? `${occurrence.pointer} · occurrence ${occurrence.index + 1} · beats ${format(occurrence.start)}–${format(occurrence.end)}${occurrence.missing ? ' · missing or empty pattern' : ''}` : 'Add patterns and an order to this track.';
    trackerSpace.style.height = `${Math.max(ROW, (occurrence?.steps.length || 0) * ROW)}px`;
    trackerKey = ''; renderTracker();
  }

  function barBeat(beat) { return `${Math.floor(beat / 4) + 1}:${format(beat % 4 + 1)}`; }

  function renderTracker() {
    const occurrence = selectedOccurrence();
    const steps = occurrence?.steps || [];
    const first = Math.max(0, Math.floor(tracker.scrollTop / ROW) - 3);
    const last = Math.min(steps.length, first + Math.ceil((tracker.clientHeight || 300) / ROW) + 8);
    const key = `${state.trackIndex}/${state.occurrenceIndex}/${first}/${last}/${state.selectedStep}`;
    if (key !== trackerKey) {
      trackerKey = key; trackerSpace.replaceChildren(); activeRow = null;
      if (!steps.length) trackerSpace.append(el('div', 'sv-no-steps', 'No steps in this occurrence.'));
      for (let i = first; i < last; i++) {
        const step = steps[i];
        const row = el('button', `sv-step${step.rest ? ' sv-rest' : ''}${step.start >= model.beats ? ' sv-outside' : ''}`);
        row.type = 'button'; row.style.top = `${i * ROW}px`; row.dataset.index = String(i);
        row.setAttribute('aria-pressed', String(state.selectedStep === i));
        row.title = `${step.pointer} · click to reveal JSON`;
        const fields = [String(i + 1).padStart(3, '0'), barBeat(step.start), step.rest ? '· REST' : `${step.note} → ${pitchName(step.midi)}`, format(step.duration), `${Math.round(step.gate * 100)}%`, step.rest ? '—' : `${Math.round(step.velocity * 100)}%`];
        fields.forEach(text => row.append(el('span', '', text)));
        // Delegation below avoids accumulating listeners when rows are recycled.
        trackerSpace.append(row);
      }
    }
    if (activeRow) { activeRow.classList.remove('is-playing'); activeRow.removeAttribute('aria-current'); }
    const current = playbackPosition(model, selectedTrack(), seconds);
    activeRow = current.occurrence?.index === state.occurrenceIndex && current.step ? trackerSpace.querySelector(`[data-index="${current.step.index}"]`) : null;
    if (activeRow) { activeRow.classList.add('is-playing'); activeRow.setAttribute('aria-current', 'true'); }
  }

  function canvasContext(canvas, height) {
    const ratio = Math.min(2, win.devicePixelRatio || 1);
    const width = Math.min(4096, Math.max(1, viewWidth));
    const pixels = Math.ceil(width * ratio), rows = Math.ceil(height * ratio);
    if (canvas.width !== pixels || canvas.height !== rows) { canvas.width = pixels; canvas.height = rows; }
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    context.font = '11px ui-monospace, monospace';
    return context;
  }

  function draw() {
    frame = 0;
    if (destroyed) return;
    if (syncHost()) { layout(); return; }
    if (doc.hidden) return;
    const offset = scroller.scrollLeft, leftBeat = offset / scale, rightBeat = (offset + viewWidth) / scale;
    const styles = win.getComputedStyle(root);
    const color = name => styles.getPropertyValue(name).trim();
    const ink = color('--ink') || '#e5edf7', muted = color('--muted') || '#8b9bb0', line = color('--line') || '#2c3646';
    const accent = color('--accent') || '#c2f970', blue = color('--blue') || '#76b6ff', orange = color('--orange') || '#ffbe70';
    const x = beat => beat * scale - offset;
    const gridStep = scale >= 20 ? 1 : Math.max(4, 4 * 2 ** Math.ceil(Math.log2(64 / (4 * scale))));
    const rulerContext = canvasContext(ruler, RULER);
    if (rulerContext) {
      rulerContext.fillStyle = muted;
      for (let beat = Math.ceil(leftBeat / gridStep) * gridStep; beat <= rightBeat; beat += gridStep) {
        rulerContext.fillRect(x(beat), 20, 1, 8);
        if (beat % 4 === 0) rulerContext.fillText(`${Math.floor(beat / 4) + 1}`, x(beat) + 4, 13);
      }
      rulerContext.fillStyle = orange;
      const endX = x(model.beats);
      if (endX >= 0 && endX <= viewWidth) rulerContext.fillText('END', Math.max(0, Math.min(viewWidth - 26, endX - 26)), 13);
    }
    for (let trackIndex = 0; trackIndex < model.tracks.length; trackIndex++) {
      const track = model.tracks[trackIndex], context = canvasContext(canvases[trackIndex], LANE);
      if (!context) continue;
      const selected = state.trackIndex === trackIndex;
      const noteColor = selected ? accent : blue;
      const pitchHeight = 72 / (track.max - track.min + 1);
      const y = midi => 25 + (track.max - midi) * pitchHeight;
      for (let midi = track.min; midi <= track.max; midi++) {
        if ([1, 3, 6, 8, 10].includes(midi % 12)) { context.fillStyle = '#ffffff05'; context.fillRect(0, y(midi), viewWidth, pitchHeight); }
      }
      context.strokeStyle = line; context.lineWidth = 1;
      context.beginPath();
      for (let beat = Math.ceil(leftBeat / gridStep) * gridStep; beat <= rightBeat; beat += gridStep) { context.moveTo(x(beat) + 0.5, 23); context.lineTo(x(beat) + 0.5, LANE); }
      context.stroke();
      // Binary-search the first visible occurrence and step; no full scan per frame.
      let start = firstVisible(track.occurrences, leftBeat);
      for (let i = start; i < track.occurrences.length && track.occurrences[i].start <= rightBeat; i++) {
        const occurrence = track.occurrences[i];
        const from = Math.max(0, x(occurrence.start)), to = Math.min(viewWidth, x(occurrence.end));
        context.fillStyle = selected && state.occurrenceIndex === i ? '#c2f97024' : (i % 2 ? '#ffffff0b' : '#ffffff05');
        context.fillRect(from, 0, Math.max(1, to - from), 21);
        context.fillStyle = muted; context.fillRect(x(occurrence.start), 0, 1, LANE);
        if (to - from > 25) {
          context.save(); context.beginPath(); context.rect(from + 3, 0, Math.max(0, to - from - 5), 21); context.clip();
          context.fillStyle = selected && state.occurrenceIndex === i ? accent : ink;
          context.fillText(`${i + 1} ${occurrence.name}`, from + 5, 14); context.restore();
        }
      }
      start = firstVisible(track.steps, leftBeat);
      // Aggregate subpixel notes naturally onto a bounded viewport; cap drawing work.
      const visibleEnd = Math.min(track.steps.length, firstVisible(track.steps, rightBeat) + 1);
      const stride = Math.max(1, Math.ceil((visibleEnd - start) / 10000));
      for (let i = start; i < visibleEnd; i += stride) {
        const step = track.steps[i], from = Math.max(-2, x(step.start));
        const width = Math.max(1, Math.min(viewWidth + 2, x(step.end)) - from);
        context.globalAlpha = step.start >= model.beats ? 0.24 : 0.3 + step.velocity * 0.7;
        const top = step.midi === null ? 88 : y(step.midi);
        context.fillStyle = step.rest || step.midi === null ? muted : noteColor;
        if (step.rest || !step.audible) {
          context.setLineDash([2, 3]); context.strokeStyle = context.fillStyle;
          context.beginPath(); context.moveTo(from, top + 2); context.lineTo(from + width, top + 2); context.stroke(); context.setLineDash([]);
        } else {
          context.globalAlpha *= 0.22; context.fillRect(from, top, width, Math.max(2, pitchHeight - 1)); context.globalAlpha /= 0.22;
          context.fillRect(from, top, Math.max(1, Math.min(viewWidth + 2, x(step.gateEnd)) - from), Math.max(2, pitchHeight - 1));
          if (selected && state.occurrenceIndex === step.occurrence && state.selectedStep === step.index) { context.strokeStyle = ink; context.strokeRect(from - 1, top - 1, width + 2, Math.max(3, pitchHeight + 1)); }
        }
      }
      context.globalAlpha = 1;
      const endX = x(model.beats);
      if (endX < viewWidth) { context.fillStyle = '#02050a66'; context.fillRect(Math.max(0, endX), 22, viewWidth - Math.max(0, endX), LANE - 22); }
      if (endX >= 0 && endX <= viewWidth) { context.fillStyle = orange; context.fillRect(endX, 0, 1, LANE); }
      context.fillStyle = muted; context.fillText(pitchName(track.max), 4, 33);
      const playBeat = seconds * model.bpm / 60;
      if (playBeat >= 0 && playBeat <= model.beats && x(playBeat) >= 0 && x(playBeat) <= viewWidth) { context.fillStyle = ink; context.fillRect(x(playBeat), 21, 1.5, LANE - 21); }
    }
    renderTracker();
  }

  function firstVisible(items, beat) {
    let low = 0, high = items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (items[middle].end < beat) low = middle + 1; else high = middle; }
    return low;
  }

  function syncHost() {
    if (doc === root.ownerDocument && hostCleanup.length) return false;
    scrub?.cancel();
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0; observer?.disconnect(); hostCleanup.splice(0).forEach(remove => remove());
    doc = root.ownerDocument; win = doc.defaultView;
    const host = win;
    const resize = () => { if (!destroyed && root.ownerDocument.defaultView === host) layout(); };
    const visibility = () => {
      if (doc.hidden) { if (frame) win.cancelAnimationFrame(frame); frame = 0; }
      else resize();
    };
    host.addEventListener('resize', resize); doc.addEventListener('visibilitychange', visibility);
    const hostDoc = doc;
    hostCleanup.push(() => host.removeEventListener('resize', resize), () => hostDoc.removeEventListener('visibilitychange', visibility));
    observer = typeof host.ResizeObserver === 'function' ? new host.ResizeObserver(resize) : null;
    observer?.observe(root);
    return true;
  }

  function schedule() {
    if (destroyed) return;
    syncHost();
    if (!frame && !doc.hidden) frame = win.requestAnimationFrame(draw);
  }

  function layout() {
    if (destroyed) return;
    syncHost();
    viewWidth = Math.min(4096, Math.max(1, scroller.clientWidth || (root.clientWidth ? root.clientWidth - 144 : 640)));
    scale = Math.min(clamp(finite(state.zoom, 32), 0.000001, 160), MAX_WIDTH / model.extent);
    contentWidth = Math.max(viewWidth, model.extent * scale + 24);
    spacer.style.width = `${contentWidth}px`; viewport.style.width = `${viewWidth}px`;
    scroller.scrollLeft = clamp(finite(state.scrollBeat, 0) * scale, 0, Math.max(0, contentWidth - viewWidth));
    tracker.scrollTop = finite(state.trackerScroll, 0);
    tracker.scrollLeft = finite(state.trackerLeft, 0);
    arrangement.scrollTop = finite(state.arrangementScroll, 0);
    columns.style.transform = `translateX(${-tracker.scrollLeft}px)`;
    updateControls(); schedule();
  }

  listen(zoom, 'input', () => { persist({ zoom: Number(zoom.value) }); layout(); });
  listen(occurrenceInput, 'change', () => chooseOccurrence(Number(occurrenceInput.value) - 1));
  listen(scroller, 'scroll', () => { if (!restoring) persist({ scrollBeat: scroller.scrollLeft / scale }); schedule(); });
  listen(tracker, 'scroll', () => {
    if (!restoring) persist({ trackerScroll: tracker.scrollTop, trackerLeft: tracker.scrollLeft });
    columns.style.transform = `translateX(${-tracker.scrollLeft}px)`;
    renderTracker();
  });
  listen(arrangement, 'scroll', () => { if (!restoring) persist({ arrangementScroll: arrangement.scrollTop }); });
  listen(trackerSpace, 'click', event => {
    const row = event.target.closest('button[data-index]');
    if (!row || !trackerSpace.contains(row)) return;
    const step = selectedOccurrence()?.steps[Number(row.dataset.index)]; if (step) selectStep(step);
  });
  listen(trackList, 'click', event => {
    const control = event.target.closest('button[data-track]');
    if (!control) return;
    const index = Number(control.dataset.track);
    if (control.dataset.reveal) onReveal(`/tracks/${index}`); else chooseTrack(index);
  });
  function rulerPosition(event) {
    return clamp((event.clientX - ruler.getBoundingClientRect().left + scroller.scrollLeft) / scale, 0, model.beats) * 60 / model.bpm;
  }
  function updateRuler(time) {
    const duration = model.beats * 60 / model.bpm;
    rulerTime = clamp(time, 0, duration);
    ruler.setAttribute('aria-valuemax', String(duration));
    ruler.setAttribute('aria-valuenow', String(rulerTime));
    ruler.setAttribute('aria-valuetext', `${format(rulerTime)} seconds · ${barBeat(rulerTime * model.bpm / 60)}`);
  }
  listen(ruler, 'pointerdown', event => {
    if (event.button !== 0 || scrub || destroyed) return;
    syncHost();
    suppressRulerClick = false;
    ruler.focus({ preventScroll: true });
    const host = root.ownerDocument.defaultView, pointer = event.pointerId;
    const original = rulerTime, start = rulerPosition(event), startX = event.clientX;
    let dragged = false, done = false, latest = start;
    const finish = (cancelled, e) => {
      if (done) return;
      done = true;
      host.removeEventListener('pointermove', move); host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', pointerCancel); host.removeEventListener('keydown', key, true); host.removeEventListener('blur', cancel);
      ruler.removeEventListener('lostpointercapture', pointerCancel);
      scrub = null;
      if (ruler.hasPointerCapture(pointer)) ruler.releasePointerCapture(pointer);
      ruler.classList.remove('is-scrubbing');
      suppressRulerClick = cancelled || dragged;
      if (cancelled) updateRuler(original);
      else if (dragged) { latest = rulerPosition(e); updateRuler(latest); }
      if (dragged) onScrub(cancelled ? original : latest, { phase: cancelled ? 'cancel' : 'end' });
    };
    const cancel = () => finish(true);
    const pointerCancel = e => { if (e.pointerId === pointer) cancel(); };
    const move = e => {
      if (e.pointerId !== pointer || done) return;
      if (root.ownerDocument.defaultView !== host) { cancel(); return; }
      if (!dragged) {
        if (Math.abs(e.clientX - startX) < 3) return;
        dragged = true; ruler.classList.add('is-scrubbing');
        onScrub(start, { phase: 'start' });
        if (done) return;
      }
      latest = rulerPosition(e); updateRuler(latest); onScrub(latest, { phase: 'move' });
    };
    const up = e => { if (e.pointerId === pointer) finish(false, e); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
    scrub = { cancel };
    host.addEventListener('pointermove', move); host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', pointerCancel); host.addEventListener('keydown', key, true); host.addEventListener('blur', cancel);
    ruler.addEventListener('lostpointercapture', pointerCancel);
    try { ruler.setPointerCapture(pointer); } catch { cancel(); }
    event.preventDefault();
  });
  listen(ruler, 'click', event => {
    if (suppressRulerClick || destroyed) { suppressRulerClick = false; return; }
    const time = rulerPosition(event); updateRuler(time); onSeek(time);
  });
  listen(ruler, 'keydown', event => {
    const direction = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (scrub || destroyed) return;
    const duration = model.beats * 60 / model.bpm;
    const time = event.key === 'Home' ? 0 : event.key === 'End' ? duration : clamp(rulerTime + direction * 60 / model.bpm * (event.shiftKey ? 0.25 : 1), 0, duration);
    updateRuler(time); onSeek(time);
  });
  listen(viewport, 'click', event => {
    const canvas = event.target.closest('canvas[data-track]'); if (!canvas) return;
    const trackIndex = Number(canvas.dataset.track), track = model.tracks[trackIndex];
    const beat = (event.clientX - canvas.getBoundingClientRect().left + scroller.scrollLeft) / scale;
    const occurrence = atBeat(track.occurrences, beat);
    if (state.trackIndex !== trackIndex) chooseTrack(trackIndex);
    if (occurrence) {
      chooseOccurrence(occurrence.index);
      const step = atBeat(occurrence.steps, beat);
      if (step && event.clientY - canvas.getBoundingClientRect().top >= 22) {
        tracker.scrollTop = Math.max(0, step.index * ROW - 90); selectStep(step);
      } else onReveal(`/tracks/${trackIndex}/order/${occurrence.index}`);
    }
  });
  syncHost();

  return {
    setProject(project, savedState = {}) {
      if (destroyed) return;
      scrub?.cancel();
      restoring = true;
      model = buildTimeline(project);
      updateRuler(seconds);
      savedState = savedState && typeof savedState === 'object' ? savedState : {};
      state = {
        trackIndex: clamp(Math.floor(finite(savedState.trackIndex, 0)), 0, Math.max(0, model.tracks.length - 1)),
        occurrenceIndex: Math.max(0, Math.floor(finite(savedState.occurrenceIndex, 0))),
        selectedStep: Math.floor(finite(savedState.selectedStep, -1)),
        zoom: clamp(finite(savedState.zoom, 32), 0.000001, 160),
        scrollBeat: Math.max(0, finite(savedState.scrollBeat, 0)),
        trackerScroll: Math.max(0, finite(savedState.trackerScroll, 0)),
        trackerLeft: Math.max(0, finite(savedState.trackerLeft, 0)),
        arrangementScroll: Math.max(0, finite(savedState.arrangementScroll, 0)),
        follow: savedState.follow === true,
      };
      state.occurrenceIndex = Math.min(state.occurrenceIndex, Math.max(0, (selectedTrack()?.occurrences.length || 1) - 1));
      trackList.replaceChildren(trackHeading); viewport.replaceChildren(ruler); canvases = []; labels = [];
      for (const track of model.tracks) {
        const label = el('div', 'sv-track-label');
        const select = el('button', 'sv-track-select'); select.type = 'button'; select.dataset.track = String(track.index); select.title = `Inspect ${track.id}`;
        select.append(el('strong', '', track.id), el('span', '', `${track.transpose >= 0 ? '+' : ''}${track.transpose} st · ${track.occurrences.length} patterns`), el('small', '', `${format(track.end)} beats`));
        const reveal = el('button', 'sv-track-source', '↗'); reveal.type = 'button'; reveal.dataset.track = String(track.index); reveal.dataset.reveal = 'true'; reveal.title = `Reveal track ${track.id} in JSON`; reveal.setAttribute('aria-label', reveal.title);
        label.append(select, reveal); trackList.append(label); labels.push(select);
        const canvas = el('canvas', 'sv-lane'); canvas.dataset.track = String(track.index); canvas.setAttribute('aria-label', `${track.id}: ordered piano roll. Use the track controls and tracker for keyboard navigation.`); canvases.push(canvas); viewport.append(canvas);
      }
      summary.textContent = `${model.tracks.length} TRACKS · ${format(model.bpm)} BPM · ${format(model.beats)} BEATS`;
      empty.hidden = model.tracks.length > 0 && !model.truncated;
      empty.textContent = model.truncated ? 'Visualisation limit reached; showing a bounded preview of this score.' : 'No sequenced tracks yet. Add a track with patterns and an order to see its score.';
      arrangement.hidden = !model.tracks.length;
      layout(); updateDetail(); tracker.scrollTop = state.trackerScroll; tracker.scrollLeft = state.trackerLeft; arrangement.scrollTop = state.arrangementScroll; trackerKey = ''; renderTracker();
      restoring = false;
    },
    setTime(time) {
      if (destroyed) return;
      seconds = Math.max(0, finite(time, 0));
      if (!scrub) updateRuler(seconds);
      const current = playbackPosition(model, selectedTrack(), seconds);
      position.textContent = `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')} · ${current.beat >= model.beats ? 'END / TAIL' : barBeat(current.beat)}`;
      if (!scrub && state.follow && current.occurrence) {
        if (state.occurrenceIndex !== current.occurrence.index) chooseOccurrence(current.occurrence.index, true);
        const x = current.beat * scale;
        if (x < scroller.scrollLeft || x > scroller.scrollLeft + viewWidth * 0.85) scroller.scrollLeft = Math.max(0, x - viewWidth * 0.2);
        if (current.step) {
          const y = current.step.index * ROW;
          if (y < tracker.scrollTop || y + ROW > tracker.scrollTop + tracker.clientHeight) tracker.scrollTop = Math.max(0, y - ROW * 2);
        }
      }
      schedule();
    },
    refreshLayout() { layout(); trackerKey = ''; renderTracker(); },
    destroy() {
      if (destroyed) return;
      scrub?.cancel();
      destroyed = true; if (frame) win.cancelAnimationFrame(frame); observer?.disconnect(); hostCleanup.splice(0).forEach(remove => remove()); cleanup.forEach(remove => remove()); shell.remove(); root.classList.remove('score-view');
    },
  };
}
