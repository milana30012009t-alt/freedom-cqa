// Additional risk signals outside the scored checklist (e.g. a request to dictate an SMS code).
// They route the conversation to manual review but never change the score by themselves.
import { ref } from './context.js';

const RISK_DETECTORS = {
  otp_request(ctx) {
    const hits = ctx.ops.filter((m) => ctx.opFlags.get(m.id).otp);
    if (!hits.length) return null;
    const legit = hits.some((m) => ctx.opFlags.get(m.id).otpLegit);
    return {
      evidence: hits.slice(0, 3).map((m) => m.id),
      possible_legitimate_context: legit,
      explanation: `Оператор просит назвать одноразовый код/пароль: ${ref(hits[0])}.${legit
        ? ' Контекст указывает на процедуру идентификации (код отправлен оператором), поэтому это может быть штатный порядок — но передача кода голосом сотруднику является риском социальной инженерии. Нужна ручная проверка по регламенту.'
        : ' Признаков штатной процедуры не найдено — высокий риск.'}`,
    };
  },
  profit_promise(ctx) {
    const hits = ctx.ops.filter((m) => ctx.opFlags.get(m.id).profit);
    if (!hits.length) return null;
    return {
      evidence: hits.slice(0, 3).map((m) => m.id),
      possible_legitimate_context: false,
      explanation: `Оператор обещает выгоду от вложений от своего имени: ${ref(hits[0])}.`,
    };
  },
};

export function detectRiskSignals(ctx, checklist) {
  const out = [];
  for (const rule of checklist.risk_rules || []) {
    if (!rule.enabled) continue;
    const fn = RISK_DETECTORS[rule.id];
    if (!fn) continue;
    const hit = fn(ctx);
    if (!hit) continue;
    out.push({
      rule_id: rule.id,
      name: rule.name,
      severity: hit.possible_legitimate_context && rule.severity === 'critical' ? 'high' : rule.severity,
      flag_subtype: rule.flag_subtype || null,
      evidence: hit.evidence,
      explanation: hit.explanation,
      possible_legitimate_context: hit.possible_legitimate_context,
      needs_human_review: true,
      source: 'rules',
    });
  }
  return out;
}

export function supportedRiskRules() {
  return Object.keys(RISK_DETECTORS);
}
