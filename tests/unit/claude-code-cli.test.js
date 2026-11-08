// Claude Code CLI provider (AI_PROVIDER=claude-code-cli) against an IMITATION of the `claude` command
// (tests/fixtures/fake-claude.mjs): no model, no network, no subscription is used by these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeCliProvider, resetClaudeCodeCache, servedModel, STRIPPED_ENV } from '../../server/evaluation/providers/claude-code-cli.js';
import { resolveProvider } from '../../server/config.js';
import { createServices, initServices } from '../../server/app.js';
import { exportResults, ExportError } from '../../server/results/exporter.js';
import { recordCheck, passedSample } from '../../server/results/model-check.js';
import { buildPrompt } from '../../server/evaluation/prompt.js';
import { AI_OUTPUT_SCHEMA, AiOutputError } from '../../server/evaluation/output-schema.js';
import { validateChecklist } from '../../shared/checklist-schema.js';
import { parseDatasetPayload } from '../../server/data/dataset-validator.js';
import { buildConversation } from '../../server/data/transcript-model.js';
import { MINI, OFFICIAL_CHECKLIST, ROOT, readJson, tmpCfg } from '../helpers.js';

const FAKE = join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs');
const checklist = validateChecklist(readJson(OFFICIAL_CHECKLIST)).checklist;
const conv = buildConversation(parseDatasetPayload(readJson(MINI)).records[0], 'TEST');
const prompt = { ...buildPrompt(conv, checklist, checklist.criteria), schema: AI_OUTPUT_SCHEMA };

/** A temporary `claude` executable that runs the imitation, plus a log of every call. */
function fakeCli(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cqa-fake-claude-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  const logFile = join(dir, 'calls.log');
  const saved = {};
  const vars = { FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_STATE: join(dir, 'n'), ...env };
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  resetClaudeCodeCache();
  return {
    bin,
    calls: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    done: () => {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      resetClaudeCodeCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function cfgFor(bin, extra = {}) {
  return tmpCfg({ AI_PROVIDER: 'claude-code-cli', CLAUDE_CODE_PATH: bin, AI_TIMEOUT_MS: '60000', ...extra });
}

test('claude-code-cli: chosen only explicitly; needs no API key', () => {
  const t = tmpCfg({ AI_PROVIDER: 'claude-code-cli' });
  try {
    assert.equal(resolveProvider(t.cfg), 'claude-code-cli');
    assert.equal(t.cfg.ai.claudeCode.model, 'sonnet');
    assert.equal(t.cfg.ai.anthropic.apiKey, '');
  } finally { t.cleanup(); }
  const auto = tmpCfg({ AI_PROVIDER: 'auto' });
  try { assert.equal(resolveProvider(auto.cfg), 'rules'); } finally { auto.cleanup(); }
});

test('claude-code-cli: API credentials never reach the CLI, it runs outside the project, tools off, no session saved', async () => {
  const f = fakeCli({ ANTHROPIC_API_KEY: 'sk-ant-api03-must-not-be-used', ANTHROPIC_BASE_URL: 'https://proxy.example', CLAUDE_CODE_SIMPLE: '1' });
  const t = cfgFor(f.bin);
  try {
    const p = new ClaudeCodeCliProvider(t.cfg);
    const r = await p.evaluate(prompt);
    assert.equal(r.model, 'claude-sonnet-5-5');
    assert.equal(r.meta.api_key_source, 'none');
    assert.equal(r.meta.subscription, 'pro');
    assert.ok(Array.isArray(r.output.criteria) && r.output.criteria.length === 8);
    const calls = f.calls();
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      assert.equal(c.api_key_present, false, 'ANTHROPIC_API_KEY must be removed');
      assert.notEqual(c.cwd, ROOT, 'must not run in the project folder (.env, CLAUDE.md)');
    }
    const print = calls.find((c) => c.cmd === 'print');
    assert.equal(print.base_url_present, false);
    assert.equal(print.input_has_transcript, true);
    const a = print.args;
    const val = (flag) => a[a.indexOf(flag) + 1];
    assert.ok(a.includes('--print'));
    assert.equal(val('--output-format'), 'stream-json');
    assert.equal(val('--tools'), '');
    assert.equal(val('--setting-sources'), '');
    assert.equal(val('--model'), 'sonnet');
    assert.ok(a.includes('--no-session-persistence'));
    assert.deepEqual(JSON.parse(val('--json-schema')), AI_OUTPUT_SCHEMA);
    assert.ok(!a.includes('--bare'), '--bare would require an API key');
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_SIMPLE']) assert.ok(STRIPPED_ENV.includes(k));
  } finally { t.cleanup(); f.done(); }
});

test('claude-code-cli: refuses when not signed in, or signed in without a subscription', async () => {
  for (const [auth, code, re] of [['none', 'AUTH', /не авторизован.*claude auth login/], ['console', 'NOT_SUBSCRIPTION', /не через подписку.*authMethod = console/]]) {
    const f = fakeCli({ FAKE_CLAUDE_AUTH: auth });
    const t = cfgFor(f.bin);
    try {
      await assert.rejects(new ClaudeCodeCliProvider(t.cfg).evaluate(prompt), (e) => e.code === code && e.fatal === true && re.test(e.message));
      assert.equal(f.calls().filter((c) => c.cmd === 'print').length, 0, 'no model call without a subscription login');
    } finally { t.cleanup(); f.done(); }
  }
});

test('claude-code-cli: a call that would use an API key (apiKeySource ≠ none) is stopped', async () => {
  const f = fakeCli({ FAKE_CLAUDE_APIKEYSOURCE: 'apiKeyHelper' });
  const t = cfgFor(f.bin);
  try {
    await assert.rejects(new ClaudeCodeCliProvider(t.cfg).evaluate(prompt), (e) => e.code === 'NOT_SUBSCRIPTION' && e.fatal && /apiKeyHelper/.test(e.message));
  } finally { t.cleanup(); f.done(); }
});

test('claude-code-cli: subscription limit and login errors are fatal with a clear message', async () => {
  for (const [mode, code, re] of [['limit', 'USAGE_LIMIT', /лимит подписки.*resets 3am/], ['auth-error', 'AUTH', /ошибка входа/]]) {
    const f = fakeCli({ FAKE_CLAUDE_MODE: mode });
    const t = cfgFor(f.bin);
    try {
      await assert.rejects(new ClaudeCodeCliProvider(t.cfg).evaluate(prompt), (e) => e.code === code && e.fatal && re.test(e.message));
    } finally { t.cleanup(); f.done(); }
  }
});

test('claude-code-cli: missing CLI and an old CLI without the needed flags are reported', async () => {
  const t = cfgFor('/nonexistent/claude');
  try {
    resetClaudeCodeCache();
    await assert.rejects(new ClaudeCodeCliProvider(t.cfg).evaluate(prompt), (e) => e.code === 'CLI_NOT_FOUND' && /install\.sh/.test(e.message));
  } finally { t.cleanup(); }
  const f = fakeCli({ FAKE_CLAUDE_OLD: '1' });
  const t2 = cfgFor(f.bin);
  try {
    await assert.rejects(new ClaudeCodeCliProvider(t2.cfg).evaluate(prompt), (e) => e.code === 'CLI_UNSUPPORTED' && /--json-schema/.test(e.message) && /claude update/.test(e.message));
  } finally { t2.cleanup(); f.done(); }
});

test('claude-code-cli: JSON in the text result is accepted; non-JSON text triggers the repair retry', async () => {
  const f = fakeCli({ FAKE_CLAUDE_MODE: 'text' });
  const t = cfgFor(f.bin);
  try {
    const r = await new ClaudeCodeCliProvider(t.cfg).evaluate(prompt);
    assert.equal(r.output.criteria.length, 8);
  } finally { t.cleanup(); f.done(); }
  const g = fakeCli({ FAKE_CLAUDE_MODE: 'garbage-first' });
  const t2 = cfgFor(g.bin, { AI_FALLBACK_TO_RULES: 'false' });
  try {
    const s = createServices(t2.cfg);
    await initServices(s);
    await s.datasets.importPayload('TEST', readFileSync(MINI, 'utf8'), 'file');
    const c = s.datasets.conversations('TEST')[0];
    const ev = await s.evaluations.evaluate(c.uid, { engine: 'ai' });
    assert.equal(ev.engine.used, 'claude-code-cli');
    assert.equal(ev.engine.model_served, 'claude-sonnet-5-5');
    assert.equal(ev.engine.model_mode, 'external_api');
    assert.equal(ev.usage.calls, 2, 'first answer was not JSON → one repair call with the repair note');
    assert.equal(ev.usage.cost_usd, 0, 'no per-token charge on a subscription');
    assert.equal(ev.usage.billing, 'subscription');
    const prints = g.calls().filter((x) => x.cmd === 'print');
    assert.equal(prints.length, 2);
    assert.ok(prints[1].args.includes('--print'));
  } finally { t2.cleanup(); g.done(); }
  const h = fakeCli({ FAKE_CLAUDE_MODE: 'garbage-first' });
  const t3 = cfgFor(h.bin);
  try {
    await assert.rejects(new ClaudeCodeCliProvider(t3.cfg).evaluate(prompt), AiOutputError);
  } finally { t3.cleanup(); h.done(); }
});

test('servedModel: the model with the most output tokens answered (helper models ignored)', () => {
  assert.equal(servedModel({ 'claude-haiku-5-5': { outputTokens: 20 }, 'claude-sonnet-5-5': { outputTokens: 1800 } }), 'claude-sonnet-5-5');
  assert.equal(servedModel({}), null);
  assert.equal(servedModel(null), null);
});

test('export via subscription: needs a passed RU/KZ/EN trial, stops on the limit without writing, resumes without re-sending', async () => {
  const f = fakeCli({ FAKE_CLAUDE_MODE: 'ok' });
  const t = cfgFor(f.bin, { AI_CONCURRENCY: '1' });
  const out = join(t.dir, 'results.json');
  const run = (extra = {}) => exportResults({ cfg: t.cfg, set: 'dev', group: 'TEST', file: MINI, teamName: 'Команда', allowCount: true, out, ...extra });
  try {
    await assert.rejects(run(), (e) => e instanceof ExportError && e.code === 7 && /check:model/.test(e.message));
    assert.equal(existsSync(out), false);
    const info = new ClaudeCodeCliProvider(t.cfg).info;
    recordCheck(t.cfg, info, { at: 'x', ids: ['a'], languages: ['RU'], ok: true });
    assert.equal(passedSample(t.cfg, info), false, 'one Russian dialog is not enough');
    recordCheck(t.cfg, info, { at: 'y', ids: ['b', 'c', 'd'], languages: ['RU', 'KZ', 'EN'], ok: true });
    assert.equal(passedSample(t.cfg, info), true);

    process.env.FAKE_CLAUDE_MODE = 'limit-after:2';
    await assert.rejects(run(), (e) => e instanceof ExportError && e.code === 6 && /лимит подписки/.test(e.message) && /Успешно оценено 2 из 5/.test(e.message));
    assert.equal(existsSync(out), false, 'an incomplete run writes nothing');

    process.env.FAKE_CLAUDE_MODE = 'ok';
    const r = await run();
    assert.equal(r.report.ok, true, r.report.errors.join('\n'));
    assert.equal(r.reused, 2);
    assert.equal(r.doc.results.filter((x) => x.status === 'ok').length, 5);
    assert.deepEqual(r.doc.model, { mode: 'external_api', name: 'claude-sonnet-5-5' });
    const prints = f.calls().filter((c) => c.cmd === 'print').length;
    assert.equal(prints, 2 + 1 + 3, '2 ok + 1 limit + 3 remaining: evaluated dialogs are not sent again');

    const fresh = await run({ resume: false });
    assert.equal(fresh.reused, 0);
  } finally { t.cleanup(); f.done(); }
});
