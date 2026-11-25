import { createScoreView } from './score-view.js';
import { createRackView } from './rack-view.js';
import { createJSONTree } from './json-tree.js';
import { createPaneWindows } from './pane-windows.js';
import { synthRequest } from './render-client.js';
import { createTransportUI } from './transport-ui.js';
import { materializeDefaults, editParameter, reconnectProject } from './rack-model.js';
import {
  prepareProject, atPointer, setPointer, soundSignature, readProjectState, storeProjectState,
  listSavedProjects, LAST_PROJECT_KEY, LEGACY_DRAFT_KEY,
} from './project-state.js';

// Pane contents may move into another same-origin document. Keep stable element
// references so all windows still use this one project model and these handlers.
const elements = new Map(Array.from(document.querySelectorAll('[id]'), element => [element.id, element]));
const $ = id => elements.get(id) || document.getElementById(id);
const paneElements = Array.from(document.querySelectorAll('[data-pane]'));
const audio = $('audio'), editor = $('editor');
const defaultPanes = { monitor: true, score: true, rack: true, json: false, source: false };
let project = null, browserState = {}, sourceDirty = false, sourceDraft = '';
let currentSignature = '';
let wavURL = null, wavePeaks = null, rendered = null, busy = false, requestSerial = 0;
let loadSerial = 0;
let revision = 0, paneWindows = null, transport = null;
let settingPanes = false, editTimer, viewSaveTimer;
let storage = null;
try { storage = window.localStorage; } catch { /* Editing/rendering work without storage. */ }

function status(text, kind = '') { $('status').textContent = text; $('status').className = 'status ' + kind; }
function slug(text) { return (text || 'pipe-go-doep').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'; }
function serialise() { return JSON.stringify(project, null, 2) + '\n'; }
function prepareWorkbenchProject(value, fallbackID) {
  const next = prepareProject(value, fallbackID);
  materializeDefaults(next);
  return next;
}
function db(value) { return value > 0 ? (20 * Math.log10(value)).toFixed(1) + ' dB' : '−∞ dB'; }

function refreshProjectMenu() {
  const select = $('saved-projects');
  const initial = document.createElement('option'); initial.value = ''; initial.textContent = 'Browser projects';
  select.replaceChildren(initial);
  if (!storage) return;
  for (const saved of listSavedProjects(storage)) {
    const option = document.createElement('option'); option.value = saved.id;
    option.textContent = saved.title + (saved.id === project?.id ? ' · current' : '');
    select.append(option);
  }
}

function saveDraft() {
  if (!project) return;
  // Native <details> toggle events are queued. Read current DOM state so an
  // immediate reload/project switch also preserves the last click.
  const panes = Object.fromEntries(paneElements.map(pane => [pane.dataset.pane, pane.open]));
  browserState = {
    ...browserState, panes, draft: serialise(), title: project.title || 'Untitled project',
    sourceDraft: sourceDirty ? sourceDraft : null, updated: Date.now(),
  };
  try {
    if (!storage) throw Error('storage unavailable');
    storeProjectState(storage, project.id, browserState);
    $('draft').textContent = sourceDirty ? 'Source edits saved · not applied' : 'Saved in this browser';
    refreshProjectMenu();
  } catch { $('draft').textContent = 'Browser storage unavailable · use Save JSON'; }
}

function persistView(name, patch) {
  if (!project) return;
  browserState[name] = { ...(browserState[name] || {}), ...patch };
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveDraft, 150);
}

function allowVisualEdit() {
  if (sourceDirty) {
    status('Apply or reset the pending source edits before editing project fields.', 'error');
    setPane('json', true); setPane('source', true);
    return false;
  }
  return true;
}

const tree = createJSONTree($('json-tree'), {
  onExpanded(paths) {
    if (!project) return;
    // Tree state is non-musical metadata: do not invalidate rendered audio.
    project._ui.tree_expanded = paths;
    if (!sourceDirty) editor.value = serialise();
    saveDraft();
  },
  onEdit(path, value) {
    if (!allowVisualEdit()) { tree.setProject(project); return; }
    setPointer(project, path, value);
    syncProject();
    status('Project updated. Live playback follows edits; render to update the WAV.');
  },
  onError: message => status(message, 'error'),
});

function reveal(path) {
  setPane('json', true);
  tree.reveal(path);
  $('json-tree').ownerDocument.defaultView?.focus();
}

const scoreView = createScoreView($('score-view'), {
  onStateChange: patch => persistView('score', patch), onReveal: reveal,
  onSeek: seconds => transport?.seek(seconds),
  onScrub: (seconds, gesture) => transport?.scrub(seconds, gesture),
});
const rackView = createRackView($('rack-view'), {
  onStateChange: patch => persistView('rack', patch), onReveal: reveal,
  onRevealParameter({ nodeIndex, name }) {
    if (!project) return;
    const path = nodeIndex === null ? '/output/gain' : `/nodes/${nodeIndex}/params/${name}`;
    if (atPointer(project, path) === undefined) {
      if (!allowVisualEdit()) return;
      if (materializeDefaults(project)) syncProject();
    }
    if (atPointer(project, path) === undefined) { status('This control is not available in the project.', 'error'); return; }
    reveal(path);
  },
  onEditParameter(change) {
    if (!project || !allowVisualEdit()) return false;
    try {
      project = editParameter(project, change);
      syncProject();
      status(`${change.name} updated. Live playback follows the control.`, 'success');
      return true;
    } catch (e) { status(e.message, 'error'); return false; }
  },
  onPreviewParameter(change) {
    if (!project || sourceDirty) return;
    try { transport?.previewProject(editParameter(project, change)); }
    catch { /* Commit performs the canonical edit/error handling. */ }
  },
  onCancelParameter() { transport?.restorePreview(); },
  async onReconnect(change) {
    if (!project || !allowVisualEdit()) return false;
    const id = project.id, base = revision;
    try {
      const candidate = reconnectProject(project, change);
      const response = await synthRequest('validate', candidate);
      if (!response.ok) throw Error((await response.text()).trim());
      if (project?.id !== id) return false;
      if (base !== revision || sourceDirty) { status('Project changed while checking the cable. Try the reconnection again.', 'error'); return false; }
      // Tree navigation is allowed while validation is in flight; retain it.
      candidate._ui = project._ui;
      project = candidate; syncProject();
      status('Cable reconnected. Live playback is updating the patch.', 'success');
      return true;
    } catch (e) { if (project?.id === id) status(e.message, 'error'); return false; }
  },
  onError: message => status(message, 'error'),
});

paneWindows = createPaneWindows({
  panes: paneElements.filter(pane => pane.classList.contains('pane')),
  onLayout: refreshPane,
  onError: message => status(message, 'error'),
  onChange: () => saveDraft(),
});

transport = createTransportUI($('transport'), {
  audio, wave: $('wave'), onTime: seconds => scoreView.setTime(seconds),
  onError: message => status(message, 'error'),
  onStateChange: patch => persistView('transport', patch),
  canPlay: () => !!project && allowVisualEdit(),
  renderedMatches: () => rendered?.id === project?.id && rendered.signature === currentSignature,
});

function refreshPane(name) {
  if (name === 'rack') rackView.refreshLayout();
  if (name === 'score') {
    scoreView.refreshLayout();
  }
  if (name === 'monitor') { drawWave(); transport?.refresh(); }
}
function setPane(name, open) {
  const pane = $(`${name}-pane`);
  if (!pane) return;
  pane.open = open;
  browserState.panes = { ...(browserState.panes || {}), [name]: open };
  saveDraft();
  if (open) requestAnimationFrame(() => refreshPane(name));
}
function restorePanes() {
  settingPanes = true;
  for (const [name, defaultOpen] of Object.entries(defaultPanes)) {
    const saved = browserState.panes?.[name];
    $(`${name}-pane`).open = typeof saved === 'boolean' ? saved : defaultOpen;
  }
  settingPanes = false;
  requestAnimationFrame(() => { scoreView.refreshLayout(); rackView.refreshLayout(); drawWave(); });
}
for (const pane of paneElements) {
  pane.addEventListener('toggle', () => {
    if (settingPanes || !project) return;
    const name = pane.dataset.pane;
    browserState.panes = { ...(browserState.panes || {}), [name]: pane.open };
    saveDraft();
    if (pane.open) refreshPane(name);
  });
}

function markRenderState() {
  if (!rendered) { $('render-state').textContent = 'Awaiting render'; return; }
  const same = rendered.id === project?.id && rendered.signature === currentSignature;
  $('render-state').textContent = same ? 'Rendered · ready to play' : 'Edited · render to update';
}
function updateSourceStatus() {
  $('source-status').textContent = sourceDirty ? 'Unapplied edits' : 'Matches project';
  $('apply-source').disabled = $('revert-source').disabled = !sourceDirty;
}
function syncProject({ redrawTree = true } = {}) {
  if (!project) return;
  revision++;
  currentSignature = soundSignature(project);
  $('title').textContent = project.title || 'Untitled project';
  $('project-id').textContent = project.id;
  $('project-id').title = 'Project UUID: ' + project.id;
  $('metadata').textContent = `${project.bpm ?? '?'} BPM / ${project.sample_rate ?? '?'} Hz / ${(project.tracks || []).length} tracks`;
  const seconds = Number(project.beats || 0) * 60 / Number(project.bpm || 120);
  $('description').textContent = `${project.beats ?? '?'} beats · ${seconds.toFixed(1)}s + ${project.tail_seconds || 0}s tail`;
  $('tempo').value = project.bpm || 120;
  $('score-count').textContent = `${Array.isArray(project.tracks) ? project.tracks.length : 0} tracks · ${project.beats ?? '?'} beats`;
  $('patch-count').textContent = `${Array.isArray(project.nodes) ? project.nodes.length : 0} modules · ${Array.isArray(project.connections) ? project.connections.length : 0} cables`;
  if (!sourceDirty) editor.value = serialise();
  if (redrawTree) tree.setProject(project);
  scoreView.setProject(project, browserState.score || {});
  rackView.setProject(project, browserState.rack || {});
  transport?.setProject(project, browserState.transport || {});
  markRenderState(); updateSourceStatus(); saveDraft();
}

function clearAudio() {
  transport?.pause();
  requestSerial++;
  audio.pause(); audio.removeAttribute('src'); audio.load();
  if (wavURL) URL.revokeObjectURL(wavURL);
  wavURL = null; wavePeaks = null; rendered = null;
  $('download').removeAttribute('href'); $('download').setAttribute('aria-disabled', 'true');
  for (const id of ['peak', 'rms', 'clipped']) $(id).textContent = '—';
  scoreView.setTime(0); drawWave();
}

function openProject(value, { restoreDraft = false, fallbackID } = {}) {
  clearTimeout(editTimer);
  clearTimeout(viewSaveTimer);
  if (project) saveDraft();
  let next = prepareWorkbenchProject(value, fallbackID);
  let saved = storage ? readProjectState(storage, next.id) : {};
  if (restoreDraft && saved.draft) {
    try { next = prepareWorkbenchProject(JSON.parse(saved.draft), next.id); }
    catch { status('The saved draft could not be read; opening the supplied project.', 'error'); saved = {}; }
  }
  if (project?.id !== next.id) { paneWindows?.dockAll(); clearAudio(); }
  project = next; browserState = saved;
  sourceDirty = restoreDraft && typeof saved.sourceDraft === 'string';
  sourceDraft = sourceDirty ? saved.sourceDraft : '';
  editor.value = sourceDirty ? sourceDraft : serialise();
  restorePanes(); syncProject();
}

async function loadExample() {
  const token = ++loadSerial;
  try {
    const response = await fetch('/api/example?name=' + encodeURIComponent($('examples').value));
    if (!response.ok) throw Error(await response.text());
    const value = await response.json();
    if (token !== loadSerial) return;
    openProject(value, { restoreDraft: true });
    status('Project opened. Press Play for live audio, or Render audio to export a WAV.');
  } catch (e) { if (token === loadSerial) status(e.message, 'error'); }
}
$('load').onclick = loadExample;
$('saved-projects').onchange = () => {
  const id = $('saved-projects').value;
  if (!id || !storage) return;
  ++loadSerial;
  try { const saved = readProjectState(storage, id); openProject(JSON.parse(saved.draft), { restoreDraft: true }); status('Restored browser project.'); }
  catch (e) { status(e.message, 'error'); }
};
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return;
  const token = ++loadSerial;
  try {
    if (file.size > 2 * 1024 * 1024) throw Error('JSON file exceeds 2 MiB.');
    const value = JSON.parse(await file.text());
    if (token !== loadSerial) return;
    openProject(value); status('Opened ' + file.name);
  } catch (e) { if (token === loadSerial) status(e.message, 'error'); }
  $('file').value = '';
};

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('save').onclick = () => {
  if (!project) return;
  if (sourceDirty) { status('Apply or reset source edits before exporting the project.', 'error'); return; }
  downloadBlob(new Blob([serialise()], { type: 'application/json' }), slug(project.title) + '.json');
};
$('collapse-tree').onclick = () => tree.collapseAll();
$('apply-tempo').onclick = () => {
  if (!project || !allowVisualEdit()) return;
  const tempo = Number($('tempo').value);
  if (!Number.isFinite(tempo) || tempo < 1 || tempo > 1000) { status('Tempo must be between 1 and 1000 BPM.', 'error'); return; }
  project.bpm = tempo; syncProject(); status('Tempo updated. Render to hear the change.');
};

editor.addEventListener('input', () => {
  sourceDraft = editor.value; sourceDirty = sourceDraft !== serialise();
  updateSourceStatus(); clearTimeout(editTimer); editTimer = setTimeout(saveDraft, 200);
});
editor.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input'));
  }
});
$('revert-source').onclick = () => {
  sourceDirty = false; sourceDraft = ''; editor.value = serialise(); updateSourceStatus(); saveDraft();
  status('Source reset to the current project.');
};
async function applySource() {
  if (!project || !sourceDirty) return true;
  const originID = project.id, sourceText = editor.value;
  try {
    const next = prepareWorkbenchProject(JSON.parse(sourceText), project.id);
    const response = await synthRequest('validate', next);
    if (!response.ok) throw Error((await response.text()).trim());
    if (project?.id !== originID || editor.value !== sourceText) return false;
    sourceDirty = false; sourceDraft = '';
    if (next.id !== project.id) { ++loadSerial; openProject(next); }
    else { project = next; syncProject(); }
    status('Source applied. Score and rack updated.', 'success');
    return true;
  } catch (e) { status(e.message, 'error'); return false; }
}
$('apply-source').onclick = applySource;

function drawWave() {
  const canvas = $('wave'), rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  const w = rect.width, h = rect.height;
  ctx.strokeStyle = '#2c3a35'; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  if (!wavePeaks) { ctx.fillStyle = '#7a8e82'; ctx.font = '10px monospace'; ctx.fillText('RENDER A PROJECT TO VIEW AUDIO', 12, h / 2 - 10); return; }
  ctx.strokeStyle = '#c3f47b';
  for (let i = 0; i < w; i++) {
    const peak = wavePeaks[Math.min(wavePeaks.length - 1, Math.floor(i / w * wavePeaks.length))];
    ctx.beginPath(); ctx.moveTo(i, h / 2 - peak * h * .46); ctx.lineTo(i, h / 2 + peak * h * .46); ctx.stroke();
  }
}
function analyseWave(buffer) {
  const data = new DataView(buffer), frames = (buffer.byteLength - 44) / 4, buckets = 1200;
  wavePeaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    for (let i = Math.floor(b * frames / buckets); i < Math.floor((b + 1) * frames / buckets); i++) {
      wavePeaks[b] = Math.max(wavePeaks[b], Math.abs(data.getInt16(44 + i * 4, true)) / 32768, Math.abs(data.getInt16(46 + i * 4, true)) / 32768);
    }
  }
  drawWave();
}
async function request(action) {
  if (busy || !project) return;
  if (sourceDirty) { status('Apply or reset source edits before validating or rendering.', 'error'); setPane('json', true); setPane('source', true); return; }
  busy = true; $('render').disabled = $('validate').disabled = true;
  const token = ++requestSerial, snapshot = structuredClone(project), signature = soundSignature(snapshot);
  status(action === 'render' ? 'Rendering the signal graph…' : 'Checking project and patch…');
  try {
    const response = await synthRequest(action, snapshot);
    if (!response.ok) throw Error((await response.text()).trim());
    if (token !== requestSerial) return;
    if (action === 'validate') { status('Valid project, module controls, ports and signal graph.', 'success'); return; }
    const stats = JSON.parse(response.headers.get('X-Render-Stats')), buffer = await response.arrayBuffer();
    if (token !== requestSerial) return;
    audio.pause(); audio.removeAttribute('src'); audio.load(); if (wavURL) URL.revokeObjectURL(wavURL);
    wavURL = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })); audio.src = wavURL; audio.volume = .65;
    rendered = { id: snapshot.id, signature, bpm: snapshot.bpm };
    $('download').href = wavURL; $('download').download = slug(snapshot.title) + '.wav'; $('download').setAttribute('aria-disabled', 'false');
    $('peak').textContent = db(stats.peak); $('rms').textContent = db(stats.rms); $('clipped').textContent = stats.clipped_samples;
    markRenderState(); analyseWave(buffer); transport?.renderedReady();
    status(`${stats.seconds.toFixed(2)}s rendered in ${stats.render_seconds.toFixed(2)}s · ${(stats.seconds / stats.render_seconds).toFixed(1)}× realtime. Press play to listen.` + (stats.clipped_samples ? ' Lower output.gain to avoid clipping.' : ''), stats.clipped_samples ? 'error' : 'success');
  } catch (e) { if (token === requestSerial) status(e.message, 'error'); }
  finally { busy = false; $('render').disabled = $('validate').disabled = false; }
}
$('render').onclick = () => request('render'); $('validate').onclick = () => request('validate');
window.addEventListener('resize', drawWave);
window.addEventListener('pagehide', event => {
  paneWindows?.dockAll(); saveDraft();
  if (event.persisted) transport?.pause(); else transport?.destroy();
});

(async () => {
  const token = ++loadSerial;
  try {
    const response = await fetch('/api/examples'); if (!response.ok) throw Error(await response.text());
    const names = await response.json();
    if (token !== loadSerial) return;
    $('examples').replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name.replace('.json', ''); return option; }));
    const last = storage?.getItem(LAST_PROJECT_KEY), saved = last && readProjectState(storage, last);
    if (saved?.draft) { openProject(JSON.parse(saved.draft), { restoreDraft: true }); status('Restored project and browser workspace.'); }
    else {
      const legacy = storage?.getItem(LEGACY_DRAFT_KEY);
      if (legacy) {
        try { openProject(JSON.parse(legacy)); status('Migrated your existing draft to a UUID project.'); }
        catch { await loadExample(); status('The old draft is still in browser storage but could not be opened. An example is loaded.', 'error'); }
      } else if (names.length) await loadExample();
      else status('No examples found. Open a JSON project.');
    }
    refreshProjectMenu();
  } catch (e) { status(e.message, 'error'); }
})();
