// Appeals & review: queue by status, detail drawer with the disputed score, AI explanation,
// evidence fragment, user comment, decision with live recalculation, and full history.
import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { setCrumbs } from '../core/crumbs.js';
import { loading, emptyState, toast, errorToast, openDrawer, closeDrawer } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { appealChip, fmtDate, fmtScore, actorLabel, APPEAL_STATUSES, SPEAKER_LABELS, langChip, channelChip, answerBadge } from '../core/format.js';
import { decisionForm, evidenceButton } from '../components/review.js';
import { situationForAnswer } from '../../shared/checklist-schema.js';

const FILTERS = [['', 'Все'], ['new', APPEAL_STATUSES.new], ['pending', APPEAL_STATUSES.pending], ['confirmed', APPEAL_STATUSES.confirmed], ['changed', APPEAL_STATUSES.changed], ['closed', APPEAL_STATUSES.closed]];
const HIST = { created: 'Подана', taken: 'Взята в работу', confirmed: 'Оценка подтверждена', changed: 'Оценка изменена', closed: 'Закрыта', withdrawn: 'Отозвана' };

export async function render(root, { params, query, isCurrent }) {
  setCrumbs(['Апелляции', '#/appeals'], params.id || 'Очередь');
  let filter = query.get('status') || '';
  const listBox = h('div', { class: 'table-wrap' }, loading());
  const tabs = h('div', { class: 'tabs' });

  async function loadList() {
    let data;
    try {
      data = await api.get(`/api/appeals${filter ? `?status=${filter}` : ''}`);
    } catch (e) {
      mount(listBox, emptyState('alert', 'Ошибка', e.message));
      return;
    }
    if (!isCurrent()) return;
    mount(tabs, FILTERS.map(([v, l]) => h('button', { class: filter === v ? 'active' : '', onclick: () => { filter = v; loadList(); } }, l,
      h('span', { class: 'count' }, String(v ? data.counts[v] || 0 : data.counts.total)))));
    if (!data.items.length) {
      mount(listBox, emptyState('scale', 'Апелляций нет', 'Оператор подаёт апелляцию из карточки диалога: раскройте критерий → «Оспорить оценку».'));
      return;
    }
    mount(listBox, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Апелляция', 'Диалог', 'Критерий', 'Исходная оценка', 'Статус', 'Подана', 'Решение'].map((x) => h('th', {}, x)))),
      h('tbody', {}, data.items.map((a) => h('tr', { class: 'clickable', onclick: () => navigate(`/appeals/${a.id}`) },
        h('td', { class: 'id' }, a.id),
        h('td', { class: 'id' }, a.conversation_id),
        h('td', {}, h('span', { class: 'mono muted' }, `${a.criterion_code} `), a.criterion_name),
        h('td', {}, a.original.answer_label, h('div', { class: 'xs muted' }, `итог ${fmtScore(a.original.total)}`)),
        h('td', {}, appealChip(a.status)),
        h('td', { class: 'small' }, fmtDate(a.created_at), h('div', { class: 'xs muted' }, actorLabel(a.created_by))),
        h('td', { class: 'small' }, a.decision ? [a.decision.type === 'change' ? `${a.original.answer_label} → ${a.decision.answer_label}` : 'Подтверждена',
          h('div', { class: 'xs muted' }, `итог ${fmtScore(a.decision.total_before)} → ${fmtScore(a.decision.total_after)}`)] : h('span', { class: 'muted' }, '—')))))));
  }

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Апелляции и ручной пересмотр'),
      h('div', { class: 'sub' }, 'Статусы: Новая → Ожидает рассмотрения → Подтверждена / Изменена → Закрыта. История не удаляется.')),
      h('div', { class: 'spacer' }),
      h('span', { class: 'chip outline' }, icon(store.state.role === 'reviewer' ? 'gavel' : 'user'), `Роль: ${store.state.role === 'reviewer' ? 'проверяющий' : 'оператор'}`)),
    h('div', { class: 'card' }, tabs, listBox));
  await loadList();

  if (params.id) openAppeal(params.id, () => { loadList(); });
  const onRole = () => { if (params.id && location.hash.startsWith(`#/appeals/${params.id}`)) openAppeal(params.id, loadList); };
  window.addEventListener('cqa:role', onRole);
  return () => { window.removeEventListener('cqa:role', onRole); closeDrawer(); };
}

async function openAppeal(id, onChange) {
  let d;
  try {
    d = await api.get(`/api/appeals/${id}`);
  } catch (e) {
    errorToast(e);
    return;
  }
  const refresh = async () => {
    d = await api.get(`/api/appeals/${id}`);
    drawer.rerender();
    onChange?.();
    window.dispatchEvent(new CustomEvent('cqa:refresh-system'));
  };
  const drawer = openDrawer(({ close }) => {
    const a = d.appeal;
    const c = d.criterion;
    const role = store.state.role;
    const open = a.status === 'new' || a.status === 'pending';
    const origSituation = c ? situationForAnswer(c, a.original.answer, a.original.status) : 'unclear';
    const content = [];

    content.push(h('div', { class: 'row wrap' }, appealChip(a.status),
      d.conversation ? [langChip(d.conversation.language), channelChip(d.conversation.channel_type)] : null,
      h('a', { class: 'btn sm', href: `#/c/${encodeURIComponent(a.conversation_uid)}`, onclick: () => close() }, icon('external'), `Открыть диалог ${a.conversation_id}`)));

    content.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Спорная оценка')),
      h('div', { class: 'card-body col' },
        h('dl', { class: 'kv' },
          h('dt', {}, 'Диалог'), h('dd', { class: 'mono' }, a.conversation_id),
          h('dt', {}, 'Критерий'), h('dd', {}, `${a.criterion_code} ${a.criterion_name}`),
          h('dt', {}, 'Формулировка'), h('dd', { class: 'dim' }, c?.description || '—'),
          h('dt', {}, 'Исходный ответ'), h('dd', {}, c ? answerBadge(origSituation, a.original.answer_label, { flag: c.scoring_role === 'flag' }) : a.original.answer_label),
          h('dt', {}, 'Исходные баллы'), h('dd', {}, c?.scoring_role === 'flag' ? 'без баллов (флаг)' : `${fmtScore(a.original.points)} из ${fmtScore(a.original.max_points)}`),
          h('dt', {}, 'Итог диалога'), h('dd', {}, `${fmtScore(a.original.total)} (оценка ${a.evaluation_id}, чек-лист v${a.checklist_version})`),
          h('dt', {}, 'Источник оценки'), h('dd', {}, a.original.engine === 'rules' ? 'офлайн-правила' : 'AI-модель'),
          h('dt', {}, 'Уверенность'), h('dd', {}, a.original.confidence !== null ? `${Math.round(a.original.confidence * 100)}%` : '—')),
        h('div', {}, h('div', { class: 'xs muted' }, 'Пояснение автоматической оценки'), h('div', { class: 'small' }, a.original.explanation || '—')))));

    content.push(h('div', { class: 'banner info' }, icon('user'), h('div', { class: 'b-body' },
      h('div', {}, h('b', {}, 'Комментарий оператора: '), a.comment),
      h('div', { class: 'xs muted' }, `${actorLabel(a.created_by)} · ${fmtDate(a.created_at)}`))));

    content.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Фрагмент диалога'), h('span', { class: 'hint' }, a.original.checked_range ? `проверенный участок ${a.original.checked_range.from}–${a.original.checked_range.to}` : 'реплики-доказательства')),
      h('div', { class: 'card-body' }, d.fragment.length ? h('div', { class: 'evidence-list' }, d.fragment.map((m) => evidenceButton({
        message_id: m.id, t_label: m.t_label, speaker: m.speaker, quote: m.text, ts: m.ts, role: (a.original.evidence || []).some((e) => e.message_id === m.id) ? 'supporting' : 'context',
      }, () => { close(); navigate(`/c/${encodeURIComponent(a.conversation_uid)}`); }))) : h('div', { class: 'small muted' }, 'Нет реплик-доказательств (критерий не оценён автоматически).'))));

    if (a.decision) {
      content.push(h('div', { class: `banner ${a.decision.type === 'change' ? 'warning' : 'good'}` }, icon(a.decision.type === 'change' ? 'edit' : 'check'), h('div', { class: 'b-body' },
        h('div', {}, h('b', {}, a.decision.type === 'change' ? 'Оценка изменена: ' : 'Оценка подтверждена'), a.decision.type === 'change' ? `${a.original.answer_label} → ${a.decision.answer_label}` : ''),
        h('div', {}, `Итог: ${fmtScore(a.decision.total_before)} → `, h('b', {}, fmtScore(a.decision.total_after))),
        h('div', { class: 'small' }, `Причина: ${a.decision.reason}`),
        h('div', { class: 'xs muted' }, `${actorLabel(a.decision.decided_by)} · ${fmtDate(a.decision.decided_at)}`))));
    }

    if (open && role === 'reviewer' && c && d.checklist) {
      const form = decisionForm({ checklist: d.checklist, results: d.results, overrides: d.overrides, criterion: c, allowConfirm: true, currentTotal: d.score.final.total });
      const save = async () => {
        const v = form.value();
        if (!v.reason) { errorToast(new Error('Укажите причину решения')); return; }
        if (v.decision === 'change' && v.status === 'scored' && v.answer === null) { errorToast(new Error('Выберите новое значение')); return; }
        try {
          const r = await api.post(`/api/appeals/${a.id}/decide`, v);
          toast(`Решение сохранено. Итог: ${fmtScore(r.decision.total_after)}`, 'good');
          await refresh();
        } catch (e) { errorToast(e); }
      };
      content.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, icon('gavel'), h('h3', {}, 'Решение проверяющего')),
        h('div', { class: 'card-body col gap-12' },
          a.status === 'new' ? h('button', { class: 'btn sm', onclick: async () => { try { await api.post(`/api/appeals/${a.id}/take`); toast('Апелляция взята в работу', 'good'); await refresh(); } catch (e) { errorToast(e); } } }, icon('eye'), 'Взять в работу') : null,
          form.el,
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, icon('check'), 'Сохранить решение')))));
    } else if (open && role !== 'reviewer') {
      content.push(h('div', { class: 'banner warning' }, icon('info'), h('div', { class: 'b-body' },
        h('div', {}, 'Решение принимает проверяющий. Для демонстрации переключите роль в шапке на «Проверяющий».'),
        a.status === 'new' ? h('div', {}, h('button', { class: 'btn sm', onclick: async () => { try { await api.post(`/api/appeals/${a.id}/close`, { note: 'Отозвана оператором' }); toast('Апелляция отозвана', 'info'); await refresh(); } catch (e) { errorToast(e); } } }, 'Отозвать апелляцию')) : null)));
    } else if (a.status === 'confirmed' || a.status === 'changed') {
      content.push(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { await api.post(`/api/appeals/${a.id}/close`, { note: 'Решение принято' }); toast('Апелляция закрыта', 'good'); await refresh(); } catch (e) { errorToast(e); } } }, icon('check'), 'Закрыть апелляцию')));
    }

    content.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, icon('clock'), h('h3', {}, 'История')),
      h('div', { class: 'card-body' }, h('div', { class: 'timeline' }, [...a.history].reverse().map((x) => h('div', { class: 'tl-item' },
        h('div', { class: `tl-dot ${x.action === 'changed' ? 'warn' : x.action === 'created' ? 'info' : ''}` }),
        h('div', {}, h('div', { class: 'tl-text' }, h('b', {}, HIST[x.action] || x.action), x.status_to ? ` → ${APPEAL_STATUSES[x.status_to]}` : '', x.note ? h('div', { class: 'small dim' }, x.note) : null),
          h('div', { class: 'tl-time' }, `${actorLabel(x.actor)} · ${fmtDate(x.at)}`))))))));
    void SPEAKER_LABELS;
    return { title: `Апелляция ${a.id}`, content };
  }, {
    // Closing the drawer returns the URL to the queue (without re-rendering the list).
    onClose: () => { if (location.hash.startsWith(`#/appeals/${id}`)) history.replaceState(null, '', '#/appeals'); },
  });
}
