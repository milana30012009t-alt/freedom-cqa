// Conversations list: search, filters (language, channel, status, score, gross errors, appeals,
// failed criterion), sorting, selection and batch evaluation.
import { h, mount, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { setCrumbs } from '../core/crumbs.js';
import { loading, emptyState, toast, errorToast } from '../core/ui.js';
import { navigate, setQuery } from '../core/router.js';
import { scorePill, statusChip, langChip, channelChip, appealChip, priorityChip, formatDuration, formatDateTime, STATUS_META } from '../core/format.js';

const COLS = [
  ['sel', ''], ['id', 'ID диалога'], ['language', 'Язык'], ['channel', 'Канал'], ['status', 'Статус проверки'], ['score', 'Итог'],
  ['gross', 'Грубые ошибки / риски'], ['appeal', 'Апелляция'], ['date', 'Дата / длительность'], ['priority', 'Приоритет'],
];
const SORTABLE = new Set(['id', 'language', 'channel', 'status', 'score', 'date', 'priority']);

export async function render(root, { query, isCurrent }) {
  setCrumbs('Диалоги');
  const f = {
    q: query.get('q') || '', language: query.get('language') || '', channel: query.get('channel') || '', status: query.get('status') || '',
    critical: query.get('critical') || '', appeal: query.get('appeal') || '', min: query.get('min') || '', max: query.get('max') || '',
    fail: query.get('fail') || '', sort: query.get('sort') || 'id', dir: query.get('dir') || 'asc',
  };
  const selected = new Set();
  let data = null;
  let checklist = null;

  const tableBox = h('div', { class: 'table-wrap' }, loading());
  const counter = h('span', { class: 'small muted' });
  const batchBtn = h('button', { class: 'btn sm', disabled: true }, icon('sparkle'), 'Оценить выбранные');

  async function load() {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
    setQuery(Object.fromEntries(params));
    try {
      data = await api.get(`/api/conversations?${params}`);
    } catch (e) {
      mount(tableBox, emptyState('alert', 'Ошибка загрузки', e.message));
      return;
    }
    if (!isCurrent()) return;
    renderTable();
  }

  function renderTable() {
    counter.textContent = `Показано: ${data.items.length}`;
    if (!data.items.length) {
      mount(tableBox, emptyState('search', 'Ничего не найдено', 'Измените фильтры или загрузите данные.', h('button', { class: 'btn', onclick: reset }, 'Сбросить фильтры')));
      return;
    }
    const allSel = data.items.every((r) => selected.has(r.uid));
    const head = h('tr', {}, COLS.map(([k, label]) => {
      if (k === 'sel') {
        return h('th', {}, h('input', { type: 'checkbox', checked: allSel, 'aria-label': 'Выбрать все', onchange: (e) => { for (const r of data.items) { if (e.target.checked) selected.add(r.uid); else selected.delete(r.uid); } renderTable(); updateBatch(); } }));
      }
      const sortable = SORTABLE.has(k);
      const arrow = f.sort === k ? h('span', { class: 'sort' }, f.dir === 'asc' ? '↑' : '↓') : null;
      return h('th', { class: `${sortable ? 'sortable' : ''} ${k === 'score' ? 'num' : ''}`, onclick: sortable ? () => { f.dir = f.sort === k && f.dir === 'asc' ? 'desc' : 'asc'; f.sort = k; load(); } : null }, label, arrow);
    }));
    const rows = data.items.map((r) => {
      const e = r.evaluation;
      const tr = h('tr', { class: `clickable ${selected.has(r.uid) ? 'selected' : ''}`, onclick: (ev) => { if (ev.target.closest('input')) return; navigate(`/c/${encodeURIComponent(r.uid)}`); } },
        h('td', {}, h('input', { type: 'checkbox', checked: selected.has(r.uid), 'aria-label': `Выбрать ${r.conversation_id}`, onchange: (ev) => { if (ev.target.checked) selected.add(r.uid); else selected.delete(r.uid); tr.classList.toggle('selected', ev.target.checked); updateBatch(); } })),
        h('td', {}, h('div', { class: 'id' }, r.conversation_id), h('span', { class: 'preview', title: r.preview }, r.preview)),
        h('td', {}, langChip(r.language)),
        h('td', {}, channelChip(r.channel_type)),
        h('td', {}, statusChip(r.status)),
        h('td', { class: 'num' }, e ? scorePill(e.total, { complete: e.complete }) : h('span', { class: 'muted' }, '—')),
        h('td', {}, e ? h('div', { class: 'row wrap gap-4' },
          e.critical_count ? h('span', { class: 'chip critical' }, icon('alert'), `${e.critical_count} груб.`) : null,
          e.risk_count ? h('span', { class: 'chip warning' }, icon('shield'), `${e.risk_count} риск`) : null,
          !e.critical_count && !e.risk_count ? h('span', { class: 'muted small' }, 'нет') : null) : h('span', { class: 'muted' }, '—')),
        h('td', {}, appealChip(r.appeal_status)),
        h('td', { class: 'small nowrap' }, r.started_at ? formatDateTime(r.started_at) : h('span', { class: 'muted' }, 'чат'), h('div', { class: 'xs muted' }, formatDuration(r.duration_sec))),
        h('td', {}, e ? priorityChip(e.priority) : h('span', { class: 'muted' }, '—')));
      return tr;
    });
    mount(tableBox, h('table', { class: 'table' }, h('thead', {}, head), h('tbody', {}, rows)));
  }

  function updateBatch() {
    batchBtn.disabled = selected.size === 0;
    batchBtn.lastChild.textContent = selected.size ? `Оценить выбранные (${selected.size})` : 'Оценить выбранные';
  }

  async function runBatch(scope, uids) {
    try {
      const engine = store.state.system?.engine.ai_available ? 'ai' : 'rules';
      const job = await api.post('/api/evaluations/batch', { scope, uids, engine });
      if (!job.total) { toast('Нет диалогов для оценки', 'info'); return; }
      toast(`Запущена оценка: ${job.total} диалогов`, 'info');
      const poll = async () => {
        const j = await api.get(`/api/jobs/${job.id}`);
        counter.textContent = `Оценка: ${j.done}/${j.total}…`;
        if (j.status === 'running') { setTimeout(poll, 600); return; }
        toast(`Оценено ${j.done - j.failed} из ${j.total}${j.failed ? `, ошибок: ${j.failed}` : ''}`, j.failed ? 'error' : 'good');
        selected.clear();
        updateBatch();
        window.dispatchEvent(new CustomEvent('cqa:refresh-system'));
        if (isCurrent()) load();
      };
      poll();
    } catch (e) { errorToast(e); }
  }
  batchBtn.addEventListener('click', () => runBatch('selected', [...selected]));

  function reset() {
    Object.assign(f, { q: '', language: '', channel: '', status: '', critical: '', appeal: '', min: '', max: '', fail: '' });
    navigate('/conversations');
  }

  // ---- filter controls ----
  const search = h('input', { class: 'input search', placeholder: 'Поиск: ID или текст обращения', value: f.q, 'aria-label': 'Поиск' });
  search.style.width = '260px';
  search.addEventListener('input', debounce(() => { f.q = search.value.trim(); load(); }, 250));
  const langChips = ['RU', 'KZ', 'EN'].map((l) => {
    const on = f.language.split(',').includes(l);
    const c = h('button', { class: `chip toggle clickable lang ${on ? 'on' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false' }, l);
    c.addEventListener('click', () => {
      const set = new Set(f.language.split(',').filter(Boolean));
      if (set.has(l)) set.delete(l); else set.add(l);
      f.language = [...set].join(',');
      c.classList.toggle('on', set.has(l));
      load();
    });
    return c;
  });
  const sel = (key, options, label) => {
    const s = h('select', { class: 'select', 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
    s.addEventListener('change', () => { f[key] = s.value; load(); });
    return s;
  };
  const scoreSel = h('select', { class: 'select', 'aria-label': 'Итоговый балл' },
    [['', 'Любой балл'], ['85-100', '85–100'], ['70-84.99', '70–84'], ['50-69.99', '50–69'], ['0-49.99', 'ниже 50']]
      .map(([v, l]) => h('option', { value: v, selected: `${f.min}-${f.max}` === v }, l)));
  scoreSel.addEventListener('change', () => { const [mi = '', ma = ''] = scoreSel.value.split('-'); f.min = mi; f.max = ma; load(); });
  const critToggle = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.critical === '1', onchange: (e) => { f.critical = e.target.checked ? '1' : ''; load(); } }), 'Только с нарушениями/рисками');

  try {
    checklist = (await api.get('/api/checklists/active')).checklist;
  } catch { checklist = null; }
  const failSel = h('select', { class: 'select', 'aria-label': 'Невыполненный критерий' },
    h('option', { value: '' }, 'Любые критерии'),
    (checklist?.criteria || []).filter((c) => c.enabled).map((c) => h('option', { value: c.id, selected: f.fail === c.id }, `Не выполнен: ${c.code} ${c.name}`)));
  failSel.addEventListener('change', () => { f.fail = failSel.value; load(); });

  const filters = h('div', { class: 'filters' },
    h('span', { class: 'search-wrap' }, icon('search'), search), h('span', { class: 'sep' }), ...langChips, h('span', { class: 'sep' }),
    sel('channel', [['', 'Все каналы'], ['chat', 'Чаты'], ['call', 'Звонки']], 'Канал'),
    sel('status', [['', 'Любой статус'], ...Object.entries(STATUS_META).map(([k, v]) => [k, v.label])], 'Статус проверки'),
    scoreSel,
    sel('appeal', [['', 'Апелляции: все'], ['open', 'Есть открытая'], ['any', 'Есть любая']], 'Апелляции'),
    failSel, critToggle,
    h('div', { class: 'spacer' }), h('button', { class: 'btn ghost sm', onclick: reset }, 'Сбросить'));

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Диалоги'), h('div', { class: 'sub' }, 'Нажмите на строку, чтобы открыть карточку с транскриптом, оценкой и доказательствами. ', counter)),
      h('div', { class: 'spacer' }),
      h('div', { class: 'head-actions' }, batchBtn,
        h('button', { class: 'btn', onclick: () => runBatch('unevaluated') }, icon('sparkle'), 'Оценить неоценённые'),
        h('button', { class: 'btn', onclick: () => runBatch('outdated'), title: 'Оценки по старой версии чек-листа или устаревшему транскрипту' }, icon('refresh'), 'Переоценить устаревшие'))),
    h('div', { class: 'card' }, filters, tableBox));
  await load();
}
