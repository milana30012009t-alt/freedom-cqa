#!/usr/bin/env node
// ИМИТАЦИЯ команды `claude` (Claude Code CLI) — только для тестов, не AI и не часть приложения.
// Повторяет документированный формат: --version, --help, `auth status --json`, `-p --output-format stream-json
// --verbose` (событие init с apiKeySource и итоговое событие result со structured_output и modelUsage).
// Поведение задаётся переменными: FAKE_CLAUDE_AUTH = pro | none | console; FAKE_CLAUDE_MODE = ok | limit |
// limit-after:N | text | garbage-first | auth-error; FAKE_CLAUDE_LOG = файл для записи вызовов (аргументы,
// наличие ANTHROPIC_API_KEY, рабочая папка); FAKE_CLAUDE_STATE = файл-счётчик вызовов; FAKE_CLAUDE_OLD = 1 —
// «старая версия» без нужных флагов.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const log = (o) => { if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify(o)}\n`); };

if (args[0] === '--version') { process.stdout.write('2.1.319 (Claude Code)\n'); process.exit(0); }
if (args[0] === '--help') {
  const flags = env.FAKE_CLAUDE_OLD
    ? ['-p, --print', '--output-format <format>', '--model <model>']
    : ['-p, --print', '--output-format <format>   "text", "json" or "stream-json"', '--verbose', '--json-schema <schema>', '--tools <tools...>',
      '--system-prompt <prompt>', '--no-session-persistence', '--model <model>', '--setting-sources <sources>', '--safe-mode',
      '--strict-mcp-config', '--disable-slash-commands', '--effort <level>'];
  process.stdout.write(`Usage: claude [options]\n\nOptions:\n${flags.map((f) => `  ${f}`).join('\n')}\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const a = env.FAKE_CLAUDE_AUTH || 'pro';
  log({ cmd: 'auth-status', api_key_present: Boolean(env.ANTHROPIC_API_KEY), cwd: process.cwd() });
  out(a === 'none' ? { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }
    : a === 'console' ? { loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' }
      : { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' });
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  let n = 1;
  if (env.FAKE_CLAUDE_STATE) {
    n = (existsSync(env.FAKE_CLAUDE_STATE) ? Number(readFileSync(env.FAKE_CLAUDE_STATE, 'utf8')) : 0) + 1;
    writeFileSync(env.FAKE_CLAUDE_STATE, String(n));
  }
  log({ cmd: 'print', n, args, api_key_present: Boolean(env.ANTHROPIC_API_KEY), base_url_present: Boolean(env.ANTHROPIC_BASE_URL), cwd: process.cwd(), input_has_transcript: input.includes('<transcript_data>') });
  const apiKeySource = env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : (env.FAKE_CLAUDE_APIKEYSOURCE || 'none');
  const model = opt('--model') === 'sonnet' ? 'claude-sonnet-5-5' : (opt('--model') || 'claude-sonnet-5-5');
  out({ type: 'system', subtype: 'init', apiKeySource, model, tools: [], mcp_servers: [] });
  const mode = env.FAKE_CLAUDE_MODE || 'ok';
  const limitAfter = /^limit-after:(\d+)$/.exec(mode);
  const base = { type: 'result', session_id: 'fake', duration_ms: 1200, num_turns: 1, total_cost_usd: 0 };
  if (mode === 'limit' || (limitAfter && n > Number(limitAfter[1]))) {
    out({ ...base, subtype: 'success', is_error: true, api_error_status: 429, result: '5-hour limit reached ∙ resets 3am (Asia/Almaty)', modelUsage: {} });
    process.exit(1);
  }
  if (mode === 'auth-error') {
    out({ ...base, subtype: 'success', is_error: true, api_error_status: 401, result: 'Authentication error · Please run /login', modelUsage: {} });
    process.exit(1);
  }
  const answer = buildAnswer(input);
  const usage = { input_tokens: Math.round(input.length / 3), output_tokens: 1800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const modelUsage = { [model]: { inputTokens: usage.input_tokens, outputTokens: 1800 }, 'claude-haiku-5-5': { inputTokens: 300, outputTokens: 20 } };
  if (mode === 'text' || (mode === 'garbage-first' && n === 1)) {
    out({ ...base, subtype: 'success', is_error: false, result: mode === 'text' ? JSON.stringify(answer) : 'Извините, вот оценка: всё хорошо.', usage, modelUsage, stop_reason: 'end_turn' });
    process.exit(0);
  }
  out({ ...base, subtype: 'success', is_error: false, result: '', structured_output: answer, usage, modelUsage, stop_reason: 'end_turn' });
  process.exit(0);
});

function buildAnswer(text) {
  const cl = JSON.parse(text.slice(text.indexOf('{'), text.indexOf('\n\nДИАЛОГ ДЛЯ ОЦЕНКИ')));
  const data = JSON.parse(text.slice(text.indexOf('<transcript_data>') + 17, text.indexOf('</transcript_data>')));
  const msgs = data.transcript;
  const ops = msgs.filter((m) => m.speaker === 'operator');
  const pick = ops.length ? ops : msgs;
  let h = 0;
  for (const ch of data.conversation.conversation_id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const quoteOf = (m) => { const t = m.text.trim(); if (t.length <= 40) return t; const c = t.slice(0, 40); return c.slice(0, Math.max(10, c.lastIndexOf(' '))).trim(); };
  return {
    criteria: cl.checklist.criteria.map((c, k) => {
      const m = pick[(h + k) % pick.length];
      const q = quoteOf(m);
      let status = 'scored';
      let ans = c.allowed_answers[(h >>> k) % c.allowed_answers.length];
      if (c.scoring_role === 'flag') ans = 'no';
      if (c.na_allowed && (h + k) % 7 === 0) { status = 'na'; ans = ''; }
      return {
        criterion_id: c.criterion_id, status, answer: ans, situation: status === 'na' ? 'na' : 'met',
        explanation: `Проверена реплика «${q}» (${m.time}).`, evidence_ids: [m.id], quotes: [{ message_id: m.id, quote: q }],
        evidence_type: 'supporting_messages', confidence: 0.7, na_reason: status === 'na' ? 'Условие неприменимости выполнено (имитация)' : '',
        recommendation: '', critical_flag: false, needs_human_review: false, flag_subtypes: [],
      };
    }),
    critical_findings: [], overall_summary: 'Имитация ответа CLI.', transcript_issues: [],
  };
}
