// Audio player for calls. The recording is streamed through the server proxy (signed links
// never reach the browser). Transcript timestamps (ISO) are mapped to audio time from the
// recording start, optionally excluding "recording paused" intervals, plus a manual calibration.
import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { transcriptToAudioTime, audioToTranscriptTime, formatClock } from '../../shared/time.js';

const PREROLL = 1.5;

export function createAudioPlayer(conv, { markers = [], onActiveMessage } = {}) {
  const prefKey = `sync:${conv.uid}`;
  const pref = store.pref(prefKey, { pauseAware: conv.audio_sync?.pause_aware_default ?? true, calibration: 0 });
  const sync = { anchor: conv.audio_sync?.anchor || 0, pauses: conv.audio_sync?.pauses || [], pauseAware: pref.pauseAware, calibration: pref.calibration };
  const audio = new Audio();
  audio.preload = 'none';
  let loaded = false;
  let follow = true;

  const playBtn = h('button', { class: 'play', 'aria-label': 'Воспроизвести' }, icon('play'));
  const time = h('span', { class: 'time' }, '00:00 / —');
  const rail = h('div', { class: 'rail' });
  const fill = h('div', { class: 'fill' });
  const knob = h('div', { class: 'knob' });
  const marksLayer = h('div');
  const track = h('div', { class: 'track', role: 'slider', 'aria-label': 'Позиция записи', tabindex: 0 }, rail, fill, marksLayer, knob);
  const status = h('div', { class: 'err hidden' });
  const speed = h('select', { class: 'select sm', 'aria-label': 'Скорость' },
    ['1', '1.25', '1.5', '2'].map((v) => h('option', { value: v }, `${v}×`)));
  speed.addEventListener('change', () => { audio.playbackRate = Number(speed.value); });
  const followBox = h('label', { class: 'check xs' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { follow = e.target.checked; } }), 'следовать за записью');
  const pauseBox = h('label', { class: 'check xs', title: 'Исключать из шкалы интервалы «Запись приостановлена → возобновлена»' },
    h('input', { type: 'checkbox', checked: sync.pauseAware, onchange: (e) => { sync.pauseAware = e.target.checked; savePref(); drawMarkers(); } }), 'учитывать паузы записи');
  const calib = h('input', { class: 'input', type: 'number', step: '0.5', value: String(sync.calibration), title: 'Сдвиг, с (если речь звучит раньше/позже метки)' });
  calib.addEventListener('change', () => { sync.calibration = Number(calib.value) || 0; savePref(); drawMarkers(); });

  function savePref() {
    store.setPref(prefKey, { pauseAware: sync.pauseAware, calibration: sync.calibration });
  }

  const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Math.max(1, transcriptToAudioTime(conv.duration_sec || 1, sync)));

  function drawMarkers() {
    const d = duration();
    mount(marksLayer, markers.map((mk) => {
      const at = transcriptToAudioTime(mk.t, sync);
      const el = h('div', { class: `mark ${mk.kind === 'critical' ? 'critical' : ''}`, title: mk.label });
      el.style.left = `${Math.min(100, (at / d) * 100)}%`;
      el.addEventListener('click', (e) => { e.stopPropagation(); seekTranscript(mk.t); });
      return el;
    }));
  }

  function setStatus(text, isError = true) {
    status.textContent = text || '';
    status.classList.toggle('hidden', !text);
    status.style.color = isError ? '' : 'var(--text-3)';
  }

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    setStatus('Загрузка записи через защищённый прокси…', false);
    audio.src = api.url(`/api/audio/${api.enc(conv.uid)}`);
    audio.load();
  }

  async function explainError() {
    try {
      const st = await api.get(`/api/audio/${api.enc(conv.uid)}/status`);
      setStatus(`Запись недоступна: ${st.last_error?.message || 'источник не ответил'}. Транскрипт и оценка доступны без записи.`);
    } catch {
      setStatus('Запись недоступна. Транскрипт и оценка доступны без записи.');
    }
    playBtn.disabled = false;
    mount(playBtn, icon('play'));
    loaded = false;
  }

  audio.addEventListener('loadedmetadata', () => { setStatus(''); drawMarkers(); });
  audio.addEventListener('canplay', () => setStatus(''));
  audio.addEventListener('error', explainError);
  audio.addEventListener('play', () => mount(playBtn, icon('pause')));
  audio.addEventListener('pause', () => mount(playBtn, icon('play')));
  audio.addEventListener('timeupdate', () => {
    const d = duration();
    const p = Math.min(1, audio.currentTime / d);
    fill.style.width = `${p * 100}%`;
    knob.style.left = `${p * 100}%`;
    time.textContent = `${formatClock(audio.currentTime)} / ${Number.isFinite(audio.duration) ? formatClock(audio.duration) : '—'}`;
    const tt = audioToTranscriptTime(audio.currentTime, sync);
    let active = null;
    for (const m of conv.messages) {
      if (!Number.isFinite(m.t) || m.speaker === 'system') continue;
      if (m.t <= tt + 0.2) active = m;
      else break;
    }
    onActiveMessage?.(active ? active.id : null, follow && !audio.paused);
  });

  playBtn.addEventListener('click', async () => {
    await ensureLoaded();
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  track.addEventListener('click', async (e) => {
    await ensureLoaded();
    const r = track.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const go = () => { audio.currentTime = p * duration(); };
    if (Number.isFinite(audio.duration)) go();
    else audio.addEventListener('loadedmetadata', go, { once: true });
  });
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') audio.currentTime = Math.min(duration(), audio.currentTime + 5);
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  });

  async function seekTranscript(t) {
    await ensureLoaded();
    const target = Math.max(0, transcriptToAudioTime(t, sync) - PREROLL);
    const go = () => {
      audio.currentTime = target;
      audio.play().catch(() => {});
    };
    if (audio.readyState >= 1) go();
    else audio.addEventListener('loadedmetadata', go, { once: true });
  }

  drawMarkers();
  const el = h('div', { class: 'player' },
    h('div', { class: 'player-row' },
      h('button', { class: 'btn ghost sm icon-only', title: '−10 с', onclick: () => { audio.currentTime = Math.max(0, audio.currentTime - 10); } }, icon('rewind')),
      playBtn,
      h('button', { class: 'btn ghost sm icon-only', title: '+10 с', onclick: () => { audio.currentTime = Math.min(duration(), audio.currentTime + 10); } }, icon('forward')),
      track, time, speed),
    status,
    h('div', { class: 'sync' }, icon('wave'), 'Синхронизация с транскриптом:', pauseBox,
      h('label', { class: 'calib' }, h('span', {}, 'сдвиг, с'), calib), followBox,
      h('span', { class: 'muted' }, 'Отметки на шкале — доказательства и сигналы риска')));

  return {
    el,
    seekTranscript,
    destroy() {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    },
  };
}
