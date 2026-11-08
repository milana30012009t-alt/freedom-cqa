// Claude Code CLI provider: runs the official, unmodified `claude` binary in print mode (`claude -p`)
// signed in with the user's own Claude subscription (Pro / Max). No API key is used or required:
//   - API credentials (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, …) are removed from the CLI's environment,
//     because in -p mode an API key in the environment always takes precedence over the subscription;
//   - user/project settings are not loaded (--setting-sources ""), so an apiKeyHelper cannot switch billing;
//   - before the first call `claude auth status` must report a claude.ai (subscription) login;
//   - every call checks the CLI's own init event: apiKeySource must be "none" (subscription), otherwise the
//     process is stopped and the run is aborted.
// The CLI runs in an empty working directory (no project .env, CLAUDE.md or settings), with all tools
// disabled, without session persistence (no transcripts with client data saved to ~/.claude), with our
// system prompt and the structured-output JSON schema. The model that actually answered is read from the
// CLI result (modelUsage). Usage counts against the subscription's limits; hitting a limit stops the run.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpstreamError } from '../../lib/http-client.js';
import { maskSecrets } from '../../lib/logger.js';
import { parseModelJson } from '../output-schema.js';

/** Credentials and switches that would make the CLI bill an API account or another provider instead of the subscription. */
export const STRIPPED_ENV = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_AWS',
  'CLAUDE_CODE_SIMPLE', // bare mode: API key only, OAuth never read
]);

/** Errors after which further calls in the same run are pointless (or would not use the subscription). */
export const FATAL_CODES = Object.freeze(['CLI_NOT_FOUND', 'CLI_UNSUPPORTED', 'AUTH', 'NOT_SUBSCRIPTION', 'USAGE_LIMIT']);

const REQUIRED_FLAGS = ['--print', '--output-format', 'stream-json', '--verbose', '--json-schema', '--tools', '--system-prompt', '--no-session-persistence', '--model', '--setting-sources'];
const OPTIONAL_FLAGS = ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--effort'];
const LIMIT_RE = /usage limit|limit reached|limit will reset|resets? (?:at|in|on)|hit your (?:session |weekly )?limit|weekly limit|5-hour limit|session limit|out of (?:extra )?usage|usage credits|rate.?limit|лимит/i;
const AUTH_RE = /not logged in|please run \/login|\/login|authentication|authenticat|invalid api key|oauth|token (?:has )?expired|unauthori[sz]ed|401|403/i;

const cache = new Map(); // per CLI path: { version, flags, auth }

function fatal(message, code, extra = {}) {
  const e = new UpstreamError(message, { code, ...extra });
  e.fatal = FATAL_CODES.includes(code);
  return e;
}

export class ClaudeCodeCliProvider {
  constructor(cfg, { spawnImpl } = {}) {
    this.cfg = cfg.ai.claudeCode;
    this.common = cfg.ai;
    this.spawnImpl = spawnImpl || spawn;
    this.workDir = join(tmpdir(), 'freedom-cqa-claude-code');
  }

  get info() {
    const c = cache.get(this.cfg.path);
    return {
      id: 'claude-code-cli',
      model: this.cfg.model,
      label: `Claude Code CLI (подписка) · ${this.cfg.model}`,
      endpoint: null,
      mode: 'external_api', // the model runs on Anthropic's servers; access is the user's subscription via the CLI
      cli_version: c?.version || null,
      subscription: c?.auth?.subscriptionType || null,
    };
  }

  /** Environment of the CLI process: the user's environment without API credentials. */
  childEnv() {
    const env = { ...process.env };
    for (const k of STRIPPED_ENV) delete env[k];
    return env;
  }

  /** Run the CLI; `onLine(obj, kill)` sees every JSON line of stdout as it arrives. */
  run(args, { input = '', timeoutMs = this.common.timeoutMs, onLine = null } = {}) {
    mkdirSync(this.workDir, { recursive: true });
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(this.cfg.path, args, { cwd: this.workDir, env: this.childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(this.spawnError(e));
        return;
      }
      let stdout = '';
      let stderr = '';
      let buf = '';
      let killedFor = null;
      const kill = (reason) => {
        if (killedFor) return;
        killedFor = reason;
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
      };
      const timer = setTimeout(() => kill({ code: 'TIMEOUT' }), timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(this.spawnError(e)); });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        stdout += d;
        if (!onLine) return;
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          try { onLine(obj, kill); } catch (e) { kill({ code: 'HANDLER', error: e }); }
        }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr, killedFor });
      });
      child.stdin.on('error', () => { /* the CLI may exit before reading all input */ });
      child.stdin.end(input);
    });
  }

  spawnError(e) {
    if (e && e.code === 'ENOENT') {
      return fatal(`Claude Code не найден (команда «${this.cfg.path}»). Установите: curl -fsSL https://claude.ai/install.sh | bash — или укажите путь в CLAUDE_CODE_PATH`, 'CLI_NOT_FOUND');
    }
    return fatal(`Не удалось запустить Claude Code: ${maskSecrets(e?.message || e)}`, 'CLI_NOT_FOUND');
  }

  /** Version and supported flags (once per CLI path). */
  async capabilities() {
    const c = cache.get(this.cfg.path) || {};
    if (c.flags) return c;
    const v = await this.run(['--version'], { timeoutMs: 30000 });
    const version = (/(\d+\.\d+\.\d+)/.exec(v.stdout) || [])[1] || null;
    const h = await this.run(['--help'], { timeoutMs: 30000 });
    const help = `${h.stdout}\n${h.stderr}`;
    const has = (f) => new RegExp(`(^|[\\s,])${f.replace(/[-]/g, '\\-')}(?=[\\s,<\\[=]|$)`, 'm').test(help) || (f === 'stream-json' && help.includes('stream-json'));
    const missing = REQUIRED_FLAGS.filter((f) => !has(f));
    if (missing.length) {
      throw fatal(`Claude Code ${version || '(версия неизвестна)'} не поддерживает нужные флаги (${missing.join(', ')}). Обновите: claude update`, 'CLI_UNSUPPORTED');
    }
    const flags = new Set([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS.filter(has)]);
    const next = { ...c, version, flags };
    cache.set(this.cfg.path, next);
    return next;
  }

  /** Signed in with a Claude subscription? (`claude auth status --json`; no model call, nothing secret printed.) */
  async authStatus({ refresh = false } = {}) {
    const c = cache.get(this.cfg.path) || {};
    if (c.auth && !refresh) return c.auth;
    const r = await this.run(['auth', 'status', '--json'], { timeoutMs: 30000 });
    let s;
    try { s = JSON.parse(r.stdout.trim()); } catch {
      throw fatal(`Claude Code не сообщил состояние входа (claude auth status --json). Обновите Claude Code: claude update`, 'CLI_UNSUPPORTED');
    }
    if (!s.loggedIn) throw fatal('Claude Code не авторизован. Выполните в Терминале: claude auth login (вход через подписку Claude)', 'AUTH');
    if (s.authMethod !== 'claude.ai') {
      throw fatal(`Claude Code вошёл не через подписку Claude (authMethod = ${s.authMethod}). Выполните: claude auth logout, затем claude auth login --claudeai`, 'NOT_SUBSCRIPTION');
    }
    const auth = { loggedIn: true, authMethod: s.authMethod, subscriptionType: s.subscriptionType || null, apiProvider: s.apiProvider || null };
    cache.set(this.cfg.path, { ...(cache.get(this.cfg.path) || {}), auth });
    return auth;
  }

  async preflight() {
    const caps = await this.capabilities();
    const auth = await this.authStatus();
    return { version: caps.version, flags: [...caps.flags], auth };
  }

  buildArgs({ system, schema }, flags) {
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--model', this.cfg.model,
      '--tools', '', '--no-session-persistence', '--setting-sources', '', '--system-prompt', system];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (flags.has('--safe-mode')) args.push('--safe-mode');
    if (flags.has('--strict-mcp-config')) args.push('--strict-mcp-config');
    if (flags.has('--disable-slash-commands')) args.push('--disable-slash-commands');
    if (this.cfg.effort && flags.has('--effort')) args.push('--effort', this.cfg.effort);
    return args;
  }

  /**
   * @returns {Promise<{output:object, rawText:string, stopReason:string|null, model:string|null, usage:object, meta:object}>}
   */
  async evaluate({ system, checklistBlock, conversationBlock, schema, repairNote }) {
    const { flags } = await this.capabilities();
    const auth = await this.authStatus();
    const input = `${checklistBlock}\n\n${conversationBlock}${repairNote ? `\n\nВАЖНО: ${repairNote}` : ''}\n\nВерни ответ строго по заданной JSON-схеме.`;
    let init = null;
    let result = null;
    const r = await this.run(this.buildArgs({ system, schema }, flags), {
      input,
      onLine: (obj, kill) => {
        if (obj.type === 'system' && obj.subtype === 'init') {
          init = obj;
          if (obj.apiKeySource !== 'none') kill({ code: 'NOT_SUBSCRIPTION', apiKeySource: obj.apiKeySource });
        } else if (obj.type === 'result') result = obj;
      },
    });
    if (r.killedFor?.code === 'NOT_SUBSCRIPTION') {
      throw fatal(`Claude Code собирался использовать ключ API (${r.killedFor.apiKeySource}), а не подписку — вызов остановлен. Уберите ключ из настроек Claude Code (apiKeyHelper) и войдите заново: claude auth login --claudeai`, 'NOT_SUBSCRIPTION');
    }
    if (r.killedFor?.code === 'TIMEOUT') {
      throw new UpstreamError(`Claude Code не ответил за ${Math.round(this.common.timeoutMs / 1000)} с (AI_TIMEOUT_MS)`, { code: 'TIMEOUT', retryable: true });
    }
    if (!init && !result) {
      const msg = maskSecrets((r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ')).slice(0, 300);
      throw new UpstreamError(`Claude Code завершился с кодом ${r.code}: ${msg || 'без сообщения'}`, { code: 'CLI_ERROR' });
    }
    if (init && init.apiKeySource !== 'none') throw fatal('Claude Code использовал не подписку — результат отброшен', 'NOT_SUBSCRIPTION');
    if (!result) throw new UpstreamError(`Claude Code не вернул результат (код ${r.code})`, { code: 'CLI_ERROR' });

    const text = String(result.result ?? '');
    if (result.is_error) {
      const status = Number(result.api_error_status) || 0;
      if (status === 429 || LIMIT_RE.test(text)) throw fatal(`Достигнут лимит подписки Claude: ${text.slice(0, 200)}`, 'USAGE_LIMIT', { status });
      if (status === 401 || status === 403 || AUTH_RE.test(text)) throw fatal(`Claude Code: ошибка входа — ${text.slice(0, 200)}. Проверьте: claude auth status`, 'AUTH', { status });
      throw new UpstreamError(`Claude Code: ${text.slice(0, 300) || result.subtype || 'ошибка'}`, { code: 'CLI_ERROR', status });
    }
    const output = result.structured_output && typeof result.structured_output === 'object' ? result.structured_output : parseModelJson(text);
    const u = result.usage || {};
    return {
      output,
      rawText: text || JSON.stringify(output),
      stopReason: result.stop_reason || null,
      model: servedModel(result.modelUsage) || init?.model || null,
      usage: {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_tokens: u.cache_read_input_tokens || 0,
        cache_write_tokens: u.cache_creation_input_tokens || 0,
      },
      meta: { cli_version: cache.get(this.cfg.path)?.version || null, auth: auth.authMethod, subscription: auth.subscriptionType, api_key_source: init?.apiKeySource ?? null, duration_ms: result.duration_ms ?? null },
    };
  }
}

/** The model that produced the answer: the one with the most output tokens in the CLI's modelUsage. */
export function servedModel(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let best = null;
  let bestOut = -1;
  for (const [name, u] of Object.entries(modelUsage)) {
    const out = Number(u?.outputTokens ?? u?.output_tokens ?? 0);
    if (out > bestOut) { best = name; bestOut = out; }
  }
  return best;
}

/** For tests: forget cached capabilities / login state. */
export function resetClaudeCodeCache() {
  cache.clear();
}
