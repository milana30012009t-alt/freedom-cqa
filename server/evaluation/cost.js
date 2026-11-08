// Token and cost estimation (before a batch) and actual cost (from API usage).
import { buildPrompt, SYSTEM_PROMPT } from './prompt.js';
import { AI_OUTPUT_SCHEMA } from './output-schema.js';

/** Rough token estimate: Cyrillic text is denser in tokens than Latin text. */
export function estimateTokens(text) {
  const s = String(text || '');
  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length;
  const other = s.length - cyr;
  return Math.ceil(cyr / 2.6 + other / 3.8);
}

export function costUsd(usage, pricing) {
  const inTok = (usage.input_tokens || 0);
  const out = (usage.output_tokens || 0);
  const cr = usage.cache_read_tokens || 0;
  const cw = usage.cache_write_tokens || 0;
  return (inTok * pricing.inputPerMTok + out * pricing.outputPerMTok + cr * pricing.cacheReadPerMTok + cw * pricing.cacheWritePerMTok) / 1e6;
}

/**
 * Estimate the cost of evaluating conversations with the current checklist.
 * Output ≈ 230 tokens per criterion + 400 (summary, findings) + adaptive thinking allowance.
 */
export function estimateBatch(conversations, checklist, pricing, { promptCaching = true } = {}) {
  const criteria = checklist.criteria.filter((c) => c.enabled);
  const perConversation = conversations.map((conv) => {
    const p = buildPrompt(conv, checklist, criteria, { preScreening: [] });
    const staticTokens = estimateTokens(p.system) + estimateTokens(p.checklistBlock) + estimateTokens(JSON.stringify(AI_OUTPUT_SCHEMA));
    const convTokens = estimateTokens(p.conversationBlock);
    const outTokens = criteria.length * 230 + 400 + pricing.estThinkingTokens;
    return { uid: conv.uid, staticTokens, convTokens, outTokens };
  });
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  perConversation.forEach((x, i) => {
    usage.input_tokens += x.convTokens;
    usage.output_tokens += x.outTokens;
    if (!promptCaching) usage.input_tokens += x.staticTokens;
    else if (i === 0) usage.cache_write_tokens += x.staticTokens;
    else usage.cache_read_tokens += x.staticTokens;
  });
  const total = costUsd(usage, pricing);
  const n = perConversation.length || 1;
  const output = usage.output_tokens;
  return {
    conversations: perConversation.length,
    calls_per_evaluation: '1 (+1 повтор при невалидном ответе)',
    tokens: usage,
    avg_input_tokens: Math.round((perConversation.reduce((s, x) => s + x.staticTokens + x.convTokens, 0)) / n),
    avg_output_tokens: Math.round(output / n),
    total_usd: Number(total.toFixed(4)),
    per_evaluation_usd: Number((total / n).toFixed(5)),
    pricing,
    system_prompt_tokens: estimateTokens(SYSTEM_PROMPT),
  };
}
