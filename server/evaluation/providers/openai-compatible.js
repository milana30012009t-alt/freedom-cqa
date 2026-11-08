// OpenAI-compatible Chat Completions provider. Works with OpenAI and with local servers that
// expose the same API (Ollama: OPENAI_BASE_URL=http://localhost:11434/v1, LM Studio, vLLM).
import { fetchWithRetry, UpstreamError } from '../../lib/http-client.js';
import { parseModelJson } from '../output-schema.js';

export class OpenAICompatibleProvider {
  constructor(cfg, { fetchImpl } = {}) {
    this.cfg = cfg.ai.openai;
    this.common = cfg.ai;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  get info() {
    const local = !this.cfg.baseUrl.includes('api.openai.com');
    return { id: 'openai', model: this.cfg.model, label: `${local ? 'Локальная модель' : 'OpenAI'} · ${this.cfg.model}` };
  }

  async evaluate({ system, checklistBlock, conversationBlock, schema, repairNote }) {
    if (!this.cfg.model) throw new UpstreamError('OPENAI_MODEL не задан', { code: 'NO_MODEL' });
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `${checklistBlock}\n\n${conversationBlock}${this.cfg.responseFormat === 'json_schema' ? '' : `\n\nВерни ТОЛЬКО JSON по схеме:\n${JSON.stringify(schema)}`}${repairNote ? `\n\nВАЖНО: ${repairNote}` : ''}`,
        },
      ],
    };
    if (this.cfg.responseFormat === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'cqa_evaluation', strict: true, schema } };
    else if (this.cfg.responseFormat === 'json_object') body.response_format = { type: 'json_object' };
    const headers = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    let res;
    try {
      res = await fetchWithRetry(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), timeoutMs: this.common.timeoutMs, retries: this.common.maxRetries,
        label: `LLM ${this.cfg.model}`, fetchImpl: this.fetchImpl,
      });
    } catch (e) {
      if (e instanceof UpstreamError && (e.status === 401 || e.status === 403)) throw new UpstreamError('LLM API отклонил ключ (401/403)', { status: e.status, code: 'AUTH' });
      throw e;
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content || '';
    const output = parseModelJson(text);
    return {
      output,
      rawText: text,
      stopReason: choice?.finish_reason || null,
      usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    };
  }
}
