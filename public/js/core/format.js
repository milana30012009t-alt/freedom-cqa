// Formatting helpers and shared label maps (UI language: Russian).
import { h } from './dom.js';
import { icon } from './icons.js';
import { APPEAL_STATUSES, SITUATIONS, SEVERITY_LABELS, REVIEW_PRIORITY_LABELS, LANGUAGE_LABELS, SPEAKER_LABELS } from '../../shared/constants.js';
import { formatDuration, formatDateTime } from '../../shared/time.js';

export { APPEAL_STATUSES, SITUATIONS, SEVERITY_LABELS, REVIEW_PRIORITY_LABELS, LANGUAGE_LABELS, SPEAKER_LABELS, formatDuration, formatDateTime };

export function fmtScore(v, decimals = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Number(v.toFixed(decimals));
  return s.toLocaleString('ru-RU', { maximumFractionDigits: decimals });
}

export function fmtNum(v, d = 0) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', { maximumFractionDigits: d });
}

export function fmtPct(v, d = 0) {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toLocaleString('ru-RU', { maximumFractionDigits: d })}%`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return formatDateTime(Date.parse(iso));
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  return fmtDate(iso);
}

export function scoreTone(v) {
  if (!Number.isFinite(v)) return 'none';
  if (v >= 85) return 'good';
  if (v >= 70) return 'warning';
  if (v >= 50) return 'serious';
  return 'critical';
}

export function scorePill(v, { complete = true } = {}) {
  if (!Number.isFinite(v)) return h('span', { class: 'score-pill none' }, '—');
  return h('span', { class: `score-pill ${scoreTone(v)}`, title: complete ? '' : 'Предварительный: часть критериев не оценена' },
    fmtScore(v), complete ? null : h('span', { class: 'max' }, '*'));
}

export const STATUS_META = {
  not_evaluated: { label: 'Не оценён', tone: '', icon: 'clock' },
  auto: { label: 'Предварительная (авто)', tone: 'info', icon: 'sparkle' },
  needs_review: { label: 'Требует проверки', tone: 'warning', icon: 'eye' },
  reviewed: { label: 'Проверен', tone: 'good', icon: 'check' },
  appeal: { label: 'Апелляция', tone: 'serious', icon: 'scale' },
};

export function statusChip(status) {
  const m = STATUS_META[status] || STATUS_META.not_evaluated;
  return h('span', { class: `chip ${m.tone}` }, icon(m.icon), m.label);
}

const APPEAL_TONES = { new: 'info', pending: 'warning', confirmed: 'good', changed: 'serious', closed: '' };
export function appealChip(status) {
  if (!status) return h('span', { class: 'muted' }, '—');
  return h('span', { class: `chip ${APPEAL_TONES[status] || ''}` }, APPEAL_STATUSES[status] || status);
}

const PRIORITY_TONES = { critical: 'critical', high: 'warning', medium: 'info', low: '' };
export function priorityChip(p) {
  if (!p) return h('span', { class: 'muted' }, '—');
  return h('span', { class: `chip ${PRIORITY_TONES[p]}` }, p === 'critical' ? icon('alert') : null, REVIEW_PRIORITY_LABELS[p] || p);
}

export function langChip(lang) {
  return h('span', { class: 'chip lang outline', title: LANGUAGE_LABELS[lang] || lang }, lang);
}

export function channelChip(type) {
  return type === 'call'
    ? h('span', { class: 'chip outline' }, icon('phone'), 'Звонок')
    : h('span', { class: 'chip outline' }, icon('message'), 'Чат');
}

export function answerBadge(situation, label, { flag = false } = {}) {
  const cls = flag && situation === 'not_met' ? 'violation' : situation || 'unclear';
  const ic = { met: 'check', partial: 'minus', not_met: flag ? 'alert' : 'x', na: 'minus', unclear: 'info', violation: 'alert' }[cls] || 'info';
  return h('span', { class: `answer ${cls}` }, icon(ic), label);
}

export function confidenceMeter(c) {
  if (!Number.isFinite(c)) return null;
  const tone = c >= 0.75 ? 'var(--good)' : c >= 0.6 ? 'var(--warning)' : 'var(--serious)';
  const fill = h('i');
  fill.style.width = `${Math.round(c * 100)}%`;
  fill.style.background = tone;
  return h('span', { class: 'confidence', title: 'Уверенность оценки' }, 'Уверенность', h('span', { class: 'meter' }, fill), `${Math.round(c * 100)}%`);
}

export function actorLabel(a) {
  if (!a) return '—';
  const roles = { specialist: 'оператор', reviewer: 'проверяющий', system: 'система' };
  return a.name && a.name !== roles[a.role] ? `${a.name} (${roles[a.role] || a.role})` : roles[a.role] ? roles[a.role][0].toUpperCase() + roles[a.role].slice(1) : a.role;
}
