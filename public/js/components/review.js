// Criterion result card + appeal / reviewer decision dialogs.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { openModal, toast, errorToast } from '../core/ui.js';
import { answerBadge, confidenceMeter, fmtScore, fmtDate, actorLabel, appealChip, SITUATIONS, SPEAKER_LABELS } from '../core/format.js';
import { allowedAnswers, answerLabel, situationForAnswer, ANSWER_TYPE_LABELS } from '../../shared/checklist-schema.js';
import { computeScore } from '../../shared/scoring-engine.js';

const ENGINE_SHORT = { ai: 'AI', rules: 'офлайн-правила' };

export function evidenceButton(ev, onClick) {
  return h('button', { class: `ev ${ev.role === 'context' ? 'context' : ''}`, onclick: onClick, title: ev.ts ? `Исходная метка: ${ev.ts}` : '' },
    h('span', { class: 'ev-t' }, h('span', {}, ev.t_label), h('span', { class: 'muted' }, SPEAKER_LABELS[ev.speaker] || ev.speaker), h('span', { class: 'muted' }, ev.message_id)),
    h('span', { class: 'ev-q' }, ev.quote));
}

function describeAllowed(c) {
  if (c.answer_type === 'scale' && c.scale.steps?.length) {
    return h('div', { class: 'col gap-4' }, c.scale.steps.map((s) => h('div', { class: 'small' }, h('b', { class: 'num' }, String(s.value)), h('span', { class: 'dim' }, ` — ${s.label}`))));
  }
  return h('div', { class: 'small dim' }, allowedAnswers(c).map((a) => a.label).join(' / '), c.na_allowed ? ' / N/A' : '');
}

/**
 * @param {object} c criterion (from the evaluation's checklist snapshot)
 * @param {object} r evaluator result
 * @param {object} row score row (score_final.criteria item)
 * @param {object} ctx {override, appeals, onEvidence, onRange, onAppeal, onOverride, open}
 */
export function criterionCard(c, r, row, ctx) {
  const ov = ctx.override;
  const status = ov ? ov.status : r?.status || 'not_evaluated';
  const answer = ov ? ov.answer : r?.answer;
  const situation = situationForAnswer(c, answer, status);
  const label = status === 'na' ? 'N/A' : status === 'not_evaluated' ? 'Не оценён' : answerLabel(c, answer);
  const isFlag = c.scoring_role === 'flag';
  const card = h('div', { class: `crit${ctx.open ? ' open' : ''}`, id: `crit-${c.id}` });
  const body = h('div', { class: `crit-body${ctx.open ? '' : ' hidden'}` });
  const openAppeal = (ctx.appeals || []).find((a) => a.status === 'new' || a.status === 'pending');

  const points = isFlag
    ? h('div', { class: 'crit-points' }, h('span', { class: 'muted' }, 'без баллов'))
    : h('div', { class: 'crit-points' }, status === 'scored' ? h('b', {}, fmtScore(row?.points)) : h('b', { class: 'muted' }, '—'),
      h('div', { class: 'muted' }, status === 'scored' ? `из ${fmtScore(row?.max_points ?? 0)}` : status === 'na' ? 'вес перераспределён' : 'не в итоге'));

  const head = h('div', { class: 'crit-head', role: 'button', tabindex: 0, 'aria-expanded': ctx.open ? 'true' : 'false' },
    h('div', { class: 'crit-code' }, c.code),
    h('div', {},
      h('div', { class: 'crit-name' }, c.name),
      h('div', { class: 'crit-sub' },
        isFlag ? h('span', {}, 'флаг · без баллов') : h('span', {}, `вес ${fmtScore(c.weight)}${row && row.effective_weight && Math.abs(row.effective_weight - c.weight) > 0.005 ? ` → ${fmtScore(row.effective_weight)} после N/A` : ''}`),
        h('span', {}, ANSWER_TYPE_LABELS[c.answer_type]),
        r?.engine ? h('span', {}, ENGINE_SHORT[r.engine] || r.engine) : null,
        ov ? h('span', { class: 'chip info' }, icon('gavel'), 'решение проверяющего') : null,
        openAppeal ? h('span', { class: 'chip serious' }, icon('scale'), openAppeal.id) : null,
        r?.needs_human_review && !ov ? h('span', { class: 'chip warning' }, icon('eye'), 'проверить') : null)),
    h('div', { class: 'crit-right' }, answerBadge(situation, label, { flag: isFlag }), points));
  const toggle = () => {
    body.classList.toggle('hidden');
    card.classList.toggle('open');
    head.setAttribute('aria-expanded', body.classList.contains('hidden') ? 'false' : 'true');
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

  const evidence = r?.evidence || [];
  const supporting = evidence.filter((e) => e.role !== 'context');
  // DOM append() would render null as the text "null": drop absent optional blocks
  body.append(...[
    h('div', {}, h('div', { class: 'label' }, ctx.officialChecklist ? 'Критерий (официальная формулировка)' : 'Формулировка критерия (версия чек-листа изменена командой)'), h('div', { class: 'official' }, c.description || '—')),
    c.guidance ? h('details', {}, h('summary', { class: 'small muted' }, 'Пояснение для единообразной оценки'), h('div', { class: 'note mt-4' }, c.guidance)) : null,
    h('div', {}, h('div', { class: 'label' }, 'Допустимые ответы'), describeAllowed(c)),
    h('div', {}, h('div', { class: 'label' }, 'Результат'),
      h('div', { class: 'row wrap' }, answerBadge(situation, label, { flag: isFlag }), h('span', { class: 'small dim' }, SITUATIONS[situation] || ''),
        !isFlag && status === 'scored' ? h('span', { class: 'small muted' }, `· ${fmtScore(row?.points)} из ${fmtScore(row?.max_points)} баллов в итоге`) : null)),
    status === 'na' ? h('div', {}, h('div', { class: 'label' }, 'Почему N/A'), h('div', { class: 'text' }, (ov ? ov.reason : r?.na_reason) || c.na_condition || '—')) : null,
    h('div', {}, h('div', { class: 'label' }, ov ? 'Обоснование исходной оценки' : 'Обоснование'), h('div', { class: 'text' }, r?.explanation || '—')),
    (r?.flag_subtypes || []).length ? h('div', {}, h('div', { class: 'label' }, 'Выявленные нарушения'),
      h('div', { class: 'row wrap' }, r.flag_subtypes.map((s) => h('span', { class: 'chip critical' }, icon('alert'), (c.flag_subtypes || []).find((x) => x.id === s.id)?.name || s.id)))) : null,
    evidence.length ? h('div', {},
      h('div', { class: 'label' }, r?.evidence_type === 'checked_range' ? 'Проверенный участок и реплики' : 'Доказательства'),
      h('div', { class: 'evidence-list' }, evidence.map((ev) => evidenceButton(ev, () => ctx.onEvidence?.([ev.message_id], ev))))) : null,
    r?.checked_range ? h('div', {}, h('button', { class: 'range-btn', onclick: () => ctx.onRange?.(r.checked_range, supporting.map((e) => e.message_id)) },
      icon('eye'), `Показать проверенный участок: ${r.checked_range.from}–${r.checked_range.to} (${r.checked_range.from_label}–${r.checked_range.to_label}, ${r.checked_range.count} реплик)`)) : null,
    h('div', { class: 'row wrap' }, confidenceMeter(r?.confidence), r?.engine ? h('span', { class: 'small muted' }, `Источник: ${r.engine === 'ai' ? 'AI-модель' : `офлайн-детектор${r.detector ? ` «${r.detector}»` : ''}`}`) : null),
    r?.recommendation ? h('div', {}, h('div', { class: 'label' }, 'Рекомендация оператору'), h('div', { class: 'text' }, r.recommendation)) : null,
    ov ? h('div', { class: 'override-box' },
      h('div', {}, h('b', {}, 'Решение проверяющего: '), `${r?.answer_label ?? '—'} → ${ov.answer_label}`),
      h('div', { class: 'dim small mt-4' }, `Причина: ${ov.reason}`),
      h('div', { class: 'muted xs mt-4' }, `${actorLabel(ov.by)} · ${fmtDate(ov.at)}${ov.appeal_id ? ` · апелляция ${ov.appeal_id}` : ''}${ov.carried_from ? ` · перенесено из ${ov.carried_from}` : ''}`)) : null,
    (ctx.appeals || []).length ? h('div', {}, h('div', { class: 'label' }, 'Апелляции по критерию'),
      h('div', { class: 'col gap-4' }, ctx.appeals.map((a) => h('a', { href: `#/appeals/${a.id}`, class: 'row small' }, appealChip(a.status), h('span', { class: 'mono' }, a.id), h('span', { class: 'muted' }, fmtDate(a.created_at)))))) : null,
    h('div', { class: 'row wrap' },
      store.state.role === 'specialist' ? h('button', { class: 'btn sm', disabled: Boolean(openAppeal), title: openAppeal ? 'По критерию уже есть открытая апелляция' : '', onclick: () => ctx.onAppeal?.(c, r) }, icon('scale'), 'Оспорить оценку') : null,
      store.state.role === 'reviewer' ? h('button', { class: 'btn sm', onclick: () => ctx.onOverride?.(c, r) }, icon('edit'), 'Изменить оценку') : null),
  ].filter(Boolean));
  card.append(head, body);
  return card;
}

export function openAppealModal(evaluation, c, r) {
  return openModal((close) => {
    const comment = h('textarea', { class: 'textarea', placeholder: 'Что именно оценено неверно и почему? Например: «Оператор представился во второй реплике, приветствие было — см. 01:15».', maxlength: 4000 });
    const ov = evaluation.overrides?.[c.id];
    const submit = async () => {
      try {
        const a = await api.post('/api/appeals', { evaluation_id: evaluation.id, criterion_id: c.id, comment: comment.value });
        toast(`Апелляция ${a.id} отправлена на рассмотрение`, 'good');
        window.dispatchEvent(new CustomEvent('cqa:refresh-system'));
        close(a);
      } catch (e) {
        errorToast(e);
      }
    };
    return {
      title: `Оспорить оценку · ${c.code} ${c.name}`,
      body: [
        h('dl', { class: 'kv' },
          h('dt', {}, 'Диалог'), h('dd', { class: 'mono' }, evaluation.conversation_id),
          h('dt', {}, 'Текущая оценка'), h('dd', {}, ov ? ov.answer_label : r?.answer_label || '—'),
          h('dt', {}, 'Итог диалога'), h('dd', {}, fmtScore(evaluation.score_final.total)),
          h('dt', {}, 'Обоснование'), h('dd', { class: 'dim' }, r?.explanation || '—')),
        h('label', { class: 'field' }, h('span', {}, 'Комментарий *'), comment),
        h('div', { class: 'small muted' }, 'Апелляция получит статус «Новая», проверяющий увидит спорную оценку, ваш комментарий и фрагмент диалога. Исходная оценка не будет удалена.'),
      ],
      footer: [h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Отмена'), h('button', { class: 'btn primary', onclick: submit }, icon('scale'), 'Отправить апелляцию')],
    };
  });
}

/**
 * Reviewer decision form with live recalculation of the total (shared scoring engine).
 * @param {{checklist:object, results:Array, overrides:object, criterion:object, allowConfirm:boolean, currentTotal:number}} p
 * @returns {{el:HTMLElement, value:()=>object}}
 */
export function decisionForm({ checklist, results, overrides, criterion: c, allowConfirm = true, currentTotal }) {
  const state = { decision: allowConfirm ? 'confirm' : 'change', status: 'scored', answer: null };
  const answers = allowedAnswers(c);
  const preview = h('div', { class: 'banner info' });
  const reason = h('textarea', { class: 'textarea', placeholder: 'Причина решения (обязательно) — что подтверждают реплики диалога' });
  const options = h('div', { class: 'col gap-4' });

  function renderPreview() {
    if (state.decision === 'confirm') {
      preview.replaceChildren(icon('info'), h('div', {}, `Оценка останется без изменений. Итог: ${fmtScore(currentTotal)}.`));
      return;
    }
    if (state.status === 'scored' && state.answer === null) {
      preview.replaceChildren(icon('info'), h('div', {}, 'Выберите новое значение — итог пересчитается автоматически.'));
      return;
    }
    const next = { ...overrides, [c.id]: { status: state.status, answer: state.answer } };
    const s = computeScore(checklist, results, { overrides: next });
    const delta = Number.isFinite(s.total) && Number.isFinite(currentTotal) ? s.total - currentTotal : null;
    preview.replaceChildren(icon('refresh'), h('div', {}, 'Итог после решения: ', h('b', {}, `${fmtScore(currentTotal)} → ${fmtScore(s.total)}`),
      delta !== null ? h('span', { class: `delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}` }, ` (${delta > 0 ? '+' : ''}${fmtScore(delta)})`) : null,
      c.scoring_role === 'flag' ? h('span', { class: 'muted' }, ' · критерий без баллов: меняется только отметка о грубой ошибке') : null));
  }

  function renderOptions() {
    options.replaceChildren();
    if (state.decision !== 'change') return;
    const name = `ans-${c.id}`;
    for (const a of answers) {
      options.appendChild(h('label', { class: 'check' }, h('input', {
        type: 'radio', name, onchange: () => { state.status = 'scored'; state.answer = a.value; renderPreview(); },
      }), c.answer_type === 'scale' ? `${a.value} — ${a.label.replace(/^\d+ — /, '')}` : a.label));
    }
    if (c.na_allowed) {
      options.appendChild(h('label', { class: 'check' }, h('input', { type: 'radio', name, onchange: () => { state.status = 'na'; state.answer = null; renderPreview(); } }), `N/A — ${c.na_condition || 'неприменимо'}`));
    }
  }

  const decisionSwitch = allowConfirm ? h('div', { class: 'segmented' },
    [['confirm', 'Подтвердить оценку'], ['change', 'Изменить оценку']].map(([v, l]) => {
      const b = h('button', { class: state.decision === v ? 'active' : '', type: 'button' }, l);
      b.addEventListener('click', () => {
        state.decision = v;
        for (const x of decisionSwitch.children) x.classList.toggle('active', x === b);
        renderOptions();
        renderPreview();
      });
      return b;
    })) : null;

  renderOptions();
  renderPreview();
  const el = h('div', { class: 'col gap-12' }, decisionSwitch, options, h('label', { class: 'field' }, h('span', {}, 'Причина *'), reason), preview);
  return {
    el,
    value: () => ({ decision: state.decision, status: state.status, answer: state.answer, reason: reason.value.trim() }),
  };
}

export function openOverrideModal(evaluation, c, r) {
  return openModal((close) => {
    const form = decisionForm({ checklist: evaluation.checklist, results: evaluation.results, overrides: evaluation.overrides || {}, criterion: c, allowConfirm: false, currentTotal: evaluation.score_final.total });
    const save = async () => {
      const v = form.value();
      if (v.status === 'scored' && v.answer === null) { errorToast(new Error('Выберите новое значение')); return; }
      if (!v.reason) { errorToast(new Error('Укажите причину изменения')); return; }
      try {
        const e = await api.post(`/api/evaluations/${evaluation.id}/override`, { criterion_id: c.id, status: v.status, answer: v.answer, reason: v.reason });
        toast(`Оценка изменена. Итог: ${fmtScore(e.score_final.total)}`, 'good');
        close(e);
      } catch (e) {
        errorToast(e);
      }
    };
    return {
      title: `Изменить оценку · ${c.code} ${c.name}`,
      body: [h('div', { class: 'small dim' }, `Сейчас: ${evaluation.overrides?.[c.id]?.answer_label || r?.answer_label || '—'}. Исходная оценка сохранится в истории.`), form.el],
      footer: [h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Отмена'), h('button', { class: 'btn primary', onclick: save }, icon('check'), 'Сохранить решение')],
    };
  });
}
