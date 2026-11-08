// Anthropic Messages API provider (Claude). Uses structured outputs (output_config.format with
// a JSON schema) so the response is schema-valid JSON; falls back to "JSON in text" mode if the
// endpoint rejects the parameter. No sampling parameters or forced tool choice are sent: current
// Claude 5.5 models reject them.
import { fetchWithRetry, UpstreamError } from '../../lib/http-client.js';
import { parseModelJson, AiOutputError } from '../output-schema.js';
import { logger } from '../../lib/logger.js';

export class AnthropicProvider {
  constructor(cfg, { fetchImpl } = {}) {
    this.cfg = cfg.ai.anthropic;
    this.common = cfg.ai;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.useEffort = Boolean(this.cfg.effort);
    this.structured = this.cfg.structuredOutput !== 'prompt';
  }

  get info() {
    return { id: 'anthropic', model: this.cfg.model, label: `Claude · ${this.cfg.model}` };
  }

  buildBody({ system, checklistBlock, conversationBlock, schema, repairNote }) {
    const cache = this.cfg.promptCaching ? { cache_control: { type: 'ephemeral' } } : {};
    const tail = this.structured ? '' : `\n\nВерни ТОЛЬКО JSON-объект, соответствующий этой JSON-схеме (без пояснений и без markdown):\n${JSON.stringify(schema)}`;
    const content = [
      { type: 'text', text: checklistBlock, ...cache },
      { type: 'text', text: `${conversationBlock}${tail}${repairNote ? `\n\nВАЖНО: ${repairNote}` : ''}` },
    ];
    const body = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      system: [{ type: 'text', text: system, ...cache }],
      messages: [{ role: 'user', content }],
    };
    const outputConfig = {};
    if (this.structured) outputConfig.format = { type: 'json_schema', schema };
    if (this.useEffort && this.cfg.effort) outputConfig.effort = this.cfg.effort;
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    return body;
  }

  async call(body) {
    const res = await fetchWithRetry(`${this.cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      timeoutMs: this.common.timeoutMs,
      retries: this.common.maxRetries,
      label: `Anthropic ${this.cfg.model}`,
      fetchImpl: this.fetchImpl,
    });
    return res.json();
  }

  /**
   * @returns {Promise<{output:object, usage:object, stopReason:string, rawText:string}>}
   */
  async evaluate(prompt) {
    if (!this.cfg.apiKey) throw new UpstreamError('ANTHROPIC_API_KEY не задан', { code: 'NO_KEY' });
    let data;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        data = await this.call(this.buildBody(prompt));
        break;
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        if (e.status === 401 || e.status === 403) throw new UpstreamError('Anthropic API отклонил ключ (401/403). Проверьте ANTHROPIC_API_KEY.', { status: e.status, code: 'AUTH' });
        const body = String(e.body || '').toLowerCase();
        if (e.status === 400 && this.useEffort && body.includes('effort')) {
          logger.warn('Модель не принимает output_config.effort — повтор без него');
          this.useEffort = false;
          continue;
        }
        if (e.status === 400 && this.structured && (body.includes('output_config') || body.includes('format') || body.includes('schema'))) {
          logger.warn('Модель не приняла структурированный вывод — повтор в режиме JSON в тексте');
          this.structured = false;
          continue;
        }
        throw e;
      }
    }
    if (!data) throw new UpstreamError('Anthropic API: нет ответа');
    const stopReason = data.stop_reason;
    if (stopReason === 'refusal') throw new AiOutputError('Модель отказалась отвечать (stop_reason = refusal)');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (stopReason === 'max_tokens') throw new AiOutputError('Ответ модели обрезан по max_tokens — увеличьте ANTHROPIC_MAX_TOKENS');
    const output = parseModelJson(text);
    const u = data.usage || {};
    return {
      output,
      rawText: text,
      stopReason,
      usage: {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_tokens: u.cache_read_input_tokens || 0,
        cache_write_tokens: u.cache_creation_input_tokens || 0,
      },
    };
  }
}
