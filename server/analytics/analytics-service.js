// Dashboard and analytics figures. Every number is computed from the loaded transcripts and the
// stored evaluations; nothing is hardcoded. Aggregates never include transcript text (no PII).
import { LEX, normalizeForMatch } from '../evaluation/rules/lexicon.js';

const TOPICS = [
  ['tariff', 'Тариф и комиссии', /тариф|комисс|pricing plan|current plan|fee|тарифте/iu],
  ['funding', 'Пополнение и реквизиты', /пополн|реквизит|деректеме|аудар|transfer details|fund the|add funds|bank transfer|ақша аудар/iu],
  ['payment_check', 'Зачисление платежа', /денег вс[её] ещ[её] нет|не зачисл|hasn't shown|still not|көрінбей тұр|already sent|уже отправ/iu],
  ['withdrawal', 'Вывод средств', /вывод|вывест|шығар|withdraw/iu],
  ['reports', 'Отчёты и документы', /отч[её]т|есеп|report|statement|1042|налог|financial statements|отч[её]тност/iu],
  ['access', 'Вход и кабинет', /вход|логин|кабинет|не пускает|login|sign-in|sign in|get into|кіретін|логин бос/iu],
  ['trading', 'Покупка бумаг и приказы', /облигац|акци|бумаг|приказ|тикер|марж|өтінім|қағаз|bond|stock|order|ticker|margin|d-сч|d-шот|d account/iu],
  ['personal_data', 'Персональные данные', /анкет|персональн|изменени[ея] сведений|деректерді жаңарт|profile details|personal details/iu],
  ['advice', 'Инвестиционный совет', /что купить|деньги выросли|рекомендуете|консультац|advice/iu],
];

function topicOf(conv) {
  const text = conv.messages.filter((m) => m.speaker === 'client' && m.segment !== 'after_end').slice(0, 4).map((m) => m.text).join(' ');
  for (const [id, label, re] of TOPICS) if (re.test(text)) return { id, label };
  return { id: 'other', label: 'Другое' };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

export class AnalyticsService {
  constructor({ datasets, evaluations, appeals, checklists }) {
    this.datasets = datasets;
    this.evaluations = evaluations;
    this.appeals = appeals;
    this.checklists = checklists;
  }

  summary(group) {
    const convs = this.datasets.conversations(group);
    const latest = convs.map((c) => ({ conv: c, ev: this.evaluations.latestFor(c.uid) }));
    const evaluated = latest.filter((x) => x.ev);
    const scores = evaluated.map((x) => x.ev.score_final.total).filter((t) => Number.isFinite(t));
    const appealCounts = this.appeals.counts();
    const groupAppeals = this.appeals.list().filter((a) => convs.some((c) => c.uid === a.conversation_uid));
    const openAppeals = groupAppeals.filter((a) => a.status === 'new' || a.status === 'pending');
    const isActiveFinding = (ev, f) => ev.critical_reviews?.[f.id]?.decision !== 'false_positive';
    const criticalCases = evaluated.filter((x) => x.ev.critical_findings.some((f) => f.severity === 'critical' && isActiveFinding(x.ev, f)));
    const riskCases = evaluated.filter((x) => x.ev.critical_findings.some((f) => f.severity !== 'critical' && isActiveFinding(x.ev, f)));

    const byLanguage = {};
    const byChannel = {};
    for (const { conv, ev } of latest) {
      for (const [bucket, key] of [[byLanguage, conv.language], [byChannel, conv.channel_type]]) {
        bucket[key] = bucket[key] || { count: 0, evaluated: 0, scores: [] };
        bucket[key].count += 1;
        if (ev) {
          bucket[key].evaluated += 1;
          if (Number.isFinite(ev.score_final.total)) bucket[key].scores.push(ev.score_final.total);
        }
      }
    }
    const finalize = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { count: v.count, evaluated: v.evaluated, avg_score: v.scores.length ? round(v.scores.reduce((s, x) => s + x, 0) / v.scores.length) : null }]));

    const buckets = [
      { label: '0–49', min: 0, max: 49.999, count: 0 },
      { label: '50–69', min: 50, max: 69.999, count: 0 },
      { label: '70–84', min: 70, max: 84.999, count: 0 },
      { label: '85–100', min: 85, max: 100, count: 0 },
    ];
    for (const s of scores) {
      const b = buckets.find((x) => s >= x.min && s <= x.max);
      if (b) b.count += 1;
    }

    // Criteria performance on the active checklist (only evaluations made with the same criterion ids).
    const activeChecklist = this.checklists.getActive();
    const criteria = (activeChecklist?.checklist.criteria || []).filter((c) => c.enabled).map((c) => {
      const row = { id: c.id, code: c.code, name: c.name, role: c.scoring_role, met: 0, partial: 0, not_met: 0, na: 0, not_evaluated: 0, total: 0, examples: [], recommendation: null };
      for (const { conv, ev } of evaluated) {
        const sc = ev.score_final.criteria.find((x) => x.criterion_id === c.id);
        if (!sc) continue;
        row.total += 1;
        if (sc.status === 'na') row.na += 1;
        else if (sc.status !== 'scored') row.not_evaluated += 1;
        else {
          const r = ev.results.find((x) => x.criterion_id === c.id);
          const ov = ev.overrides?.[c.id];
          let situation;
          if (c.scoring_role === 'flag') situation = sc.answer === 'yes' ? 'not_met' : 'met';
          else situation = sc.normalized >= 0.999 ? 'met' : sc.normalized <= 0.001 ? 'not_met' : 'partial';
          row[situation] += 1;
          if (situation !== 'met' && row.examples.length < 6) row.examples.push(conv.uid);
          if (situation !== 'met' && !row.recommendation && !ov && r?.recommendation) row.recommendation = r.recommendation;
        }
      }
      const scored = row.met + row.partial + row.not_met;
      row.fail_share = scored ? round((row.partial + row.not_met) / scored, 4) : null;
      return row;
    });
    const recurring = criteria.filter((c) => c.role === 'weighted' && c.fail_share > 0).sort((a, b) => b.fail_share - a.fail_share).slice(0, 5);

    const findingCounts = {};
    for (const { conv, ev } of evaluated) {
      for (const f of ev.critical_findings) {
        if (!isActiveFinding(ev, f)) continue;
        const k = f.name;
        findingCounts[k] = findingCounts[k] || { name: k, severity: f.severity, count: 0, conversations: [] };
        findingCounts[k].count += 1;
        if (!findingCounts[k].conversations.includes(conv.uid)) findingCounts[k].conversations.push(conv.uid);
      }
    }

    // Customer journey (transcript facts, independent of evaluations).
    const chats = convs.filter((c) => c.channel_type === 'chat');
    const escalated = chats.filter((c) => c.events.escalation !== null);
    const botAnsweredThenEscalated = escalated.filter((c) => c.messages.some((m) => m.speaker === 'bot' && m.index < c.events.escalation
      && !/здравствуйте|сәлеметсіз|hello|соглаша|келісесіз|agree to|желаете|қосайын|would you like|ожидайте|күте тұрыңыз|please wait/iu.test(m.text)));
    const firstResponses = chats.map((c) => c.stats.first_response_sec).filter((x) => Number.isFinite(x));
    const threshold = Number(activeChecklist?.checklist.parameters?.first_response_threshold_sec || 180);
    const clientLeft = convs.filter((c) => c.events.client_left !== null);
    const operatorClosed = convs.filter((c) => c.events.operator_closed !== null);

    const topics = {};
    for (const { conv, ev } of latest) {
      const t = topicOf(conv);
      topics[t.id] = topics[t.id] || { id: t.id, label: t.label, count: 0, scores: [], critical: 0, examples: [] };
      topics[t.id].count += 1;
      if (ev && Number.isFinite(ev.score_final.total)) topics[t.id].scores.push(ev.score_final.total);
      if (ev && ev.critical_findings.some((f) => f.severity === 'critical' && isActiveFinding(ev, f))) topics[t.id].critical += 1;
      if (topics[t.id].examples.length < 5) topics[t.id].examples.push(conv.uid);
    }

    const priorityRank = { critical: 0, high: 1, medium: 2, low: 3 };
    const queue = evaluated
      .filter((x) => x.ev.review.needs_human_review)
      .map((x) => ({ ...this.evaluations.summary(x.ev), uid: x.conv.uid, conversation_id: x.conv.conversation_id, language: x.conv.language, channel_type: x.conv.channel_type, reasons: x.ev.review.reasons }))
      .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || (a.total ?? 101) - (b.total ?? 101))
      .slice(0, 12);

    const activity = [];
    for (const { conv, ev } of evaluated) {
      for (const h of ev.history.slice(-3)) activity.push({ at: h.at, kind: 'evaluation', action: h.action, uid: conv.uid, conversation_id: conv.conversation_id, actor: h.actor, note: h.note || h.reason || '' });
    }
    for (const a of groupAppeals) {
      for (const h of a.history.slice(-2)) activity.push({ at: h.at, kind: 'appeal', action: h.action, uid: a.conversation_uid, conversation_id: a.conversation_id, appeal_id: a.id, actor: h.actor, note: h.note });
    }
    activity.sort((a, b) => b.at.localeCompare(a.at));

    const engines = {};
    for (const { ev } of evaluated) engines[ev.engine.used] = (engines[ev.engine.used] || 0) + 1;

    return {
      group: group || this.datasets.status().active_group,
      generated_at: new Date().toISOString(),
      checklist: activeChecklist ? { version: activeChecklist.version, name: activeChecklist.checklist.name, official: activeChecklist.checklist.official } : null,
      totals: {
        conversations: convs.length,
        evaluated: evaluated.length,
        not_evaluated: convs.length - evaluated.length,
        needs_review: evaluated.filter((x) => x.ev.review.needs_human_review).length,
        verified: evaluated.filter((x) => x.ev.review.verified).length,
        appeals_open: openAppeals.length,
        appeals_total: groupAppeals.length,
        critical_cases: criticalCases.length,
        risk_cases: riskCases.length,
        avg_score: scores.length ? round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
        median_score: round(median(scores)),
        preliminary: evaluated.filter((x) => !x.ev.score_final.complete).length,
        overridden: evaluated.filter((x) => Object.keys(x.ev.overrides || {}).length).length,
      },
      appeals_by_status: appealCounts,
      by_language: finalize(byLanguage),
      by_channel: finalize(byChannel),
      score_buckets: buckets.map(({ label, count }) => ({ label, count })),
      criteria,
      recurring_issues: recurring,
      findings: Object.values(findingCounts).sort((a, b) => b.count - a.count),
      topics: Object.values(topics).map((t) => ({ id: t.id, label: t.label, count: t.count, evaluated: t.scores.length, avg_score: t.scores.length ? round(t.scores.reduce((s, x) => s + x, 0) / t.scores.length) : null, critical: t.critical, examples: t.examples })).sort((a, b) => b.count - a.count),
      journey: {
        chats: chats.length,
        escalated_from_bot: escalated.length,
        bot_answered_then_escalated: botAnsweredThenEscalated.length,
        median_first_response_sec: round(median(firstResponses), 1),
        max_first_response_sec: firstResponses.length ? Math.max(...firstResponses) : null,
        first_response_over_threshold: firstResponses.filter((x) => x > threshold).length,
        first_response_threshold_sec: threshold,
        client_left: clientLeft.length,
        operator_closed: operatorClosed.length,
      },
      quality: {
        repaired_messages: convs.reduce((s, c) => s + c.quality.repaired_messages, 0),
        conversations_with_repairs: convs.filter((c) => c.quality.repaired_messages > 0).length,
        asr_flagged_messages: convs.reduce((s, c) => s + c.quality.asr_flagged_messages, 0),
        masked_messages: convs.reduce((s, c) => s + c.quality.masked_messages, 0),
        low_quality_conversations: convs.filter((c) => c.quality.level === 'low').length,
      },
      engines,
      priority_queue: queue,
      recent_activity: activity.slice(0, 12),
    };
  }
}

export { normalizeForMatch, LEX };
