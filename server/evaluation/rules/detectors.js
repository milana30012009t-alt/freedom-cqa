// Offline (deterministic) detectors. Each returns a proposal with evidence; the scoring engine
// does the arithmetic. Explanations state what was checked, so a reviewer can verify them.
import { LEX, normalizeForMatch, contentStems } from './lexicon.js';
import { analyzeQuestion, ref, splitSentences, words } from './context.js';

const NAME_PATTERNS = [
  /(?:^|[\s,.!—–-])(?:я|Я|это|Это)\s+[А-ЯЁ][а-яё]{1,20}(?=[\s,.!?]|$)/u,
  /(?:^|[\s,.!—–-])(?:мен|Мен)\s+[А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]{1,25}(?=[\s,.!?]|$)/u,
  /(?:^|[\s,.!—–-])(?:I'm|I’m|I am|This is|this is)\s+[A-Z][a-z]{1,20}(?=[\s,.!?]|$)/u,
  /(?:меня зовут|Меня зовут|менің атым|Менің атым|my name is|My name is)\s+\S+/u,
];
const CONFIRM_TAG = /(?:верно|правильно|так|да|right|correct|солай ма|дұрыс па)\?\s*$/iu;
const NAME_QUESTION = /(?:как (?:я )?(?:могу )?к вам обращаться|как вас зовут|каким мы к вам обращаться|как к вам обращаться|what(?:'s| is) your name|сізге қалай)/iu;
const LANG_NAMES = { RU: 'русском', KZ: 'казахском', EN: 'английском' };

const ev = (m, role = 'supporting', note) => (m ? { message_id: m.id, role, ...(note ? { note } : {}) } : null);
const compact = (arr) => arr.filter(Boolean);

function rangeOf(from, to) {
  if (!from || !to) return null;
  return from.index <= to.index ? { from: from.id, to: to.id } : { from: to.id, to: from.id };
}

function asrDoubt(ctx, msgs) {
  return ctx.isCall && msgs.some((m) => m.flags.some((f) => f.startsWith('asr_') || f === 'mixed_script'));
}

function confidence(ctx, base) {
  return ctx.isCall ? Math.max(0.3, Math.round((base - 0.2) * 100) / 100) : base;
}

function noOperator(ctx, criterion) {
  return {
    status: criterion.na_allowed ? 'na' : 'not_evaluated',
    na_reason: 'Оператор не вступал в диалог.',
    explanation: 'В диалоге нет реплик оператора, адресованных клиенту, — проверить критерий невозможно.',
    evidence: [],
    evidence_type: 'none',
    confidence: 0.9,
    needs_human_review: !criterion.na_allowed,
  };
}

// 01 — contact: greeting in the client's language + introduction in the first reply.
export function contact_greeting(ctx, criterion) {
  const { firstOp, ops, conv } = ctx;
  if (!firstOp) return noOperator(ctx, criterion);
  const block = [firstOp];
  if (ctx.isCall && ops[1] && Number.isFinite(ops[1].t) && Number.isFinite(firstOp.t) && ops[1].t - firstOp.t <= 6) block.push(ops[1]);
  const text = block.map((m) => m.text).join(' ');
  const n = normalizeForMatch(text);
  const greetLangs = Object.entries(LEX.greetingFormal).filter(([, re]) => re.test(n)).map(([l]) => l);
  const informal = LEX.greetingInformal.test(n);
  const masked = LEX.maskedName.test(text);
  const named = masked || NAME_PATTERNS.some((re) => re.test(text));
  const expected = conv.language;
  const langOk = greetLangs.includes(expected);
  const doubt = asrDoubt(ctx, block);
  const evidence = compact(block.map((m) => ev(m)));
  const where = `первая реплика оператора ${ref(firstOp)}`;

  if (greetLangs.length && langOk && named) {
    return {
      status: 'scored', situation: 'met', evidence, evidence_type: 'supporting_messages', confidence: confidence(ctx, 0.92),
      explanation: `Проверена ${where}: есть приветствие на ${LANG_NAMES[expected] || 'языке клиента'} языке и представление${masked ? ' (имя скрыто маской в исходных данных)' : ''}.`,
    };
  }
  const problems = [];
  if (!greetLangs.length && !informal) problems.push('нет приветствия');
  if (informal && !greetLangs.length) problems.push('приветствие неформальное («привет»/«сәлем»)');
  if (greetLangs.length && !langOk) problems.push(`приветствие не на языке клиента (${greetLangs.join('/')} вместо ${expected})`);
  if (!named) problems.push('оператор не представился');
  if (doubt && !named && greetLangs.length) {
    return {
      status: 'not_evaluated', evidence, evidence_type: 'supporting_messages', confidence: 0.35, needs_human_review: true,
      explanation: `Проверена ${where}: приветствие есть, но фрагмент распознан с ошибками — имя могло потеряться при распознавании речи. Автоматически снижать оценку нельзя, нужна проверка по записи.`,
      recommendation: 'Прослушайте начало звонка и подтвердите, представился ли оператор.',
    };
  }
  return {
    status: 'scored', situation: 'not_met', evidence, evidence_type: 'checked_range', range: rangeOf(firstOp, block[block.length - 1]),
    confidence: confidence(ctx, problems.length > 1 ? 0.88 : 0.8),
    explanation: `Проверена ${where}: ${problems.join(', ')}.`,
    recommendation: 'Начинайте первый ответ с приветствия на языке клиента и представления: «Здравствуйте! Меня зовут …» / «Сәлеметсіз бе, мен …» / «Hello, I’m …».',
  };
}

// 02 — need discovery.
export function need_discovery(ctx, criterion) {
  const { firstOp, ops, opFlags, clientFlags, msgs } = ctx;
  if (!firstOp) return noOperator(ctx, criterion);
  const nextClientAfter = (m) => msgs.find((x) => x.index > m.index && x.speaker === 'client' && !x.flags.includes('dtmf'));
  const f0 = opFlags.get(firstOp.id);

  if (f0.generic && ctx.issueStated) {
    const reply = nextClientAfter(firstOp);
    return {
      status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.85),
      evidence: compact([ev(firstOp), ...ctx.issueMessages.slice(0, 2).map((m) => ev(m, 'context', 'Клиент уже описал вопрос')), reply && clientFlags.get(reply.id)?.alreadySaid ? ev(reply, 'context') : null]),
      evidence_type: 'supporting_messages',
      explanation: `Клиент заранее описал запрос (${ref(ctx.issueMessages[0])}), но оператор начал с общего вопроса ${ref(firstOp)} — известные детали не учтены.`,
      recommendation: 'Прочитайте переписку с ботом до подключения и начинайте с ответа по существу или с уточнения недостающего.',
    };
  }
  for (const m of ops) {
    const c = nextClientAfter(m);
    if (!c) continue;
    const cf = clientFlags.get(c.id);
    if (cf?.alreadySaid) {
      return {
        status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.85), evidence: [ev(m), ev(c, 'context')], evidence_type: 'supporting_messages',
        explanation: `Оператор переспросил уже известное ${ref(m)}; клиент ответил ${ref(c)}.`,
        recommendation: 'Перед вопросом проверьте, что клиент уже написал боту и в очереди.',
      };
    }
    if (cf?.contextCorrection && !opFlags.get(m.id).question) {
      return {
        status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.78), evidence: [ev(m), ev(c, 'context')], evidence_type: 'supporting_messages',
        explanation: `Оператор ответил, не уточнив обстоятельства ${ref(m)}, и клиенту пришлось поправить: ${ref(c)}.`,
        recommendation: 'Если для ответа не хватает данных (устройство, сайт, конкретная бумага), сначала уточните их.',
      };
    }
  }
  const firstAnswer = ops.find((m) => {
    const f = opFlags.get(m.id);
    return !f.violation && (f.concrete || f.forward || (!f.question && f.substantive));
  });
  if (ctx.issueStated && !firstAnswer && ops.every((m) => opFlags.get(m.id).violation || opFlags.get(m.id).generic || opFlags.get(m.id).farewellOnly)) {
    return {
      status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.7), evidence: compact([ev(firstOp), ev(ctx.issueMessages[0], 'context')]),
      evidence_type: 'supporting_messages',
      explanation: `Оператор не работал с запросом клиента (${ref(ctx.issueMessages[0])}): ${ref(firstOp)}.`,
      recommendation: 'Отвечайте на запрос клиента; при нехватке данных — уточните их.',
    };
  }
  const limit = firstAnswer ? firstAnswer.index : Number.POSITIVE_INFINITY;
  const clarifying = ops.find((m) => {
    if (m.index > limit) return false;
    const f = opFlags.get(m.id);
    if (!f.question || f.generic || f.offerHelp || f.violation) return false;
    const qs = splitSentences(m.text).filter((s) => s.includes('?'));
    return qs.some((s) => !CONFIRM_TAG.test(s) && !NAME_QUESTION.test(s));
  });
  if (clarifying) {
    return {
      status: 'scored', situation: 'met', confidence: confidence(ctx, 0.75), evidence: [ev(clarifying)], evidence_type: 'supporting_messages',
      explanation: `До ответа оператор уточнил недостающее: ${ref(clarifying)}; переспрашивания известного не выявлено.`,
    };
  }
  if (!ctx.issueStated && f0.generic) {
    return {
      status: 'scored', situation: 'met', confidence: confidence(ctx, 0.7), evidence: [ev(firstOp)], evidence_type: 'supporting_messages',
      explanation: `Клиент до подключения не сформулировал вопрос, и оператор уточнил его: ${ref(firstOp)}.`,
    };
  }
  return {
    status: 'na', confidence: confidence(ctx, 0.65), evidence: compact([ev(firstAnswer || firstOp)]), evidence_type: 'supporting_messages',
    na_reason: 'Данных для ответа хватало с самого начала.',
    explanation: `Оператор сразу ответил по существу ${ref(firstAnswer || firstOp)}; признаков переспрашивания или ответа наугад нет — уточнение не требовалось.`,
  };
}

// 03 — identification before disclosure / protected action.
export function identification(ctx, criterion) {
  const { ops, opFlags, clients, clientFlags, msgs, idIndex } = ctx;
  if (!ctx.firstOp) return noOperator(ctx, criterion);
  const disclosures = ops.filter((m) => opFlags.get(m.id).disclosure);
  const early = disclosures.filter((m) => idIndex === null || m.index < idIndex);
  const dismissals = ops.filter((m) => opFlags.get(m.id).idDismissal);
  const idReq = ops.filter((m) => opFlags.get(m.id).idRequired);
  const accountReq = clients.filter((m) => clientFlags.get(m.id)?.accountRequest);
  const idMsg = idIndex !== null ? msgs[idIndex] : null;

  if (early.length || dismissals.length) {
    const first = early[0] || dismissals[0];
    return {
      status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.88),
      evidence: compact([ev(early[0]), ev(dismissals[0]), accountReq[0] ? ev(accountReq[0], 'context') : null]),
      evidence_type: 'supporting_messages', range: rangeOf(ctx.firstOp, first),
      explanation: `${early.length ? `Оператор сообщил сведения о счёте ${ref(early[0])}` : 'Оператор отказался от проверки личности'}${dismissals.length ? `, проверка личности отклонена: ${ref(dismissals[0])}` : ''}. Подтверждения личности до этого момента в диалоге нет.`,
      recommendation: 'Не раскрывайте данные конкретного счёта и не выполняйте защищённые действия до подтверждения личности.',
      critical_flag: early.length > 0,
    };
  }
  if (idMsg) {
    return {
      status: 'scored', situation: 'met', confidence: confidence(ctx, 0.86), evidence: compact([ev(idMsg), idReq[0] ? ev(idReq[0], 'context') : null]),
      evidence_type: 'supporting_messages',
      explanation: `Личность подтверждена ${ref(idMsg)} до раскрытия данных или защищённого действия.`,
    };
  }
  if (idReq.length) {
    return {
      status: 'scored', situation: 'met', confidence: confidence(ctx, 0.72), evidence: [ev(idReq[0])], evidence_type: 'supporting_messages',
      explanation: `Оператор потребовал подтверждение личности ${ref(idReq[0])} и не раскрывал данные счёта без него.`,
    };
  }
  if (accountReq.length) {
    return {
      status: 'na', confidence: 0.5, needs_human_review: true, evidence: [ev(accountReq[0], 'context')], evidence_type: 'supporting_messages',
      na_reason: 'Раскрытия данных счёта или защищённого действия не выявлено.',
      explanation: `Запрос касается конкретного счёта ${ref(accountReq[0])}, но оператор не раскрывал данные и не выполнял защищённых действий. Требуется ли идентификация — уточните у проверяющего.`,
    };
  }
  return {
    status: 'na', confidence: confidence(ctx, 0.8), evidence: [], evidence_type: 'none',
    na_reason: 'Запрос не требовал идентификации.',
    explanation: 'Общий вопрос: оператор не раскрывал данные конкретного счёта и не выполнял защищённых действий, поэтому идентификация не требовалась.',
  };
}

// 04 — correct and complete consultation (official scale 0/5/10/15/20).
export function consultation_completeness(ctx, criterion) {
  const { ops, opFlags, clientLive, clientFlags } = ctx;
  if (!ctx.firstOp) return noOperator(ctx, criterion);
  const liveQuestions = clientLive.filter((m) => clientFlags.get(m.id)?.question);
  if (!ctx.issueStated && !liveQuestions.length) {
    return {
      status: 'na', confidence: confidence(ctx, 0.85), evidence: compact([ev(ctx.firstOp), ev(ctx.lastOp)]), evidence_type: 'checked_range', range: rangeOf(ctx.firstOp, ctx.msgs[ctx.msgs.length - 1]),
      na_reason: 'Чат закончился до того, как клиент сформулировал запрос.',
      explanation: 'Клиент не сформулировал запрос ни до, ни после подключения оператора — консультацию оценить нельзя.',
    };
  }
  const substantive = ops.filter((m) => opFlags.get(m.id).substantive);
  const analyzed = liveQuestions.map((q) => ({ q, ...analyzeQuestion(ctx, q) }));
  // A question that was not answered immediately but the client later confirmed resolution is not "open".
  const resolvedLater = (q) => clientLive.some((m) => m.index > q.index && clientFlags.get(m.id)?.resolved);
  const unanswered = analyzed.filter((a) => !a.addressed && !resolvedLater(a.q));
  const significant = unanswered.filter((a) => [...contentStems(a.q.text)].some((s) => ctx.issueStems.has(s)));
  const secondary = unanswered.filter((a) => !significant.includes(a));
  const challenge = clientLive.find((m) => /почему точно|откуда (?:вы )?знаете|how do you know/iu.test(normalizeForMatch(m.text)));
  const challengeFailed = challenge && unanswered.some((a) => a.q.id === challenge.id);
  const lastClient = clientLive[clientLive.length - 1];
  const confusedAtEnd = lastClient && clientFlags.get(lastClient.id)?.confusion && !ctx.replyBlock(lastClient).some((m) => opFlags.get(m.id).concrete);
  const forwards = ops.filter((m) => opFlags.get(m.id).forward && !opFlags.get(m.id).violation);
  const commit = forwards.length > 0 && ops.some((m) => m.index >= forwards[0].index && (opFlags.get(m.id).followUp || opFlags.get(m.id).nextAction));
  const forwardNoCommit = forwards.length > 0 && !commit;
  const confirmations = clientLive.filter((m) => clientFlags.get(m.id)?.resolved);
  const note = ' Офлайн-правила проверяют наличие и релевантность ответа на каждый вопрос клиента, но не сверяют факты с базой знаний.';

  let share;
  let explanation;
  let evidence;
  let recommendation;
  if (!substantive.length) {
    share = 0;
    const lastOps = ops.slice(-2);
    evidence = compact([...lastOps.map((m) => ev(m)), ev(liveQuestions[0] || ctx.issueMessages[0], 'context')]);
    const viol = ops.some((m) => opFlags.get(m.id).violation);
    explanation = `Ответа по существу нет: ${viol ? 'вместо консультации оператор предложил действие с нарушением' : 'реплики оператора общие или пренебрежительные'} (${lastOps.map(ref).join('; ')}).`;
    recommendation = 'Дайте конкретный ответ на вопрос клиента: путь в приложении, условие или корректный следующий шаг.';
  } else if (challengeFailed) {
    share = 0;
    const a = analyzed.find((x) => x.q.id === challenge.id);
    evidence = compact([ev(challenge, 'context'), ...a.replies.map((m) => ev(m))]);
    explanation = `Клиент усомнился в ответе ${ref(challenge)}, и оператор не обосновал рекомендацию (${a.replies.length ? ref(a.replies[0]) : 'ответа нет'}) — ключевая рекомендация не подтверждена.`;
    recommendation = 'Не делайте категоричных выводов без данных; уточните детали или передайте вопрос на проверку.';
  } else if (confusedAtEnd) {
    share = 0.25;
    evidence = [ev(lastClient, 'context')];
    explanation = `В конце клиенту всё ещё непонятно, как действовать: ${ref(lastClient)}.`;
    recommendation = 'Убедитесь, что клиент понял инструкцию, прежде чем завершать диалог.';
  } else if (significant.length) {
    share = 0.5;
    const a = significant[0];
    evidence = compact([ev(a.q, 'context'), ...a.replies.map((m) => ev(m)), ev(ctx.issueMessages[0], 'context')]);
    explanation = `Часть запроса закрыта, но существенный вопрос остался без ответа: ${ref(a.q)} — ${a.replies.length ? `ответ оператора ${ref(a.replies[0])} его не закрывает` : 'ответа нет'}.`;
    recommendation = 'Ответьте на все вопросы клиента, включая заданные боту до подключения.';
  } else if (secondary.length || forwardNoCommit) {
    share = 0.75;
    if (secondary.length) {
      const a = secondary[0];
      evidence = compact([ev(a.q, 'context'), ...a.replies.map((m) => ev(m))]);
      explanation = `Основной вопрос решён, но второстепенный остался без ответа: ${ref(a.q)}${a.replies.length ? ` → ${ref(a.replies[0])}` : ''}.`;
    } else {
      evidence = [ev(forwards[0])];
      explanation = `Вопрос передан на проверку ${ref(forwards[0])}, но клиенту не сказано, как и когда он получит ответ.`;
    }
    recommendation = 'Закрывайте и уточняющие вопросы клиента; при передаче вопроса сообщайте, где и когда придёт ответ.';
  } else {
    share = 1;
    const key = substantive.find((m) => opFlags.get(m.id).concrete || opFlags.get(m.id).forward) || substantive[0];
    evidence = compact([ev(key), confirmations.length ? ev(confirmations[confirmations.length - 1], 'context') : null]);
    explanation = `Вопросы клиента получили ответ по существу${forwards.length ? ' или корректный следующий шаг' : ''}: ${ref(key)}${confirmations.length ? `; клиент подтвердил: ${ref(confirmations[confirmations.length - 1])}` : ''}.`;
  }
  return {
    status: 'scored', share, situation: share >= 1 ? 'met' : share <= 0 ? 'not_met' : 'partial',
    confidence: confidence(ctx, 0.62), evidence, evidence_type: share >= 1 ? 'supporting_messages' : 'supporting_messages',
    explanation: explanation + note, recommendation, needs_human_review: share < 1,
  };
}

// 05 — politeness and client orientation.
export function empathy(ctx, criterion) {
  const { ops, opFlags, clients, clientFlags, msgs } = ctx;
  if (!ctx.firstOp) return noOperator(ctx, criterion);
  const insult = ops.find((m) => opFlags.get(m.id).insult);
  if (insult) {
    return {
      status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.95), evidence: [ev(insult)], evidence_type: 'supporting_messages',
      explanation: `Оператор допустил грубость в адрес клиента: ${ref(insult)}.`,
      recommendation: 'Сохраняйте уважительный тон в любой ситуации; не комментируйте способности клиента.',
      critical_flag: true,
    };
  }
  const rude = ops.find((m) => opFlags.get(m.id).dismissive || (m.index === ctx.firstOp.index && opFlags.get(m.id).informal && !opFlags.get(m.id).greeting));
  if (rude) {
    return {
      status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.75), evidence: [ev(rude)], evidence_type: 'supporting_messages',
      explanation: `Пренебрежительная или фамильярная реплика оператора: ${ref(rude)}.`,
      recommendation: 'Избегайте фамильярности и реплик вроде «тогда не знаю» — объясните, что можно сделать.',
    };
  }
  // Dissatisfaction / inconvenience expressed by the client → did the operator react to the specific problem?
  for (const c of clients) {
    const cf = clientFlags.get(c.id);
    if (!cf?.dissatisfied) continue;
    // Chats: the immediate operator reply must react; calls: any later reaction counts (speech is interleaved).
    const later = ops.filter((m) => m.index > c.index);
    const replies = c.index < ctx.opStart ? [ctx.firstOp] : ctx.isCall ? later : later.slice(0, 1);
    const ok = replies.some((m) => {
      const f = opFlags.get(m.id);
      return !f.violation && !f.idDismissal && !f.farewellOnly && (f.empathy || f.apologyWait || ((f.concrete || f.forward) && c.index >= ctx.opStart));
    });
    if (!ok) {
      return {
        status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.72), evidence: compact([ev(c, 'context'), replies[0] ? ev(replies[0]) : null]),
        evidence_type: 'supporting_messages',
        explanation: `Клиент выразил недовольство или беспокойство ${ref(c)}, но оператор не отреагировал на конкретную проблему${replies[0] ? `: ${ref(replies[0])}` : ''}.`,
        recommendation: 'Признайте проблему клиента и ответьте на неё по существу («Понимаю, что …; сейчас …»).',
      };
    }
  }
  const politeCount = ops.filter((m) => opFlags.get(m.id).polite || opFlags.get(m.id).greeting || opFlags.get(m.id).empathy).length;
  if (politeCount === 0) {
    return {
      status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.55), needs_human_review: true,
      evidence: compact([ev(ctx.firstOp), ev(ctx.lastOp)]), evidence_type: 'checked_range', range: rangeOf(ctx.firstOp, ctx.lastOp),
      explanation: 'В репликах оператора нет ни приветствия, ни формул вежливости (пожалуйста/спасибо/извините).',
      recommendation: 'Используйте базовые формулы вежливости.',
    };
  }
  const empathic = ops.find((m) => opFlags.get(m.id).empathy);
  return {
    status: 'scored', situation: 'met', confidence: confidence(ctx, 0.75), evidence: compact([ev(empathic || ops.find((m) => opFlags.get(m.id).polite) || ctx.firstOp)]),
    evidence_type: 'supporting_messages',
    explanation: empathic
      ? `Оператор вежлив и отреагировал на переживания клиента: ${ref(empathic)}.`
      : 'Оператор вежлив; грубости, пренебрежения и проигнорированного недовольства клиента не выявлено.',
  };
  void msgs;
}

// 06 — dialog management, speed and literacy (official scale 0/4/7/10).
export function dialog_management(ctx, criterion, params = {}) {
  const { ops, opFlags, clientLive, clientFlags, msgs, conv } = ctx;
  if (!ctx.firstOp) return noOperator(ctx, criterion);
  // single source of truth: the checklist-level parameter (editable in the UI); a detector-level value
  // is only a fallback for imported checklists that do not define it
  const threshold = Number(ctx.params.first_response_threshold_sec ?? params.first_response_sec ?? 180);
  const silentLimit = Number(params.silent_wait_sec ?? threshold);
  const glitches = [];
  const reasks = [];

  // First reaction after the hand-off (chats).
  if (!ctx.isCall && conv.stats.first_response_sec !== null && conv.stats.first_response_sec > threshold) {
    const f = opFlags.get(ctx.firstOp.id);
    if (!f.apologyWait) glitches.push({ m: ctx.firstOp, text: `первая реакция через ${Math.round(conv.stats.first_response_sec)} с (порог ${threshold} с) без извинения за ожидание` });
  }
  // Long silence after a client message without a prior warning.
  for (const c of clientLive) {
    const reply = ctx.replyBlock(c)[0];
    if (!reply || !Number.isFinite(reply.t) || !Number.isFinite(c.t)) continue;
    const gap = reply.t - c.t;
    if (gap <= silentLimit) continue;
    const prevOp = [...ops].reverse().find((m) => m.index < c.index);
    const warned = (prevOp && opFlags.get(prevOp.id).waitWarning) || opFlags.get(reply.id).apologyWait;
    if (!warned) glitches.push({ m: reply, text: `ответ через ${Math.round(gap)} с без предупреждения об ожидании` });
  }
  // Hold in calls without a warning.
  for (const [a] of conv.events.hold_ranges) {
    const before = [...ops].reverse().find((m) => m.index < a);
    if (before && !opFlags.get(before.id).waitWarning) glitches.push({ m: msgs[a], text: 'клиент поставлен на удержание без предупреждения' });
  }
  for (const c of clientLive) {
    const cf = clientFlags.get(c.id);
    const prevOp = [...ops].reverse().find((m) => m.index < c.index);
    if (!prevOp) continue;
    if (cf.confusion) reasks.push({ m: c, op: prevOp, text: `клиенту пришлось переспросить ${ref(c)} после ${ref(prevOp)}` });
    else if (cf.alreadySaid) glitches.push({ m: c, text: `клиенту пришлось повторить уже сказанное ${ref(c)}` });
    else if (cf.correction) glitches.push({ m: c, text: `клиент поправил оператора ${ref(c)}` });
  }
  const confirmedAfter = (q) => clientLive.some((m) => m.index > q.index && clientFlags.get(m.id)?.resolved);
  const unanswered = clientLive.filter((m) => clientFlags.get(m.id)?.question)
    .map((q) => ({ q, ...analyzeQuestion(ctx, q) }))
    .filter((a) => !a.addressed && !confirmedAfter(a.q));
  for (const u of unanswered) {
    if (!glitches.some((g) => g.m.id === u.q.id) && !reasks.some((r) => r.m.id === u.q.id)) {
      glitches.push({ m: u.replies[0] || u.q, text: `ответ не на заданный вопрос ${ref(u.q)}` });
    }
  }
  for (const m of ops) {
    if (opFlags.get(m.id).vague && !glitches.some((g) => g.m.id === m.id) && !reasks.some((r) => r.op.id === m.id)) {
      glitches.push({ m, text: `расплывчатая инструкция ${ref(m)}` });
    }
  }

  let share;
  if (reasks.length || glitches.length >= 2) share = 0.4;
  else if (glitches.length === 1) share = 0.7;
  else share = 1;
  const items = [...reasks, ...glitches];
  const evidence = compact(items.slice(0, 4).map((x) => ev(x.m, x.m.speaker === 'client' ? 'context' : 'supporting')));
  const asrNote = ctx.isCall ? ' Звонок: ошибки распознавания речи не считаются сбоями оператора; оценка требует проверки по записи.' : '';
  return {
    status: 'scored', share, situation: share >= 1 ? 'met' : 'partial',
    confidence: ctx.isCall ? 0.45 : 0.68, needs_human_review: ctx.isCall || share < 1,
    evidence: evidence.length ? evidence : compact([ev(ctx.firstOp), ev(ctx.lastOp)]),
    evidence_type: evidence.length ? 'supporting_messages' : 'checked_range',
    range: evidence.length ? null : rangeOf(ctx.firstOp, ctx.lastOp),
    explanation: (items.length
      ? `Сбои ведения диалога: ${items.map((x) => x.text).join('; ')}.`
      : `Ответы последовательные: переспрашиваний из-за формулировок, ответов не по порядку и ожидания без предупреждения не выявлено; первая реакция ${conv.stats.first_response_sec !== null ? `через ${Math.round(conv.stats.first_response_sec)} с` : '—'} (порог ${threshold} с).`)
      + ' Бессвязность (оценка 0) и грамотность офлайн-правилами не определяются.' + asrNote,
    recommendation: items.length ? 'Давайте точные инструкции с первого раза, отвечайте на вопросы по порядку и предупреждайте об ожидании.' : '',
  };
}

// 07 — closing.
export function closing(ctx, criterion) {
  const { ops, opFlags, msgs, events, clientFlags } = ctx;
  if (!ctx.firstOp) return noOperator(ctx, criterion);
  const last = ctx.lastOp;
  const tail = ops.slice(-2);
  const fareMsg = [...tail].reverse().find((m) => opFlags.get(m.id).farewell || opFlags.get(m.id).closingFormula);
  const endIdx = events.end;
  const endMsg = endIdx !== null ? msgs[endIdx] : null;
  const clientEnded = events.client_left !== null && (events.operator_closed === null || events.client_left < events.operator_closed);

  if (fareMsg) {
    const f = opFlags.get(fareMsg.id);
    const prevClient = [...msgs].reverse().find((m) => m.index < fareMsg.index && m.speaker === 'client');
    const ackOfResolution = f.courtesy && prevClient && clientFlags.get(prevClient.id)?.resolved;
    // Content beyond the farewell/courtesy formula in the final message counts as a short summary.
    const rest = normalizeForMatch(fareMsg.text)
      .replace(LEX.farewell, ' ').replace(LEX.courtesyAck, ' ').replace(LEX.closingFormula, ' ');
    const contentWords = words(rest).filter((w) => w.length > 2);
    const contentSummary = contentWords.length >= 4 && !f.vague && !f.dismissive && !LEX.vague.test(rest);
    const summaryOrOffer = f.offerHelp || f.summary || f.closingFormula || ackOfResolution || contentSummary
      || (f.concrete && !f.farewellOnly) || tail.some((m) => m.id !== fareMsg.id && (opFlags.get(m.id).summary || opFlags.get(m.id).offerHelp));
    if (summaryOrOffer) {
      return {
        status: 'scored', situation: 'met', confidence: confidence(ctx, ackOfResolution && !f.offerHelp && !f.summary ? 0.7 : 0.85),
        evidence: [ev(fareMsg)], evidence_type: 'supporting_messages',
        explanation: `Оператор ${f.offerHelp ? 'предложил дальнейшую помощь' : ackOfResolution ? 'подтвердил результат в ответ на благодарность клиента' : 'подвёл итог'} и попрощался: ${ref(fareMsg)}.`,
      };
    }
    return {
      status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.7), needs_human_review: true,
      evidence: [ev(fareMsg)], evidence_type: 'supporting_messages',
      explanation: `Оператор только попрощался ${ref(fareMsg)} — без итога и без предложения дальнейшей помощи.`,
      recommendation: 'Перед прощанием кратко подведите итог или предложите помощь: «Если появятся вопросы — пишите».',
    };
  }
  if (events.operator_closed !== null && !clientEnded) {
    return {
      status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.9),
      evidence: compact([ev(last), ev(msgs[events.operator_closed], 'context')]), evidence_type: 'supporting_messages',
      explanation: `Оператор закрыл чат без прощания. Основание — последняя реплика оператора ${ref(last)} и сообщение о закрытии чата ${ref(msgs[events.operator_closed])}.`,
      recommendation: 'Не закрывайте чат без итога и прощания.',
    };
  }
  if (clientEnded && endMsg) {
    return {
      status: 'na', confidence: confidence(ctx, 0.8), evidence: compact([ev(last), ev(endMsg, 'context')]), evidence_type: 'supporting_messages',
      na_reason: 'Чат оборвался до возможности его завершить.',
      explanation: `Диалог прервался со стороны клиента ${ref(endMsg)} до прощания оператора.`,
    };
  }
  const lastMsg = [...msgs].reverse().find((m) => m.speaker === 'client' || m.speaker === 'operator');
  return {
    status: 'scored', situation: 'not_met', confidence: confidence(ctx, 0.8),
    evidence: compact([ev(last), lastMsg && lastMsg.id !== last?.id ? ev(lastMsg, 'context') : null]),
    evidence_type: 'checked_range', range: rangeOf(last, msgs[msgs.length - 1]),
    explanation: `Диалог не завершён оператором: последняя реплика оператора ${ref(last)} не содержит прощания${lastMsg && lastMsg.speaker === 'client' ? `, последнее сообщение — от клиента ${ref(lastMsg)}` : ''}.`,
    recommendation: 'Завершайте диалог итогом и прощанием.',
  };
}

// 08 — gross errors (flag, no points).
export function gross_errors(ctx, criterion) {
  const { ops, opFlags, idIndex } = ctx;
  const found = [];
  const insult = ops.filter((m) => opFlags.get(m.id).insult);
  if (insult.length) found.push({ subtype: 'insult', messages: insult, text: `оскорбление клиента ${ref(insult[0])}` });
  const bypass = ops.filter((m) => {
    const f = opFlags.get(m.id);
    return f.transfer || f.bypass || (f.personalContact && (f.paid || f.private));
  });
  if (bypass.length) found.push({ subtype: 'bypass_service', messages: bypass, text: `предложение услуги в обход компании ${ref(bypass[0])}` });
  const disclosure = ops.filter((m) => opFlags.get(m.id).disclosure && (idIndex === null || m.index < idIndex));
  if (disclosure.length) found.push({ subtype: 'confidential_disclosure', messages: disclosure, text: `раскрытие сведений о счёте без подтверждения личности ${ref(disclosure[0])}` });

  const allowed = new Set((criterion.flag_subtypes || []).map((s) => s.id));
  const relevant = allowed.size ? found.filter((x) => allowed.has(x.subtype)) : found;
  if (relevant.length) {
    return {
      status: 'scored', answer: 'yes', situation: 'not_met', confidence: confidence(ctx, 0.85), critical_flag: true, needs_human_review: true,
      evidence: relevant.flatMap((x) => x.messages.slice(0, 2).map((m) => ev(m))), evidence_type: 'supporting_messages',
      flag_subtypes: relevant.map((x) => ({ id: x.subtype, evidence: x.messages.map((m) => m.id) })),
      explanation: `Выявлено: ${relevant.map((x) => x.text).join('; ')}. Грубая ошибка отмечается отдельно и не меняет балл.`,
      recommendation: 'Случай передан на приоритетную ручную проверку.',
    };
  }
  return {
    status: 'scored', answer: 'no', situation: 'met', confidence: confidence(ctx, 0.75),
    evidence: compact([ev(ctx.firstOp), ev(ctx.lastOp)]), evidence_type: 'checked_range', range: ctx.firstOp ? rangeOf(ctx.firstOp, ctx.lastOp) : null,
    explanation: 'Во всех репликах оператора не выявлено оскорблений, предложений платной услуги в обход компании и раскрытия конфиденциальной информации.',
  };
}

// ---- Custom detectors (for criteria added through the UI) ----

function compilePhrases(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 60)) {
    if (line.length > 200) continue;
    const m = /^\/(.+)\/([iu]*)$/.exec(line);
    if (m) {
      try { out.push({ label: line, re: new RegExp(m[1], 'iu') }); } catch { /* invalid regex is ignored and reported */ }
    } else {
      out.push({ label: line, re: new RegExp(line.toLowerCase().replace(/ё/g, 'е').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u') });
    }
  }
  return out;
}

export function keyword_presence(ctx, criterion, params = {}) {
  if (!ctx.firstOp) return noOperator(ctx, criterion);
  const phrases = compilePhrases(params.phrases);
  if (!phrases.length) {
    return { status: 'not_evaluated', confidence: 0, needs_human_review: true, evidence: [], evidence_type: 'none', explanation: 'Для детектора не заданы фразы.' };
  }
  let pool = ctx.ops;
  if (params.position === 'first') pool = ctx.ops.slice(0, 1);
  if (params.position === 'last') pool = ctx.ops.slice(-2);
  const hits = pool.filter((m) => phrases.some((p) => p.re.test(normalizeForMatch(m.text))));
  if (hits.length) {
    return {
      status: 'scored', situation: 'met', confidence: 0.85, evidence: hits.slice(0, 3).map((m) => ev(m)), evidence_type: 'supporting_messages',
      explanation: `Найдена обязательная фраза в репликах оператора: ${ref(hits[0])}.`,
    };
  }
  return {
    status: 'scored', situation: 'not_met', confidence: 0.8, evidence: compact([ev(pool[0]), ev(pool[pool.length - 1])]), evidence_type: 'checked_range',
    range: rangeOf(pool[0], pool[pool.length - 1]),
    explanation: `Ни одна из фраз (${phrases.map((p) => `«${p.label}»`).join(', ')}) не найдена в проверенных репликах оператора.`,
    recommendation: 'Используйте обязательную формулировку из стандарта.',
  };
}

export function keyword_absence(ctx, criterion, params = {}) {
  if (!ctx.firstOp) return noOperator(ctx, criterion);
  const phrases = compilePhrases(params.phrases);
  if (!phrases.length) {
    return { status: 'not_evaluated', confidence: 0, needs_human_review: true, evidence: [], evidence_type: 'none', explanation: 'Для детектора не заданы фразы.' };
  }
  const hits = ctx.ops.filter((m) => phrases.some((p) => p.re.test(normalizeForMatch(m.text))));
  if (hits.length) {
    return {
      status: 'scored', situation: 'not_met', confidence: 0.85, evidence: hits.slice(0, 3).map((m) => ev(m)), evidence_type: 'supporting_messages',
      explanation: `Оператор использовал запрещённую формулировку: ${ref(hits[0])}.`,
      recommendation: 'Избегайте запрещённых формулировок.',
    };
  }
  return {
    status: 'scored', situation: 'met', confidence: 0.8, evidence: compact([ev(ctx.firstOp), ev(ctx.lastOp)]), evidence_type: 'checked_range',
    range: rangeOf(ctx.firstOp, ctx.lastOp), explanation: 'Запрещённые формулировки в репликах оператора не найдены.',
  };
}

export function response_time(ctx, criterion, params = {}) {
  if (!ctx.firstOp) return noOperator(ctx, criterion);
  if (ctx.isCall) {
    return {
      status: criterion.na_allowed ? 'na' : 'not_evaluated', na_reason: 'В звонке скорость ответа по временным меткам транскрипта не оценивается.',
      confidence: 0.8, evidence: [], evidence_type: 'none', explanation: 'Звонок: паузы в речи не отражают время реакции оператора.',
    };
  }
  const first = Number(params.first_response_sec ?? 180);
  const gapLimit = Number(params.reply_gap_sec ?? 180);
  const issues = [];
  const fr = ctx.conv.stats.first_response_sec;
  if (fr !== null && fr > first) issues.push({ m: ctx.firstOp, text: `первая реакция через ${Math.round(fr)} с (норма ≤ ${first} с)` });
  for (const c of ctx.clientLive) {
    const r = ctx.replyBlock(c)[0];
    if (r && Number.isFinite(r.t) && Number.isFinite(c.t) && r.t - c.t > gapLimit) issues.push({ m: r, text: `ответ на ${ref(c)} через ${Math.round(r.t - c.t)} с (норма ≤ ${gapLimit} с)` });
  }
  if (!issues.length) {
    return {
      status: 'scored', situation: 'met', confidence: 0.9, evidence: [ev(ctx.firstOp)], evidence_type: 'supporting_messages',
      explanation: `Первая реакция ${fr !== null ? `через ${Math.round(fr)} с` : '—'}, все ответы в пределах ${gapLimit} с.`,
    };
  }
  return {
    status: 'scored', situation: issues.length > 1 ? 'not_met' : 'partial', share: issues.length > 1 ? 0 : 0.5, confidence: 0.9,
    evidence: issues.slice(0, 3).map((x) => ev(x.m)), evidence_type: 'supporting_messages',
    explanation: `Превышено время реакции: ${issues.map((x) => x.text).join('; ')}.`,
    recommendation: 'Отвечайте в пределах нормы или предупреждайте об ожидании.',
  };
}

export const DETECTOR_FUNCTIONS = {
  contact_greeting, need_discovery, identification, consultation_completeness, empathy, dialog_management, closing, gross_errors,
  keyword_presence, keyword_absence, response_time,
};

// Helper exported for tests.
export const _internals = { NAME_PATTERNS, words };
