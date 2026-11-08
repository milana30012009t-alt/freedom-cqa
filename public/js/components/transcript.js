// Transcript view: role styles, timestamps, encoding/ASR flags, original-vs-normalised toggle,
// evidence highlighting, checked-range bracket, search and active-fragment highlight for audio.
import { h, clear, highlightText } from '../core/dom.js';
import { SPEAKER_LABELS } from '../core/format.js';

const FLAG_VIEW = {
  encoding_repaired: { label: 'кодировка', cls: 'repaired', title: 'Текст восстановлен из повреждённой кодировки (UTF-8, прочитанный как Windows-1251). Нажмите, чтобы увидеть оригинал.' },
  encoding_unrepaired: { label: 'кодировка?', cls: 'asr', title: 'Признаки повреждённой кодировки — безопасно восстановить не удалось, показан оригинал' },
  asr_fragment: { label: 'обрывок ASR', cls: 'asr', title: 'Короткий фрагмент автоматического распознавания речи — смысл может быть искажён' },
  asr_suspicious_token: { label: 'ASR?', cls: 'asr', title: 'Сомнительное распознавание (латиница внутри русской речи)' },
  mixed_script: { label: 'смешение алфавитов', cls: 'asr', title: 'Слово содержит и латиницу, и кириллицу' },
  masked_pii: { label: 'данные скрыты', cls: 'masked', title: 'Персональные данные скрыты в исходном наборе' },
  dtmf: { label: 'тон. набор', cls: '', title: 'Нажатие клавиши в голосовом меню' },
  duplicate: { label: 'дубль', cls: '', title: 'Повтор предыдущего фрагмента с той же меткой времени' },
  after_end: { label: 'после завершения', cls: '', title: 'Записано после завершения разговора/чата' },
  internal: { label: 'клиент на удержании', cls: '', title: 'Реплика произнесена, пока клиент был на удержании (консультация с коллегой) — не обращение к клиенту' },
  replacement_char: { label: 'нечитаемо', cls: 'asr', title: 'В тексте есть нечитаемые символы' },
};

export function createTranscript(conv, { onTimeClick, playable = false } = {}) {
  const state = { mode: 'normalized', query: '', hidden: new Set(), evidence: new Set(), range: null, playing: null };
  const root = h('div', { class: 'transcript', role: 'log', 'aria-label': 'Транскрипт диалога' });
  const nodes = new Map();

  function bubbleContent(m) {
    const text = state.mode === 'original' ? m.original : m.text;
    return highlightText(text || '—', state.query);
  }

  function buildMessage(m) {
    const classes = ['msg', m.speaker];
    if (m.flags.includes('internal')) classes.push('internal');
    if (m.segment === 'after_end') classes.push('after-end');
    const bubble = h('div', { class: 'bubble' }, bubbleContent(m));
    const original = h('div', { class: 'original-text hidden' }, `Оригинал: ${m.original}`);
    const flags = m.flags.map((f) => {
      const v = FLAG_VIEW[f];
      if (!v) return null;
      const el = h('span', { class: `flag ${v.cls}`, title: v.title }, v.label);
      if (f === 'encoding_repaired') el.addEventListener('click', () => original.classList.toggle('hidden'));
      return el;
    });
    const time = h('span', {
      class: `t${playable ? ' playable' : ''}`,
      title: `Исходная метка: ${m.ts ?? '—'}${playable ? ' · нажмите, чтобы прослушать' : ''}`,
      tabindex: playable ? 0 : -1,
      onclick: () => onTimeClick?.(m),
    }, m.t_label);
    const el = h('div', { class: classes.join(' '), id: `msg-${m.id}`, 'data-id': m.id },
      h('div', { class: 'meta' }, h('span', { class: 'who-dot' }), h('span', { class: 'who' }, SPEAKER_LABELS[m.speaker] || m.speaker_raw || '—'), time,
        h('span', { class: 'mid', title: 'ID реплики (используется в доказательствах)' }, m.id), flags),
      bubble, original);
    nodes.set(m.id, { el, bubble, m });
    return el;
  }

  function render() {
    clear(root);
    nodes.clear();
    for (const m of conv.messages) {
      const el = buildMessage(m);
      if (state.hidden.has(m.speaker)) el.classList.add('hidden');
      root.appendChild(el);
    }
    applyMarks();
  }

  function applyMarks() {
    for (const [id, n] of nodes) {
      n.el.classList.toggle('evidence', state.evidence.has(id));
      n.el.classList.toggle('playing', state.playing === id);
      const idx = n.m.index;
      n.el.classList.toggle('in-range', Boolean(state.range && idx >= state.range[0] && idx <= state.range[1]));
    }
  }

  function scrollTo(id, flash = true) {
    const n = nodes.get(id);
    if (!n) return;
    n.el.classList.remove('hidden');
    n.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (flash) {
      n.el.classList.remove('flash');
      void n.el.offsetWidth;
      n.el.classList.add('flash');
    }
  }

  render();
  return {
    el: root,
    highlight(ids, { scroll = true } = {}) {
      state.evidence = new Set(ids);
      state.range = null;
      applyMarks();
      if (scroll && ids.length) scrollTo(ids[0]);
    },
    highlightRange(range, extraIds = []) {
      if (!range) return;
      const a = Number(String(range.from).slice(1));
      const b = Number(String(range.to).slice(1));
      state.range = [Math.min(a, b), Math.max(a, b)];
      state.evidence = new Set(extraIds);
      applyMarks();
      scrollTo(`m${state.range[0]}`);
    },
    clear() {
      state.evidence = new Set();
      state.range = null;
      applyMarks();
    },
    setPlaying(id, { follow = false } = {}) {
      if (state.playing === id) return;
      state.playing = id;
      applyMarks();
      if (follow && id) nodes.get(id)?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    setMode(mode) {
      state.mode = mode;
      for (const n of nodes.values()) n.bubble.replaceChildren(...bubbleContent(n.m));
    },
    setQuery(q) {
      state.query = q.trim();
      let hits = 0;
      for (const n of nodes.values()) {
        n.bubble.replaceChildren(...bubbleContent(n.m));
        const hit = state.query && (state.mode === 'original' ? n.m.original : n.m.text).toLowerCase().includes(state.query.toLowerCase());
        n.el.classList.toggle('search-hit', Boolean(hit));
        if (hit) hits += 1;
      }
      const first = [...nodes.values()].find((n) => n.el.classList.contains('search-hit'));
      if (first) first.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return hits;
    },
    toggleSpeaker(speaker, visible) {
      if (visible) state.hidden.delete(speaker);
      else state.hidden.add(speaker);
      for (const n of nodes.values()) if (n.m.speaker === speaker) n.el.classList.toggle('hidden', !visible);
    },
    scrollTo,
  };
}
