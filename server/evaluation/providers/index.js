// AI service layer: the UI and the evaluation pipeline depend only on this factory, so the
// model can be swapped (Claude / OpenAI-compatible / local) without touching the interface.
import { resolveProvider } from '../../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/** Scriptable provider for tests and demos without network: `respond(prompt, attempt)`. */
export class MockProvider {
  constructor(respond, info = {}) {
    this.respond = respond;
    this.calls = 0;
    this._info = { id: 'mock', model: 'mock-model', label: 'Тестовый провайдер', ...info };
  }

  get info() {
    return this._info;
  }

  async evaluate(prompt) {
    this.calls += 1;
    const out = await this.respond(prompt, this.calls);
    if (out instanceof Error) throw out;
    return { output: out, rawText: JSON.stringify(out), stopReason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 } };
  }
}

export function createProvider(cfg, { fetchImpl, override } = {}) {
  if (override) return override;
  const id = resolveProvider(cfg);
  if (id === 'anthropic') return new AnthropicProvider(cfg, { fetchImpl });
  if (id === 'openai') return new OpenAICompatibleProvider(cfg, { fetchImpl });
  return null; // offline rules engine
}
