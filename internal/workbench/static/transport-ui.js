import { createLiveTransport } from './live-client.js';
import { soundSignature } from './project-state.js';

const clamp = (n, max) => Math.max(0, Math.min(max, Number.isFinite(n) ? n : 0));
const clock = seconds => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;

// Stable element references survive adoption into a detached monitor window.
export function createTransportUI(root, { audio, wave, onTime, onError, onStateChange, canPlay, renderedMatches }) {
  const find = name => root.querySelector(`#transport-${name}`);
  const play = find('play'), stop = find('stop'), mode = find('mode'), seekbar = find('seek');
  const position = find('position'), message = find('state'), audition = find('audition');
  const loop = find('loop'), loopStart = find('loop-start'), loopEnd = find('loop-end');
  const liveAvailable = window.isSecureContext && typeof AudioWorkletNode !== 'undefined';
  if (!liveAvailable) {
    mode.querySelector('[value=live]').disabled = true; mode.value = 'rendered';
    message.textContent = 'Live synth needs HTTPS or localhost. Rendered WAV playback is available.';
  }
  let project, signature, duration = 0, time = 0, live, generation = 0, frame, frameHost;
  let scrubState = null, grainTimer, restoring = false, destroyed = false;
  const removers = [];
  const listen = (target, event, fn) => { target.addEventListener(event, fn); removers.push(() => target.removeEventListener(event, fn)); };
  const isLive = () => mode.value === 'live';
  const playing = () => isLive() ? !!live?.state.playing : !audio.paused;
  const report = error => { if (!destroyed) onError(error?.message || String(error)); };
  const run = promise => Promise.resolve(promise).catch(report);
  const playRendered = () => audio.play().catch(error => { if (error.name !== 'AbortError') throw error; });
  function releaseScrub() {
    const previous = scrubState;
    previous?.cleanup?.(); scrubState = null;
    return previous;
  }
  function preferences() {
    if (!restoring) onStateChange({ mode: mode.value, audition: audition.checked, loop: loop.checked, start: Number(loopStart.value), end: Number(loopEnd.value) });
  }
  function showTime(seconds) {
    time = clamp(seconds, duration);
    if (!scrubState) seekbar.value = String(time);
    position.value = `${clock(time)} / ${clock(duration)}`;
    seekbar.setAttribute('aria-valuetext', `${clock(time)} of ${clock(duration)}`);
    if (isLive() || renderedMatches()) onTime(time);
  }
  function showState() {
    play.textContent = playing() ? 'Pause' : 'Play';
    play.setAttribute('aria-label', `${playing() ? 'Pause' : 'Play'} ${isLive() ? 'live synth' : 'rendered WAV'}`);
    if (isLive()) {
      const state = live?.state;
      message.textContent = state?.buffering ? 'Preparing audio…' : state?.playing ? 'Live · controls update as you play' : 'Live synth · ready';
      if (state?.underruns) message.textContent += ` · ${state.underruns} buffer underrun${state.underruns === 1 ? '' : 's'}`;
    } else if (liveAvailable) message.textContent = renderedMatches() ? 'Rendered WAV · snapshot of the last render' : 'Render this project to play its WAV';
  }
  function newLive() {
    const current = ++generation;
    return createLiveTransport({
      onState: () => { if (current === generation && isLive() && !destroyed) showState(); },
      onTime: seconds => { if (current === generation && isLive() && !scrubState && !destroyed) showTime(seconds); },
      onError: error => { if (current === generation) report(error); },
    });
  }
  function region() {
    const scale = 60 / (Number(project?.bpm) || 120);
    return { enabled: loop.checked, start: Number(loopStart.value) * scale, end: Number(loopEnd.value) * scale };
  }
  function applyLoop() {
    const range = region();
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || range.end > duration + .001) {
      if (range.enabled) { loop.checked = false; report('Loop end must follow its start and fit inside the project.'); }
    }
    live?.setLoop(loop.checked ? range : { enabled: false, start: 0, end: Math.max(.01, duration) }); preferences();
  }
  function cancelFrame() { if (frame) frameHost?.cancelAnimationFrame(frame); frame = null; }
  function updateRendered() {
    if (destroyed || isLive()) return;
    if (!scrubState) {
      const range = region();
      if (!audio.paused && range.enabled && audio.currentTime >= range.end) audio.currentTime = range.start;
      showTime(audio.currentTime);
    }
    showState();
  }
  function animateRendered() {
    updateRendered();
    if (!audio.paused && !isLive() && !destroyed) {
      frameHost = root.ownerDocument.defaultView; frame = frameHost.requestAnimationFrame(animateRendered);
    }
  }
  function pause() {
    clearTimeout(grainTimer); live?.pause(); audio.pause(); cancelFrame(); showState();
  }
  async function seek(seconds, finishingGesture = false) {
    if (!project || (!finishingGesture && !canPlay())) return;
    const target = clamp(seconds, duration);
    if (isLive()) {
      showTime(target); await live.seek(target);
    } else if (renderedMatches() && Number.isFinite(audio.duration)) {
      audio.currentTime = clamp(target, audio.duration); showTime(audio.currentTime);
    } else onError('Render this project to seek its audio.');
  }
  async function togglePlay() {
    if (scrubState) { releaseScrub(); pause(); }
    if (playing()) { pause(); return; }
    if (!project || !canPlay()) return;
    if (isLive()) { audio.pause(); await live.play(time >= duration ? 0 : time); }
    else if (renderedMatches() && Number.isFinite(audio.duration)) { if (audio.ended) audio.currentTime = 0; await playRendered(); }
    else onError('Render this project to play its audio.');
    showState();
  }
  function scrub(seconds, { phase }) {
    if (!project || (!['end', 'cancel'].includes(phase) && !canPlay())) return;
    const target = clamp(seconds, duration);
    if (phase === 'start') {
      releaseScrub();
      scrubState = { playing: playing(), start: time };
      const host = root.ownerDocument.defaultView;
      const cancel = event => {
        if (event.type === 'blur' || event.key === 'Escape') {
          if (event.key === 'Escape') event.preventDefault();
          scrub(time, { phase: 'cancel' });
        }
      };
      host.addEventListener('keydown', cancel); host.addEventListener('blur', cancel);
      scrubState.cleanup = () => { host.removeEventListener('keydown', cancel); host.removeEventListener('blur', cancel); };
      pause();
    }
    if (!scrubState) { if (phase === 'end') run(seek(target)); return; }
    if (phase === 'cancel' || phase === 'end') {
      const previous = releaseScrub();
      clearTimeout(grainTimer);
      const end = phase === 'cancel' ? previous.start : target;
      showTime(end);
      if (isLive()) run(live.endScrub(end, previous.playing));
      else {
        audio.pause();
        run(seek(end, true).then(() => { if (previous.playing && renderedMatches()) return playRendered(); }));
      }
      return;
    }
    showTime(target); seekbar.value = String(target);
    if (!audition.checked) return;
    if (isLive()) run(live.scrub(target));
    else if (renderedMatches() && Number.isFinite(audio.duration)) {
      clearTimeout(grainTimer); audio.currentTime = clamp(target, audio.duration);
      run(playRendered()); grainTimer = setTimeout(() => audio.pause(), 90);
    }
  }
  listen(play, 'click', () => run(togglePlay()));
  listen(stop, 'click', () => { releaseScrub(); pause(); live?.stop(); if (audio.src) audio.currentTime = 0; showTime(0); });
  listen(mode, 'change', () => {
    const target = time;
    releaseScrub(); pause();
    if (isLive() || (renderedMatches() && Number.isFinite(audio.duration))) run(seek(target, true));
    else showTime(audio.currentTime || 0);
    showState(); preferences();
  });
  listen(audition, 'change', preferences);
  for (const input of [loop, loopStart, loopEnd]) listen(input, 'change', applyLoop);
  listen(seekbar, 'pointerdown', event => {
    if (event.button !== 0) return;
    seekbar.setPointerCapture(event.pointerId);
    scrub(Number(seekbar.value), { phase: 'start' });
  });
  listen(seekbar, 'input', () => scrubState ? scrub(Number(seekbar.value), { phase: 'move' }) : run(seek(Number(seekbar.value))));
  listen(seekbar, 'pointerup', () => { if (scrubState) scrub(Number(seekbar.value), { phase: 'end' }); });
  listen(seekbar, 'pointercancel', () => scrub(time, { phase: 'cancel' }));
  listen(seekbar, 'lostpointercapture', () => { if (scrubState) scrub(time, { phase: 'cancel' }); });
  listen(seekbar, 'keydown', event => { if (event.key === 'Escape' && scrubState) { event.preventDefault(); scrub(time, { phase: 'cancel' }); } });
  const waveTime = event => {
    const rect = wave.getBoundingClientRect(); return clamp((event.clientX - rect.left) / Math.max(1, rect.width) * duration, duration);
  };
  listen(wave, 'pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); wave.setPointerCapture(event.pointerId); scrub(waveTime(event), { phase: 'start' });
  });
  listen(wave, 'pointermove', event => { if (wave.hasPointerCapture(event.pointerId) && scrubState) scrub(waveTime(event), { phase: 'move' }); });
  listen(wave, 'pointerup', event => { if (scrubState && wave.hasPointerCapture(event.pointerId)) scrub(waveTime(event), { phase: 'end' }); });
  listen(wave, 'pointercancel', () => scrub(time, { phase: 'cancel' }));
  listen(wave, 'lostpointercapture', () => { if (scrubState) scrub(time, { phase: 'cancel' }); });
  listen(audio, 'play', () => {
    if (scrubState || audio.paused || destroyed) return;
    live?.pause(); mode.value = 'rendered'; preferences(); cancelFrame(); animateRendered();
  });
  for (const event of ['pause', 'seeked', 'timeupdate']) listen(audio, event, updateRendered);
  listen(audio, 'ended', () => {
    if (audio.ended && !isLive() && !scrubState && loop.checked && renderedMatches()) {
      audio.currentTime = region().start; run(playRendered());
    }
    updateRendered();
  });
  return {
    setProject(next, saved = {}) {
      const changed = project?.id !== next.id;
      if (changed) {
        pause(); ++generation; live?.destroy(); live = liveAvailable ? newLive() : null;
        time = 0; releaseScrub();
        restoring = true;
        mode.value = liveAvailable && saved.mode !== 'rendered' ? 'live' : 'rendered';
        audition.checked = saved.audition !== false; loop.checked = !!saved.loop;
        loopStart.value = String(saved.start ?? 0); loopEnd.value = String(saved.end ?? Math.min(4, Number(next.beats) || 4));
      }
      project = next;
      const seconds = Number(next.beats) * 60 / Number(next.bpm) + Number(next.tail_seconds || 0);
      duration = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
      seekbar.max = String(duration); loopStart.max = loopEnd.max = String(duration * (Number(next.bpm) || 120) / 60);
      const nextSignature = soundSignature(next);
      if (changed || nextSignature !== signature) live?.setProject(next);
      signature = nextSignature;
      applyLoop(); restoring = false; showTime(time); showState();
    },
    previewProject(next) { if (live?.state.ready) live.setProject(next); },
    restorePreview() { if (live?.state.ready && project) live.setProject(project); },
    seek: seconds => run(seek(seconds)), scrub,
    refresh() {
      if (scrubState) scrub(time, { phase: 'cancel' });
      cancelFrame(); if (!audio.paused && !isLive()) animateRendered();
    },
    pause() { releaseScrub(); pause(); }, renderedReady: showState,
    destroy() { destroyed = true; ++generation; releaseScrub(); pause(); live?.destroy(); removers.splice(0).forEach(remove => remove()); },
  };
}
