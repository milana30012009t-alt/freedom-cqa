// Runtime configuration. Everything that differs between machines or secrets lives in .env
// (git-ignored). Defaults make the app usable offline with no keys at all.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './lib/env.js';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function bool(v, d) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function int(v, d) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function float(v, d) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Build the configuration.
 * @param {object} overrides values that win over env (used by tests)
 */
export function loadConfig(overrides = {}) {
  const fileEnv = overrides.envFile === false ? {} : loadEnvFile(overrides.envFile || resolve(ROOT_DIR, '.env'));
  const env = { ...fileEnv, ...process.env, ...(overrides.env || {}) };

  const provider = (env.AI_PROVIDER || 'auto').toLowerCase();
  const cfg = {
    rootDir: ROOT_DIR,
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3000),
    dataDir: resolve(ROOT_DIR, env.DATA_DIR || 'data'),
    teamName: String(env.TEAM_NAME || '').trim(), // Results JSON 1.0: team_name
    publicDir: resolve(ROOT_DIR, 'public'),
    sharedDir: resolve(ROOT_DIR, 'shared'),
    checklistSeedFile: resolve(ROOT_DIR, env.CHECKLIST_SEED_FILE || 'checklists/freedom-official.v1.json'),
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    frameAncestors: env.FRAME_ANCESTORS || "'self' https://*.dynamics.com https://*.crm4.dynamics.com",
    dataset: {
      apiUrl: env.DATASET_API_URL || '',
      groupId: env.DATASET_GROUP_ID || 'DEV',
      autoload: bool(env.DATASET_AUTOLOAD, true),
      timeoutMs: int(env.DATASET_TIMEOUT_MS, 30000),
      retries: int(env.DATASET_RETRIES, 3),
    },
    ai: {
      provider, // auto | anthropic | openai | rules
      fallbackToRules: bool(env.AI_FALLBACK_TO_RULES, true),
      concurrency: Math.max(1, int(env.AI_CONCURRENCY, 3)),
      timeoutMs: int(env.AI_TIMEOUT_MS, 180000),
      maxRetries: int(env.AI_MAX_RETRIES, 2),
      outputLanguage: env.AI_OUTPUT_LANGUAGE || 'ru',
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY || '',
        baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        maxTokens: int(env.ANTHROPIC_MAX_TOKENS, 16000),
        effort: env.ANTHROPIC_EFFORT === undefined ? 'medium' : env.ANTHROPIC_EFFORT, // '' disables
        structuredOutput: (env.ANTHROPIC_STRUCTURED_OUTPUT || 'json_schema').toLowerCase(), // json_schema | prompt
        promptCaching: bool(env.ANTHROPIC_PROMPT_CACHING, true),
      },
      openai: {
        apiKey: env.OPENAI_API_KEY || '',
        baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
        model: env.OPENAI_MODEL || '',
        responseFormat: (env.OPENAI_RESPONSE_FORMAT || 'json_schema').toLowerCase(), // json_schema | json_object | none
      },
      // Local Claude Code CLI signed in with the user's Claude subscription (AI_PROVIDER=claude-code-cli).
      // No API key is used: ANTHROPIC_API_KEY and other API credentials are removed from the CLI's environment.
      claudeCode: {
        path: env.CLAUDE_CODE_PATH || 'claude',
        model: env.CLAUDE_CODE_MODEL || 'sonnet',
        effort: env.CLAUDE_CODE_EFFORT === undefined ? 'medium' : env.CLAUDE_CODE_EFFORT, // '' — CLI default
      },
      pricing: {
        inputPerMTok: float(env.AI_PRICE_INPUT_PER_MTOK, 2),
        outputPerMTok: float(env.AI_PRICE_OUTPUT_PER_MTOK, 10),
        cacheReadPerMTok: float(env.AI_PRICE_CACHE_READ_PER_MTOK, 0.1),
        cacheWritePerMTok: float(env.AI_PRICE_CACHE_WRITE_PER_MTOK, 2.5),
        estThinkingTokens: int(env.AI_EST_THINKING_TOKENS, 1500),
      },
      lowConfidence: float(env.AI_LOW_CONFIDENCE, 0.6),
    },
    audio: {
      timeoutMs: int(env.AUDIO_TIMEOUT_MS, 45000),
      maxBytes: int(env.AUDIO_MAX_BYTES, 150 * 1024 * 1024),
      cache: bool(env.AUDIO_CACHE, true),
    },
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 40 * 1024 * 1024),
    logLevel: env.LOG_LEVEL || 'info',
    ...overrides.config,
  };
  if (overrides.dataDir) cfg.dataDir = resolve(overrides.dataDir);
  return cfg;
}

/** Which evaluation engine is effectively available. */
export function resolveProvider(cfg) {
  const p = cfg.ai.provider;
  if (p === 'rules') return 'rules';
  if (p === 'anthropic') return cfg.ai.anthropic.apiKey ? 'anthropic' : 'rules';
  if (p === 'openai') return cfg.ai.openai.model && (cfg.ai.openai.apiKey || !cfg.ai.openai.baseUrl.includes('api.openai.com')) ? 'openai' : 'rules';
  if (p === 'mock') return 'mock';
  if (p === 'claude-code-cli') return 'claude-code-cli'; // explicit only, never chosen by "auto"
  // auto
  if (cfg.ai.anthropic.apiKey) return 'anthropic';
  if (cfg.ai.openai.model && (cfg.ai.openai.apiKey || !cfg.ai.openai.baseUrl.includes('api.openai.com'))) return 'openai';
  return 'rules';
}
