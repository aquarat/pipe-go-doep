// Oscilloscope probes live in `_ui.scope`: UI metadata that never changes sound.
import { MODULES } from './rack-model.js';

export const SCOPE_CHANNELS = ['x', 'y1', 'y2', 'y3', 'y4'];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function scopeState(project) {
  const scope = object(object(project?._ui).scope);
  return { mode: scope.mode === 'xy' ? 'xy' : 'yt', inputs: object(scope.inputs) };
}

function validRef(ref) {
  ref = object(ref);
  if (Object.hasOwn(ref, 'bus')) return ref.bus === 'left' || ref.bus === 'right';
  return typeof ref.node === 'string' && ref.node !== '' && typeof ref.port === 'string' && ref.port !== '' &&
    (ref.direction === 'input' || ref.direction === 'output');
}

/** Probe list for the live engine, in channel order. */
export function probeList(project) {
  const { inputs } = scopeState(project);
  return SCOPE_CHANNELS.filter(channel => validRef(inputs[channel])).map(channel => {
    const ref = inputs[channel];
    return Object.hasOwn(ref, 'bus') ? { channel, bus: ref.bus } : { channel, node: ref.node, port: ref.port, direction: ref.direction };
  });
}

/** Short description of what a channel probes, e.g. `out lead [Pulse oscillator]`. */
export function probeLabel(project, ref) {
  ref = object(ref);
  if (Object.hasOwn(ref, 'bus')) return `${ref.bus === 'left' ? 'L' : 'R'} [Stereo output]`;
  const node = (Array.isArray(project?.nodes) ? project.nodes : []).find(n => object(n).id === ref.node);
  const title = node ? (MODULES[node.type]?.title || node.type).split(' · ')[0] : 'missing module';
  return `${ref.port} ${ref.node} [${title}]`;
}

export function probeLabels(project) {
  const { inputs } = scopeState(project);
  return Object.fromEntries(SCOPE_CHANNELS.filter(c => validRef(inputs[c])).map(c => [c, probeLabel(project, inputs[c])]));
}

/** Returns a copy of project with one scope channel patched (ref) or unplugged (null). */
export function setProbe(project, channel, ref) {
  if (!SCOPE_CHANNELS.includes(channel)) throw Error(`Unknown scope input ${channel}.`);
  if (ref !== null && !validRef(ref)) throw Error('A probe must name a module port or the stereo output bus.');
  const next = { ...project, _ui: { ...object(project._ui) } };
  const { mode, inputs } = scopeState(project);
  const patched = { ...inputs };
  if (ref === null) delete patched[channel];
  else patched[channel] = Object.hasOwn(ref, 'bus') ? { bus: ref.bus } : { node: ref.node, port: ref.port, direction: ref.direction };
  next._ui.scope = { mode, inputs: patched };
  return next;
}

export function setScopeMode(project, mode) {
  if (mode !== 'yt' && mode !== 'xy') throw Error('Scope mode must be yt or xy.');
  const next = { ...project, _ui: { ...object(project._ui) } };
  next._ui.scope = { ...scopeState(project), mode };
  return next;
}
