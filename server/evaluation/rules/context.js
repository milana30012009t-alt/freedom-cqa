// Conversation analysis shared by the offline detectors.
// Only operator messages addressed to the client are attributed to the operator; client, bot
// and system messages are context (what the client already said, handoff, identification...).
import { LEX, normalizeForMatch, contentStems, test } from './lexicon.js';

export function words(text) {
  return normalizeForMatch(text).split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
}

export function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?…])\s+/u).map((s) => s.trim()).filter(Boolean);
}

export function shortQuote(text, max = 110) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${cut.slice(0, sp > 60 ? sp : max)}…`;
}

export function ref(m) {
  return m ? `«${shortQuote(m.text, 90)}» (${m.t_label})` : '';
}

function hasDomainTopic(s) {
  return test(LEX.domainTopic, s);
}

function isOperatorRequestSentence(s) {
  return test(LEX.operatorRequest, s) && !hasDomainTopic(s);
}

function isConfirmation(s) {
  return LEX.confirmationOnly.test(normalizeForMatch(s));
}

const LEADING_INTERROGATIVE = /^(?:а |и |так |ну )?(?:как|где|куда|когда|почему|зачем|сколько|какой|какая|какое|какие|каким|что делать|можно ли|нужно ли|надо ли|қалай|қайда|қайдан|қашан|неге|қандай|қай|how|where|when|why|what|which|can|could|do|does|is|are|will|should)(?![\p{L}])/u;
const INSISTENCE = /(?:я спрашива|я же спрашива|i'm asking|i asked|сұрап тұрмын)/u;

export function isQuestion(text) {
  const n = normalizeForMatch(text);
  if (n.includes('?') || INSISTENCE.test(n)) return true;
  return splitSentences(n).some((s) => LEADING_INTERROGATIVE.test(s));
}

/**
 * Build the analysis context once per conversation.
 */
export function buildContext(conv, checklist = { parameters: {} }) {
  const msgs = conv.messages;
  const isCall = conv.channel_type === 'call';
  const clientFacing = (m) => m.segment !== 'hold' && m.segment !== 'after_end';
  const ops = msgs.filter((m) => m.speaker === 'operator' && clientFacing(m) && m.text.trim());
  const firstOp = ops[0] || null;
  const opStart = firstOp ? firstOp.index : Number.POSITIVE_INFINITY;
  const clients = msgs.filter((m) => m.speaker === 'client' && m.segment !== 'after_end' && !m.flags.includes('dtmf') && m.text.trim());
  const clientPre = clients.filter((m) => m.index < opStart);
  const clientLive = clients.filter((m) => m.index > opStart);

  // Substantive request sentences written before the operator joined (to bot / in queue).
  const issueSentences = [];
  const issueMessages = [];
  for (const m of clientPre) {
    if (m.flags.includes('masked_pii')) continue;
    // In calls, utterances before the operator joins are IVR navigation, so only topical ones count.
    const sentences = splitSentences(m.text).filter((s) => !isOperatorRequestSentence(s) && !isConfirmation(s)
      && (isCall ? hasDomainTopic(s) : (hasDomainTopic(s) || (words(s).length >= 2 && s.includes('?')))));
    if (sentences.length) {
      issueSentences.push(...sentences);
      issueMessages.push(m);
    }
  }
  const issueText = issueSentences.join(' ');
  const issueStems = contentStems(issueText);

  // Operator reply block for a client message: consecutive operator messages after it.
  const replyBlock = (clientMsg) => {
    const after = msgs.filter((m) => m.index > clientMsg.index && m.segment !== 'after_end');
    const firstOpIdx = after.findIndex((m) => m.speaker === 'operator' && clientFacing(m));
    if (firstOpIdx < 0) return [];
    const block = [];
    for (let i = firstOpIdx; i < after.length; i += 1) {
      const m = after[i];
      if (m.speaker === 'client' && !m.flags.includes('dtmf')) break;
      if (m.speaker === 'operator' && clientFacing(m)) block.push(m);
    }
    return block;
  };

  const opFlags = new Map();
  for (const m of ops) {
    const n = normalizeForMatch(m.text);
    const wordCount = words(m.text).length;
    const f = {
      greeting: Object.values(LEX.greetingFormal).some((re) => re.test(n)),
      informal: LEX.greetingInformal.test(n),
      farewell: LEX.farewell.test(n),
      closingFormula: LEX.closingFormula.test(n),
      dismissive: LEX.dismissive.test(n),
      vague: LEX.vague.test(n) && !LEX.concrete.test(m.text.toLowerCase()),
      concrete: LEX.concrete.test(m.text.toLowerCase()),
      generic: LEX.genericHelp.test(n),
      forward: LEX.forward.test(n),
      followUp: LEX.followUpCommit.test(n),
      nextAction: LEX.clientNextAction.test(n),
      question: n.includes('?'),
      insult: LEX.insult.test(n),
      transfer: LEX.personalTransfer.test(n),
      bypass: LEX.bypassExplicit.test(n),
      personalContact: LEX.personalContactRequest.test(n),
      paid: LEX.paidService.test(n),
      private: LEX.privateService.test(n),
      profit: LEX.profitPromise.test(n),
      disclosure: LEX.accountDisclosure.test(n) && !LEX.idRequired.test(n),
      idRequired: LEX.idRequired.test(n),
      idConfirmed: LEX.idConfirmedByOperator.test(n),
      idDismissal: LEX.idDismissal.test(n),
      otp: LEX.otpRequest.test(n),
      otpLegit: LEX.otpLegitContext.test(n),
      empathy: LEX.empathy.test(n),
      polite: LEX.polite.test(n),
      apologyWait: LEX.apologyForWait.test(n),
      waitWarning: LEX.waitWarning.test(n),
      offerHelp: LEX.offerHelp.test(n),
      summary: LEX.summary.test(n),
      courtesy: LEX.courtesyAck.test(n),
      wordCount,
    };
    f.violation = f.insult || f.transfer || f.bypass || (f.personalContact && (f.paid || f.private));
    f.farewellOnly = f.farewell && wordCount <= 5 && !f.concrete && !f.forward;
    f.substantive = !f.violation && !f.dismissive && !(f.generic && wordCount <= 12) && !f.farewellOnly
      && (f.concrete || f.forward || f.question || wordCount >= 5 || LEX.yesNoAnswer.test(n));
    opFlags.set(m.id, f);
  }
  const clientFlags = new Map();
  for (const m of clients) {
    const n = normalizeForMatch(m.text);
    clientFlags.set(m.id, {
      alreadySaid: LEX.clientAlreadySaid.test(n),
      correction: LEX.clientCorrection.test(n),
      contextCorrection: LEX.clientContextCorrection.test(n),
      confusion: LEX.clientConfusion.test(n),
      dissatisfied: LEX.clientDissatisfied.test(n),
      resolved: LEX.clientResolved.test(n),
      asksFollowUp: LEX.clientAsksFollowUp.test(n),
      accountRequest: LEX.clientAccountRequest.test(n),
      question: isQuestion(m.text) && !splitSentences(m.text).every((s) => isOperatorRequestSentence(s) || !isQuestion(s)),
    });
  }

  // Identification moment: system event or explicit confirmation by the operator after a request for ID data.
  let idIndex = conv.events.identity_verified ?? null;
  if (idIndex === null) {
    const firstIdReq = ops.find((m) => opFlags.get(m.id).idRequired);
    if (firstIdReq) {
      const confirm = ops.find((m) => m.index >= firstIdReq.index && opFlags.get(m.id).idConfirmed);
      if (confirm) idIndex = confirm.index;
    }
  }

  const params = checklist.parameters || {};
  return {
    conv, msgs, isCall, ops, firstOp, opStart, clients, clientPre, clientLive,
    issueText, issueStems, issueMessages, issueStated: issueSentences.length > 0,
    opFlags, clientFlags, replyBlock, idIndex, params,
    events: conv.events,
    lastOp: ops[ops.length - 1] || null,
    msgById: new Map(msgs.map((m) => [m.id, m])),
  };
}

/**
 * Was a client question addressed by the operator's next reply block?
 * @returns {{addressed:boolean, reason:string, replies:Array}}
 */
export function analyzeQuestion(ctx, q) {
  const replies = ctx.replyBlock(q);
  if (!replies.length) return { addressed: false, reason: 'no_reply', replies };
  const flags = replies.map((m) => ctx.opFlags.get(m.id));
  if (flags.every((f) => f.dismissive || f.farewellOnly || (f.generic && f.wordCount <= 12) || f.violation)) {
    return { addressed: false, reason: flags.some((f) => f.dismissive) ? 'dismissive' : flags.some((f) => f.violation) ? 'violation' : 'farewell_only', replies };
  }
  const qStems = contentStems(q.text);
  const rStems = new Set(replies.flatMap((m) => [...contentStems(m.text)]));
  const overlap = [...qStems].filter((s) => rStems.has(s));
  const yesNo = replies.some((m) => LEX.yesNoAnswer.test(words(m.text).slice(0, 4).join(' ')));
  if (overlap.length || yesNo || flags.some((f) => f.forward || f.question)) {
    return { addressed: true, reason: overlap.length ? 'topical' : yesNo ? 'yes_no' : flags.some((f) => f.forward) ? 'forward' : 'clarifying', replies, overlap };
  }
  if (flags.some((f) => f.concrete && !f.vague)) return { addressed: true, reason: 'concrete', replies };
  return { addressed: false, reason: 'off_topic', replies };
}
