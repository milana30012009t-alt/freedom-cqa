// Conversation card — the main screen: transcript (+ audio for calls), explainable evaluation,
// evidence navigation, gross errors / risk signals, appeals and history.
import { h, mount, clear, debounce, downloadJson } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { setCrumbs } from '../core/crumbs.js';
import { loading, emptyState, toast, errorToast, openModal } from '../core/ui.js';
import {
  fmtScore, fmtDate, fmtRelative, formatDuration, formatDateTime, statusChip, priorityChip, langChip, channelChip, scoreTone,
  appealChip, actorLabel, SEVERITY_LABELS, confidenceMeter,
} from '../core/format.js';
import { scoreRing } from '../components/charts.js';
import { createTranscript } from '../components/transcript.js';
import { createAudioPlayer } from '../components/audio-player.js';
import { criterionCard, openAppealModal, openOverrideModal, evidenceButton } from '../components/review.js';

const QUALITY = { good: ['good', 'Текст: хорошее качество'], medium: ['warning', 'Текст: среднее качество'], low: ['critical', 'Текст: низкое качество'] };
const ACTIONS = {
  evaluated: 'Оценка выполнена', override: 'Оценка изменена проверяющим', overrides_carried: 'Решения перенесены', overrides_not_carried: 'Решения не перенесены — нужна повторная проверка', verified: 'Проверка подтверждена',
  finding_confirmed: 'Нарушение подтверждено', finding_rejected: 'Сигнал отклонён как ложный', created: 'Апелляция подана', taken: 'Взята в работу',
  confirmed: 'Оценка подтверждена', changed: 'Оценка изменена', closed: 'Закрыта', withdrawn: 'Отозвана',
};

export async function render(root, { params, isCurrent }) {
  const uid = params.uid;
  setCrumbs(['Диалоги', '#/conversations'], uid.split(':').slice(1).join(':') || uid);
  mount(root, loading());
  const state = { data: null, tab: 'eval', open: new Set(), diff: null, busy: false };
  let transcript = null;
  let player = null;

  async function load() {
    state.data = await api.get(`/api/conversations/${api.enc(uid)}`);
  }

  try {
    await load();
  } catch (e) {
    mount(root, emptyState('alert', 'Диалог не найден', e.message, h('a', { class: 'btn', href: '#/conversations' }, 'К списку диалогов')));
    return undefined;
  }
  if (!isCurrent()) return undefined;
  const conv = state.data.conversation;
  const msgById = new Map(conv.messages.map((m) => [m.id, m]));
  const engineInfo = store.state.system?.engine;

  // ---------- Transcript pane ----------
  transcript = createTranscript(conv, {
    playable: conv.has_audio,
    onTimeClick: (m) => { if (player && Number.isFinite(m.t)) player.seekTranscript(m.t); },
  });

  function markers() {
    const e = state.data.evaluation;
    if (!e) return [];
    const out = [];
    for (const f of e.critical_findings) for (const ev of f.evidence) out.push({ t: ev.t, kind: 'critical', label: `${f.name} · ${ev.t_label}` });
    for (const r of e.results) {
      if (r.situation === 'met' || r.situation === 'na') continue;
      for (const ev of r.evidence.filter((x) => x.role !== 'context').slice(0, 2)) out.push({ t: ev.t, kind: 'warn', label: `${r.criterion_id} · ${ev.t_label}` });
    }
    return out.filter((m) => Number.isFinite(m.t));
  }

  function buildPlayer() {
    if (!conv.has_audio) return null;
    player?.destroy();
    player = createAudioPlayer(conv, {
      markers: markers(),
      onActiveMessage: (id, follow) => transcript.setPlaying(id, { follow }),
    });
    return player.el;
  }

  const search = h('input', { class: 'input sm search', placeholder: 'Поиск по диалогу', 'aria-label': 'Поиск по диалогу' });
  const hits = h('span', { class: 'xs muted' });
  search.addEventListener('input', debounce(() => {
    const n = transcript.setQuery(search.value);
    hits.textContent = search.value.trim() ? `${n} совп.` : '';
  }, 200));
  const modeSwitch = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Версия текста' },
    [['normalized', 'Нормализовано'], ['original', 'Оригинал']].map(([v, l], i) => {
      const b = h('button', { class: i === 0 ? 'active' : '', type: 'button', title: v === 'original' ? 'Текст ровно в том виде, в каком пришёл из источника' : 'Текст после безопасного восстановления кодировки' }, l);
      b.addEventListener('click', () => { transcript.setMode(v); for (const x of modeSwitch.children) x.classList.toggle('active', x === b); });
      return b;
    }));
  const toggles = ['bot', 'system'].map((sp) => h('label', { class: 'check xs' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => transcript.toggleSpeaker(sp, e.target.checked) }), sp === 'bot' ? 'бот' : 'система'));
  const leftPane = h('div', { class: 'card pane' },
    h('div', { class: 'pane-toolbar' }, h('span', { class: 'search-wrap' }, icon('search'), search), hits, h('div', { class: 'spacer' }), modeSwitch),
    h('div', { class: 'pane-toolbar' },
      h('span', { class: 'legend-inline' },
        ...[['client', 'Клиент', 'var(--spk-client)'], ['operator', 'Оператор', 'var(--spk-operator)'], ['bot', 'Бот', 'var(--spk-bot)'], ['system', 'Система', 'var(--spk-system)']]
          .map(([, l, c]) => { const i = h('i'); i.style.background = c; return h('span', {}, i, l); })),
      h('div', { class: 'spacer' }), h('span', { class: 'xs muted' }, 'Показывать:'), toggles),
    buildPlayer(),
    h('div', { class: 'pane-scroll' }, transcript.el));

  // ---------- Evaluation helpers ----------
  function showEvidence(ids) {
    transcript.highlight(ids);
    const m = msgById.get(ids[0]);
    if (player && m && Number.isFinite(m.t)) player.seekTranscript(m.t);
  }
  function showRange(range, ids) {
    transcript.highlightRange(range, ids);
  }

  async function reload({ keepDiff = false } = {}) {
    await load();
    if (!keepDiff) state.diff = null;
    renderHead();
    renderRight();
    if (conv.has_audio && player) {
      const host = leftPane.querySelector('.player');
      if (host) host.replaceWith(buildPlayer());
    }
  }

  async function runEvaluation(engine) {
    if (state.busy) return;
    state.busy = true;
    renderHead();
    try {
      const res = await api.post(`/api/conversations/${api.enc(uid)}/evaluate`, { engine });
      state.diff = res.diff;
      await load();
      toast(`Оценка готова: ${fmtScore(res.evaluation.score_final.total)} · ${res.evaluation.engine.label}${res.evaluation.engine.fallback ? ' (AI недоступен — офлайн-правила)' : ''}`, res.evaluation.engine.fallback ? 'info' : 'good');
      state.tab = 'eval';
      window.dispatchEvent(new CustomEvent('cqa:refresh-system'));
    } catch (e) {
      errorToast(e);
    } finally {
      state.busy = false;
      renderHead();
      renderRight();
      const host = leftPane.querySelector('.player');
      if (host) host.replaceWith(buildPlayer());
    }
  }

  // ---------- Header ----------
  const headCard = h('div', { class: 'card' });
  const bannerBox = h('div', { class: 'col mt-12' });

  function renderHead() {
    const { evaluation: e, row } = state.data;
    const total = e?.score_final.total;
    const orig = e?.score_original.total;
    const ai = engineInfo?.ai_available;
    const evalButtons = h('div', { class: 'row wrap' },
      ai ? h('button', { class: 'btn primary', disabled: state.busy, onclick: () => runEvaluation('ai') }, state.busy ? h('span', { class: 'spinner' }) : icon('sparkle'), e ? 'Переоценить (AI)' : 'Оценить (AI)') : null,
      h('button', { class: `btn ${ai ? '' : 'primary'}`, disabled: state.busy, onclick: () => runEvaluation('rules'), title: 'Детерминированные многоязычные правила — без LLM' },
        state.busy && !ai ? h('span', { class: 'spinner' }) : icon('cpu'), ai ? 'Офлайн-правила' : (e ? 'Переоценить (офлайн-правила)' : 'Оценить (офлайн-правила)')),
      e && store.state.role === 'reviewer' && !e.review.verified ? h('button', { class: 'btn', onclick: verify }, icon('check'), 'Подтвердить проверку') : null,
      e ? h('button', { class: 'btn ghost icon-only', title: 'Экспорт оценки (JSON)', onclick: () => downloadJson(`${conv.conversation_id}-${e.id}.json`, e) }, icon('download')) : null);

    mount(headCard, h('div', { class: 'conv-head' },
      h('div', {},
        h('div', { class: 'conv-title' },
          h('a', { class: 'btn ghost sm icon-only', href: '#/conversations', title: 'К списку' }, icon('back')),
          h('h1', {}, conv.conversation_id), langChip(conv.language), channelChip(conv.channel_type), statusChip(row.status),
          e ? priorityChip(e.review.priority) : null,
          e?.score_final.gross_error ? h('span', { class: 'chip critical' }, icon('alert'), 'Грубая ошибка') : null),
        h('div', { class: 'conv-meta' },
          h('span', {}, icon('chats'), `${conv.stats.message_count} реплик`),
          h('span', {}, icon('clock'), formatDuration(conv.duration_sec)),
          conv.started_at ? h('span', {}, icon('phone'), formatDateTime(conv.started_at)) : null,
          h('span', { class: `chip ${QUALITY[conv.quality.level][0]}` }, QUALITY[conv.quality.level][1]),
          conv.stats.first_response_sec !== null ? h('span', { title: 'Время от передачи оператору до его первой реплики' }, icon('flag'), `Первая реакция: ${Math.round(conv.stats.first_response_sec)} с`) : null,
          e ? h('span', {}, icon(e.engine.used === 'rules' ? 'cpu' : 'sparkle'), `${e.engine.label}${e.engine.model ? '' : ''}`) : null,
          e ? h('span', {}, icon('checklist'), `чек-лист v${e.checklist_version}${e.checklist_official ? ' (официальный)' : ''}`) : null,
          e ? h('span', { title: fmtDate(e.created_at) }, icon('refresh'), `оценено ${fmtRelative(e.created_at)}`) : null),
        h('div', { class: 'mt-12' }, evalButtons)),
      h('div', { class: 'score-block' },
        scoreRing(total, { tone: e ? scoreTone(total) : 'none', sub: e?.score_final.complete === false ? 'предварит.' : 'из 100' }),
        h('div', { class: 'score-side' },
          e ? h('div', {}, e.engine.used === 'rules' ? 'Предварительная автоматическая оценка' : 'AI-оценка (предварительная до проверки)') : h('div', {}, 'Ещё не оценён'),
          e && e.engine.used === 'rules' ? h('div', { class: 'muted xs' }, 'офлайн-правила, без AI') : null,
          e && Number.isFinite(orig) && orig !== total ? h('div', { class: 'was' }, `Исходная автоматическая оценка: ${fmtScore(orig)}`) : null,
          e ? h('div', { class: 'muted' }, `Применимо: ${e.score_final.coverage.criteria_evaluated} из ${e.score_final.coverage.criteria_total} критериев`) : null,
          e && e.score_final.gross_error === true ? h('div', { class: 'chip critical' }, icon('alert'), 'Грубые ошибки: Да') : e && e.score_final.gross_error === false ? h('div', { class: 'chip good' }, icon('check'), 'Грубые ошибки: Нет') : null))));

    // Banners
    clear(bannerBox);
    if (!e) return;
    const active = e.critical_findings.filter((f) => e.critical_reviews?.[f.id]?.decision !== 'false_positive');
    const crit = active.filter((f) => f.severity === 'critical');
    const risk = active.filter((f) => f.severity !== 'critical');
    if (crit.length) {
      bannerBox.appendChild(h('div', { class: 'banner critical' }, icon('alert'), h('div', { class: 'b-body' },
        h('div', {}, h('b', {}, `Грубые нарушения: ${crit.length}. `), 'Приоритетная ручная проверка. Итог не обнулён (правило чек-листа: грубые ошибки отмечаются отдельно).'),
        h('div', { class: 'row wrap' }, crit.map((f) => h('button', { class: 'chip critical clickable', onclick: () => { state.tab = 'findings'; renderRight(); showEvidence(f.evidence.map((x) => x.message_id)); } }, icon('alert'), f.name, f.evidence[0] ? ` · ${f.evidence[0].t_label}` : ''))))));
    }
    if (risk.length) {
      bannerBox.appendChild(h('div', { class: 'banner warning' }, icon('shield'), h('div', { class: 'b-body' },
        h('div', {}, h('b', {}, `Сигналы риска: ${risk.length}. `), 'Не входят в чек-лист и не меняют балл — требуют решения проверяющего.'),
        h('div', { class: 'row wrap' }, risk.map((f) => h('button', { class: 'chip warning clickable', onclick: () => { state.tab = 'findings'; renderRight(); showEvidence(f.evidence.map((x) => x.message_id)); } }, icon('shield'), f.name, f.possible_legitimate_context ? ' · возможно, штатная процедура' : ''))))));
    }
    const active2 = store.state.system?.checklist?.version;
    if (active2 && e.checklist_version !== active2) {
      bannerBox.appendChild(h('div', { class: 'banner info' }, icon('checklist'), h('div', { class: 'b-body' },
        h('div', {}, `Оценка выполнена по чек-листу v${e.checklist_version}, активна v${active2}. Результат зафиксирован со снимком старой версии.`),
        h('div', {}, h('button', { class: 'btn sm primary', onclick: () => runEvaluation(engineInfo?.ai_available ? 'ai' : 'rules') }, icon('refresh'), `Переоценить по v${active2}`)))));
    }
    if (state.data.row.evaluation?.stale) bannerBox.appendChild(h('div', { class: 'banner warning' }, icon('alert'), h('div', {}, 'Транскрипт изменился после оценки (набор данных обновлён) — переоцените диалог.')));
    if (e.engine.fallback) bannerBox.appendChild(h('div', { class: 'banner warning' }, icon('cpu'), h('div', {}, `AI-модель была недоступна (${e.engine.fallback.reason}) — использованы офлайн-правила.`)));
    if (!e.score_final.complete) bannerBox.appendChild(h('div', { class: 'banner info' }, icon('info'), h('div', {}, `Предварительный итог: ${e.score_final.coverage.criteria_total - e.score_final.coverage.criteria_evaluated} критери(й/ев) не оценено автоматически (неразборчивый фрагмент звонка или критерий, для которого нет офлайн-правила, а AI не подключён). Итог посчитан только по оценённым критериям; решение за проверяющим. Автоматического снижения балла нет.`)));
    if (e.review.verified) bannerBox.appendChild(h('div', { class: 'banner good' }, icon('check'), h('div', {}, `Проверено человеком: ${actorLabel(e.review.verified.by)}, ${fmtDate(e.review.verified.at)}${e.review.verified.note ? ` — ${e.review.verified.note}` : ''}`)));
  }

  async function verify() {
    const note = await openModal((close) => {
      const ta = h('textarea', { class: 'textarea', placeholder: 'Комментарий (необязательно)' });
      return {
        title: 'Подтвердить проверку оценки',
        body: [h('p', { class: 'dim' }, 'Отметить оценку как проверенную человеком. Нерешённые сигналы риска останутся в истории.'), ta],
        footer: [h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Отмена'), h('button', { class: 'btn primary', onclick: () => close(ta.value) }, 'Подтвердить')],
      };
    });
    if (note === null) return;
    try {
      await api.post(`/api/evaluations/${state.data.evaluation.id}/verify`, { note });
      toast('Оценка отмечена как проверенная', 'good');
      await reload();
    } catch (e) { errorToast(e); }
  }

  // ---------- Right pane ----------
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const rightBody = h('div', { class: 'pane-scroll' });
  const rightPane = h('div', { class: 'card pane' }, tabsEl, rightBody);

  function renderTabs() {
    const e = state.data.evaluation;
    const nCrit = e ? e.critical_findings.filter((f) => e.critical_reviews?.[f.id]?.decision !== 'false_positive').length : 0;
    const tabs = [
      ['eval', 'Оценка CQA', null],
      ['findings', 'Нарушения и риски', nCrit ? h('span', { class: 'count critical' }, String(nCrit)) : null],
      ['appeals', 'Апелляции', state.data.appeals.length ? h('span', { class: 'count' }, String(state.data.appeals.length)) : null],
      ['history', 'История', state.data.evaluations.length > 1 ? h('span', { class: 'count' }, String(state.data.evaluations.length)) : null],
      ['quality', 'Качество текста', null],
    ];
    mount(tabsEl, tabs.map(([id, label, badge]) => h('button', { role: 'tab', class: state.tab === id ? 'active' : '', 'aria-selected': state.tab === id ? 'true' : 'false', onclick: () => { state.tab = id; renderRight(); } }, label, badge)));
  }

  function renderRight() {
    renderTabs();
    clear(rightBody);
    const e = state.data.evaluation;
    const t = state.tab;
    if (t === 'eval') rightBody.append(...evalTab(e).filter(Boolean));
    else if (t === 'findings') rightBody.append(findingsTab(e));
    else if (t === 'appeals') rightBody.append(appealsTab());
    else if (t === 'history') rightBody.append(historyTab(e));
    else rightBody.append(qualityTab(e));
  }

  function diffPanel() {
    const d = state.diff;
    if (!d) return null;
    const changes = d.score.changes.filter((c) => c.kind !== 'same');
    const delta = d.score.delta;
    return h('div', { class: 'diff', id: 'diff-panel' },
      h('div', { class: 'row' }, icon('refresh'), h('b', {}, 'Что изменилось после переоценки'), h('div', { class: 'spacer' }),
        h('button', { class: 'btn ghost xs', onclick: () => { state.diff = null; renderRight(); } }, 'Скрыть')),
      h('div', { class: 'small mt-8' }, `Итог: ${fmtScore(d.score.total_before)} → `, h('b', {}, fmtScore(d.score.total_after)),
        delta !== null ? h('span', { class: `delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}` }, ` (${delta > 0 ? '+' : ''}${fmtScore(delta)})`) : null,
        ` · чек-лист v${d.before.checklist_version} → v${d.after.checklist_version} · ${d.before.engine_label} → ${d.after.engine_label}`),
      changes.length ? h('div', { class: 'mt-8' }, changes.map((c) => {
        const name = c.after?.name || c.before?.name || c.criterion_id;
        const code = c.after?.code || c.before?.code || '';
        const what = c.kind === 'added' ? `добавлен: ${c.after.answer_label}` : c.kind === 'removed' ? 'удалён из чек-листа'
          : `${c.before.answer_label} → ${c.after.answer_label}${c.before.nominal_weight !== c.after.nominal_weight ? ` · вес ${c.before.nominal_weight} → ${c.after.nominal_weight}` : ''}${c.before.name !== c.after.name ? ' · новая формулировка' : ''}`;
        const dp = (c.after?.points ?? 0) - (c.before?.points ?? 0);
        return h('div', { class: 'diff-row' }, h('span', { class: 'mono muted' }, code), h('span', {}, h('b', {}, name), h('span', { class: 'dim' }, ` — ${what}`)),
          h('span', { class: `num delta ${dp > 0.004 ? 'up' : dp < -0.004 ? 'down' : 'same'}` }, `${dp > 0 ? '+' : ''}${fmtScore(dp)}`));
      })) : h('div', { class: 'small muted mt-8' }, 'Ответы по критериям не изменились.'));
  }

  function evalTab(e) {
    if (!e) {
      return [emptyState('sparkle', 'Диалог ещё не оценён', engineInfo?.ai_available ? 'Запустите AI-оценку по активному чек-листу.' : 'AI-ключ не задан — доступна оценка офлайн-правилами.',
        h('button', { class: 'btn primary', onclick: () => runEvaluation(engineInfo?.ai_available ? 'ai' : 'rules') }, icon('sparkle'), 'Оценить'))];
    }
    const s = e.score_final;
    const cl = e.checklist;
    const out = [];
    const diff = diffPanel();
    if (diff) out.push(h('div', { class: 'eval-top' }, diff));
    const sectionTiles = s.sections.filter((x) => !x.has_flags).map((sec) => {
      const bar = h('i');
      bar.style.width = `${sec.score_pct ?? 0}%`;
      bar.style.background = sec.score_pct === null ? 'var(--neutral)' : `var(--${scoreTone(sec.score_pct) === 'none' ? 'neutral' : scoreTone(sec.score_pct)})`;
      return h('div', { class: 'section-tile' }, h('div', { class: 'n' }, sec.name),
        h('div', { class: 'v' }, sec.score_pct === null ? 'N/A' : `${fmtScore(sec.score_pct)}%`),
        h('div', { class: 'xs muted' }, sec.score_pct === null ? 'нет применимых критериев' : `${fmtScore(sec.points)} из ${fmtScore(sec.max_points)} баллов`),
        h('div', { class: 'bar' }, bar));
    });
    const breakdown = h('details', {},
      h('summary', { class: 'small dim' }, 'Как рассчитан балл'),
      h('div', { class: 'col mt-8' },
        h('div', { class: 'formula' }, s.formula),
        h('div', { class: 'xs muted' }, `Правило N/A: вес неприменимых критериев перераспределяется пропорционально между применимыми (максимум остаётся ${s.max_score}). Округление итога: до ${s.policy.rounding.decimals} знаков. Грубые ошибки: отмечаются отдельно, балл не меняют.`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ['Критерий', 'Ответ', 'Вес', 'Вес после N/A', 'Доля', 'Баллы'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
          h('tbody', {}, s.criteria.map((r) => h('tr', {},
            h('td', {}, `${r.code} ${r.name}`), h('td', {}, r.answer_label),
            h('td', { class: 'num' }, r.role === 'flag' ? '—' : fmtScore(r.nominal_weight)),
            h('td', { class: 'num' }, r.role === 'flag' ? '—' : fmtScore(r.effective_weight)),
            h('td', { class: 'num' }, r.normalized === null ? '—' : fmtScore(r.normalized, 4)),
            h('td', { class: 'num' }, r.role === 'flag' ? '—' : fmtScore(r.points)))))))));
    out.push(h('div', { class: 'eval-top' },
      h('div', { class: 'row' }, h('h3', {}, 'Итог: ', h('span', { class: `score-pill ${scoreTone(s.total)}` }, fmtScore(s.total)), h('span', { class: 'muted' }, ' / 100')),
        s.complete === false ? h('span', { class: 'chip warning', title: 'Итог посчитан только по оценённым критериям' }, icon('alert'), `предварительный: не оценено ${s.coverage.criteria_total - s.coverage.criteria_evaluated}`) : null,
        e.engine.used === 'rules' ? h('span', { class: 'chip outline', title: 'Результат офлайн-правил: не AI, требует подтверждения проверяющим' }, 'предварительная · офлайн-правила, без AI') : null,
        h('div', { class: 'spacer' }), h('span', { class: 'xs muted' }, cl.name)),
      sectionTiles.length ? h('div', { class: 'sections' }, sectionTiles) : null,
      e.summary ? h('div', { class: 'banner info' }, icon('sparkle'), h('div', {}, h('b', {}, e.engine.used === 'rules' ? 'Резюме автоматической оценки: ' : 'Резюме AI: '), e.summary)) : null,
      breakdown));

    const results = new Map(e.results.map((r) => [r.criterion_id, r]));
    const rows = new Map(s.criteria.map((r) => [r.criterion_id, r]));
    const appealsByCrit = {};
    for (const a of state.data.appeals.filter((x) => x.evaluation_id === e.id)) (appealsByCrit[a.criterion_id] ||= []).push(a);
    const sections = cl.sections.length ? cl.sections : [{ id: null, name: 'Критерии' }];
    for (const sec of sections) {
      const crits = cl.criteria.filter((c) => c.enabled && (sec.id === null || c.section_id === sec.id));
      if (!crits.length) continue;
      out.push(h('div', { class: 'section-label' }, sec.name, h('span', { class: 'line' })));
      for (const c of crits) {
        out.push(criterionCard(c, results.get(c.id), rows.get(c.id), {
          override: e.overrides?.[c.id],
          officialChecklist: e.checklist?.official === true,
          appeals: appealsByCrit[c.id] || [],
          open: state.open.has(c.id),
          onEvidence: (ids) => showEvidence(ids),
          onRange: (range, ids) => showRange(range, ids),
          onAppeal: async (cc, rr) => { const a = await openAppealModal(e, cc, rr); if (a) { state.open.add(cc.id); await reload(); } },
          onOverride: async (cc, rr) => { const ne = await openOverrideModal(e, cc, rr); if (ne) { state.open.add(cc.id); await reload(); } },
        }));
      }
    }
    // remember expanded cards between re-renders
    queueMicrotask(() => {
      for (const el of rightBody.querySelectorAll('.crit')) {
        el.querySelector('.crit-head')?.addEventListener('click', () => {
          const id = el.id.replace('crit-', '');
          if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
        });
      }
    });
    if (e.warnings?.length) {
      out.push(h('details', { class: 'eval-top' }, h('summary', { class: 'xs muted' }, `Предупреждения валидатора ответа AI: ${e.warnings.length}`),
        h('ul', { class: 'xs muted' }, e.warnings.map((w) => h('li', {}, w)))));
    }
    return out;
  }

  function findingsTab(e) {
    if (!e) return emptyState('shield', 'Нет оценки', 'Сначала оцените диалог.');
    if (!e.critical_findings.length) return emptyState('shield', 'Грубых ошибок и сигналов риска не выявлено', 'Проверены: оскорбления, платные услуги в обход компании, раскрытие конфиденциальной информации, запросы SMS-кодов, обещания доходности.');
    return h('div', {}, e.critical_findings.map((f) => {
      const rev = e.critical_reviews?.[f.id];
      return h('div', { class: `finding ${f.severity === 'critical' ? '' : 'high'} ${rev?.decision === 'false_positive' ? 'rejected' : ''}` },
        h('div', { class: 'finding-head' }, icon(f.severity === 'critical' ? 'alert' : 'shield'), h('b', {}, f.name),
          h('span', { class: `chip ${f.severity === 'critical' ? 'critical' : 'warning'}` }, SEVERITY_LABELS[f.severity] || f.severity),
          h('span', { class: 'chip outline' }, f.kind === 'gross_error' ? 'Критерий 08 «Грубые ошибки»' : 'Сигнал вне чек-листа'),
          h('span', { class: 'xs muted' }, `источник: ${f.source === 'ai+rules' ? 'AI и правила' : f.source === 'ai' ? 'AI' : 'офлайн-правила'}`),
          f.possible_legitimate_context ? h('span', { class: 'chip info' }, 'возможно, штатная процедура') : null),
        h('div', { class: 'small' }, f.explanation),
        h('div', { class: 'evidence-list' }, f.evidence.map((ev) => evidenceButton(ev, () => showEvidence([ev.message_id])))),
        rev ? h('div', { class: 'small' }, h('span', { class: `chip ${rev.decision === 'confirmed' ? 'critical' : 'good'}` }, rev.decision === 'confirmed' ? 'Подтверждено проверяющим' : 'Ложное срабатывание'),
          h('span', { class: 'muted' }, ` ${actorLabel(rev.by)} · ${fmtDate(rev.at)}${rev.note ? ` — ${rev.note}` : ''}`))
          : store.state.role === 'reviewer' ? h('div', { class: 'row' },
            h('button', { class: 'btn sm danger', onclick: () => reviewFinding(f, 'confirmed') }, icon('alert'), 'Подтвердить нарушение'),
            h('button', { class: 'btn sm', onclick: () => reviewFinding(f, 'false_positive') }, icon('x'), 'Ложное срабатывание'))
            : h('div', { class: 'xs muted' }, 'Ожидает решения проверяющего (переключите роль в шапке).'));
    }));
  }

  async function reviewFinding(f, decision) {
    const note = await openModal((close) => {
      const ta = h('textarea', { class: 'textarea', placeholder: 'Комментарий проверяющего' });
      return {
        title: decision === 'confirmed' ? `Подтвердить: ${f.name}` : `Отклонить сигнал: ${f.name}`,
        body: [ta],
        footer: [h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Отмена'), h('button', { class: `btn ${decision === 'confirmed' ? 'danger' : 'primary'}`, onclick: () => close(ta.value) }, 'Сохранить')],
      };
    });
    if (note === null) return;
    try {
      await api.post(`/api/evaluations/${state.data.evaluation.id}/findings/${api.enc(f.id)}/review`, { decision, note });
      toast('Решение сохранено', 'good');
      await reload();
    } catch (err) { errorToast(err); }
  }

  function appealsTab() {
    const list = state.data.appeals;
    if (!list.length) return emptyState('scale', 'Апелляций нет', 'Оператор может оспорить оценку любого критерия кнопкой «Оспорить оценку».');
    return h('div', { class: 'col', style: { padding: '12px' } }, list.map((a) => h('a', { class: 'card', href: `#/appeals/${a.id}` },
      h('div', { class: 'card-head' }, appealChip(a.status), h('b', { class: 'mono' }, a.id), h('span', {}, `${a.criterion_code} ${a.criterion_name}`), h('div', { class: 'spacer' }), h('span', { class: 'xs muted' }, fmtDate(a.created_at))),
      h('div', { class: 'card-body small dim' }, `«${a.comment}»`, a.decision ? h('div', { class: 'mt-4' }, h('b', {}, 'Решение: '), `${a.decision.type === 'change' ? `${a.original.answer_label} → ${a.decision.answer_label}` : 'оценка подтверждена'} · итог ${fmtScore(a.decision.total_before)} → ${fmtScore(a.decision.total_after)}`) : null))));
  }

  function historyTab(e) {
    const evs = state.data.evaluations;
    const items = [];
    if (e) {
      for (const hst of [...e.history].reverse()) {
        items.push(h('div', { class: 'tl-item' }, h('div', { class: `tl-dot ${hst.action === 'override' ? 'info' : hst.action.startsWith('finding') ? 'warn' : ''}` }),
          h('div', {}, h('div', { class: 'tl-text' }, h('b', {}, ACTIONS[hst.action] || hst.action),
            hst.criterion_id ? ` · ${hst.criterion_id}: ${hst.from?.answer ?? hst.from?.status ?? '—'} → ${hst.to?.answer ?? hst.to?.status ?? '—'}` : '',
            hst.total_before !== undefined ? ` · итог ${fmtScore(hst.total_before)} → ${fmtScore(hst.total_after)}` : '',
            hst.reason || hst.note ? h('div', { class: 'dim small' }, hst.reason || hst.note) : null),
          h('div', { class: 'tl-time' }, `${actorLabel(hst.actor)} · ${fmtDate(hst.at)}`))));
      }
    }
    return h('div', { class: 'col', style: { padding: '12px 16px' } },
      h('h4', {}, 'Оценки диалога'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Оценка', 'Когда', 'Движок', 'Чек-лист', 'Итог', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, evs.map((ev, i) => h('tr', {},
          h('td', { class: 'id' }, ev.id), h('td', { class: 'small' }, fmtDate(ev.created_at)), h('td', { class: 'small' }, ev.engine_label),
          h('td', { class: 'small' }, `v${ev.checklist_version}`), h('td', {}, fmtScore(ev.total), ev.total !== ev.total_original ? h('span', { class: 'muted xs' }, ` (исх. ${fmtScore(ev.total_original)})`) : null),
          h('td', {}, i < evs.length - 1 ? h('button', { class: 'btn xs', onclick: () => compare(evs[i + 1].id, ev.id) }, 'Сравнить с предыдущей') : null)))))),
      h('h4', { class: 'mt-16' }, 'История действий по текущей оценке'),
      items.length ? h('div', { class: 'timeline' }, items) : h('div', { class: 'muted small' }, 'Пока нет действий'));
  }

  async function compare(a, b) {
    try {
      state.diff = await api.get(`/api/evaluations/${a}/compare/${b}`);
      state.tab = 'eval';
      renderRight();
      rightBody.scrollTop = 0;
    } catch (e) { errorToast(e); }
  }

  function qualityTab(e) {
    const q = conv.quality;
    const flagCounts = {};
    for (const m of conv.messages) for (const f of m.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
    return h('div', { class: 'col', style: { padding: '14px 16px' } },
      h('div', { class: `banner ${QUALITY[q.level][0]}` }, icon('info'), h('div', { class: 'b-body' }, h('b', {}, QUALITY[q.level][1]), q.notes.map((n) => h('div', {}, n)))),
      h('div', { class: 'small dim' }, 'Нормализация выполняется только когда она доказуемо корректна: текст переводится обратно в байты Windows-1251 и строго декодируется как UTF-8. Если декодирование не проходит, показывается оригинал. Оригинальный текст всегда доступен переключателем «Оригинал» и в метке «кодировка» у реплики.'),
      h('dl', { class: 'kv' }, Object.entries(flagCounts).map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]).flat()),
      e?.transcript_issues?.length ? h('div', {}, h('h4', {}, 'Проблемы транскрипта, отмеченные AI'),
        h('div', { class: 'evidence-list mt-8' }, e.transcript_issues.map((ti) => {
          const m = msgById.get(ti.message_id);
          return evidenceButton({ message_id: ti.message_id, t_label: m?.t_label, speaker: m?.speaker, quote: `${ti.issue}` }, () => showEvidence([ti.message_id]));
        }))) : null,
      conv.has_audio ? h('div', { class: 'small muted' }, 'Аудио: запись проксируется сервером; подписанная ссылка не передаётся в браузер. Интонация и дикция не оцениваются — анализируется только транскрипт.') : null);
  }

  mount(root, headCard, bannerBox, h('div', { class: 'split' }, leftPane, rightPane));
  renderHead();
  renderRight();

  const onRole = () => { renderHead(); renderRight(); };
  window.addEventListener('cqa:role', onRole);
  void confidenceMeter;
  return () => {
    window.removeEventListener('cqa:role', onRole);
    player?.destroy();
  };
}
