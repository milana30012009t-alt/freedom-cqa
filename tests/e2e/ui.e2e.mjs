// Browser end-to-end check of the jury demo flow (Playwright is an optional dev tool,
// the project itself has no dependencies).
//
//   npm i --no-save playwright && npx playwright install chromium
//   npm run test:e2e
//
// Optional env: PLAYWRIGHT_MODULE=<path to playwright/index.mjs>, CHROME_PATH=<chrome binary>,
// E2E_HEADED=1 (show the browser). Screenshots: tests/e2e/screenshots/ (git-ignored).
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { MINI, ROOT, tmpCfg } from '../helpers.js';

const SHOTS = join(ROOT, 'tests', 'e2e', 'screenshots');

async function loadPlaywright() {
  for (const m of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try {
      return await import(m);
    } catch { /* try the next one */ }
  }
  return null;
}

const pw = await loadPlaywright();
if (!pw) {
  console.log('SKIPPED: Playwright не установлен. Установите: npm i --no-save playwright && npx playwright install chromium');
  process.exit(0);
}

// ---------- server with an isolated data dir and the mini fixture ----------
const tmp = tmpCfg();
const app = createApp(tmp.cfg, {
  // the fixture's audio link is fake: emulate an expired signed link (403) deterministically
  audioFetchImpl: async () => new Response('AuthorizationFailure', { status: 403 }),
});
await app.init();
await app.services.datasets.importPayload('TEST', JSON.parse(readFileSync(MINI, 'utf8')), 'e2e');
await app.services.datasets.setActive('TEST');
for (const c of app.services.datasets.conversations('TEST')) await app.services.evaluations.evaluate(c.uid, { engine: 'rules' });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${app.server.address().port}`;
const CARD = `${BASE}/#/c/${encodeURIComponent('TEST:t-ru-002')}`;

mkdirSync(SHOTS, { recursive: true });
const browser = await pw.chromium.launch({
  headless: !process.env.E2E_HEADED,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // the expected failed <audio> request for the expired link is not an application error
  if ((m.location()?.url || '').includes('/api/audio/')) return;
  consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`✔ ${name} (${Date.now() - t0} ms)`);
    return true;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    console.log(`✖ ${name}\n    ${String(e.message).split('\n')[0]}`);
    await page.screenshot({ path: join(SHOTS, `FAILED-${results.length}.png`) }).catch(() => {});
    return false;
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const scoreText = () => page.locator('.score-ring .v b').first().innerText();
/** Navigate and wait until the target page (not the previous one) is rendered. */
async function open(hash, heading) {
  await page.goto(`${BASE}/${hash}`);
  await page.waitForFunction((t) => (document.querySelector('#view h1')?.textContent || '').includes(t), heading);
}

const flow = [
  ['дашборд открывается и показывает набор TEST', async () => {
    await page.goto(`${BASE}/#/`);
    await page.locator('#view h1', { hasText: 'набор TEST' }).waitFor();
    await shot('01-dashboard');
  }],
  ['список диалогов: 5 строк, поиск по ID фильтрует', async () => {
    await open('#/conversations', 'Диалоги');
    await page.waitForFunction(() => document.querySelectorAll('#view table.table tbody tr').length === 5);
    await page.fill('input.search', 't-ru-002');
    await page.waitForFunction(() => document.querySelectorAll('table.table tbody tr').length === 1);
    await shot('02-conversations');
  }],
  ['карточка: клик по доказательству подсвечивает реплику', async () => {
    await page.locator('#view table.table tbody tr').first().click();
    await page.locator('#crit-identification').waitFor();
    await page.click('#crit-identification .crit-head');
    await page.locator('#crit-identification .ev').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.msg.evidence').length > 0);
    await shot('03-card-evidence');
  }],
  ['оператор подаёт апелляцию по критерию 05', async () => {
    await page.click('#crit-empathy .crit-head');
    await page.locator('#crit-empathy button', { hasText: 'Оспорить оценку' }).click();
    await page.locator('.modal textarea').fill('Оператор был вежлив и извинился за ожидание');
    await page.locator('.modal button', { hasText: 'Отправить апелляцию' }).click();
    await page.locator('.toast', { hasText: 'Апелляция' }).first().waitFor();
    await page.locator('#crit-empathy .chip.serious').waitFor(); // open appeal is shown on the criterion
  }],
  ['проверяющий: взять в работу → изменить оценку с живым пересчётом', async () => {
    globalThis.scoreBefore = await scoreText();
    await page.click('.segmented.role button[data-value="reviewer"]');
    await open('#/appeals', 'Апелляции');
    await page.locator('#view table.table tbody tr').first().click();
    await page.locator('.drawer button', { hasText: 'Взять в работу' }).click();
    await page.locator('.drawer .chip', { hasText: 'Ожидает рассмотрения' }).first().waitFor();
    await page.locator('.drawer .segmented button', { hasText: 'Изменить оценку' }).click();
    await page.locator('.drawer label.check', { hasText: /^Да$/ }).locator('input').check();
    await page.locator('.drawer .banner.info', { hasText: 'Итог после решения' }).waitFor();
    await page.locator('.drawer textarea').fill('В реплике оператора есть извинение и вежливые формулировки');
    await page.locator('.drawer button', { hasText: 'Сохранить решение' }).click();
    await page.locator('.drawer', { hasText: 'Оценка изменена' }).waitFor();
    await shot('04-appeal-decided');
    await page.keyboard.press('Escape');
    expect((await page.evaluate(() => location.hash)) === '#/appeals', 'после закрытия URL должен вернуться к очереди');
  }],
  ['итог диалога пересчитан, исходная оценка сохранена', async () => {
    await page.goto(CARD);
    await page.locator('.score-ring').waitFor();
    const after = await scoreText();
    expect(after !== globalThis.scoreBefore, `итог не изменился (${after})`);
    await page.locator('.score-side .was').waitFor();
    await shot('05-card-after-appeal');
  }],
  ['чек-лист: изменить порог первой реакции в интерфейсе (180 → 30 с) → новая активная версия v2', async () => {
    await open('#/checklists', 'Управление чек-листом');
    await page.locator('button', { hasText: 'Изменить → новая версия' }).click();
    const threshold = page.locator('label.field', { has: page.locator('span', { hasText: /^Порог первой реакции, с$/ }) }).locator('input');
    await threshold.fill('30');
    await page.fill('input[placeholder^="Что изменено"]', 'Порог первой реакции 30 с (демо)');
    await page.locator('button', { hasText: 'Сохранить как новую версию' }).click();
    await page.locator('.modal', { hasText: 'Применить чек-лист v2' }).waitFor();
    await page.locator('.modal button', { hasText: 'Позже' }).click();
    await page.waitForFunction(() => location.hash === '#/checklists/2');
    await page.locator('.chip', { hasText: 'Порог первой реакции: 30 с' }).waitFor();
    await shot('06-checklist-v2');
  }],
  ['переоценка по v2 из карточки: критерий 06 и итог изменились, панель «что изменилось»', async () => {
    await page.goto(`${BASE}/#/c/${encodeURIComponent('TEST:t-ru-001')}`);
    await page.locator('.score-ring').waitFor();
    const before = await scoreText();
    await page.locator('.banner.info button', { hasText: 'Переоценить по v2' }).click();
    await page.locator('#diff-panel').waitFor();
    const text = await page.locator('#diff-panel').innerText();
    expect(/v1/.test(text) && /v2/.test(text), 'панель изменений должна называть обе версии');
    expect(/Управление диалогом/.test(text), `в изменениях должен быть критерий 06: ${text}`);
    expect((await scoreText()) !== before, 'итог должен измениться');
    expect((await page.locator('.conv-meta').innerText()).includes('чек-лист v2'), 'оценка должна быть по v2');
    await shot('07-reevaluated-diff');
  }],
  ['звонок: недоступная запись → понятное сообщение, транскрипт доступен', async () => {
    await page.goto(`${BASE}/#/c/${encodeURIComponent('TEST:t-call-001')}`);
    await page.locator('.transcript .msg').first().waitFor();
    await page.locator('.player button.play').click();
    await page.locator('.player .err', { hasText: 'Запись недоступна' }).waitFor({ timeout: 15000 });
    await shot('08-call-audio-unavailable');
  }],
  ['аналитика, данные и режим встраивания (Dynamics 365) открываются', async () => {
    await open('#/analytics', 'Аналитика');
    await page.waitForTimeout(300);
    await shot('09-analytics');
    await open('#/data', 'Данные');
    await page.goto(`${BASE}/?embed=1#/c/${encodeURIComponent('TEST:t-ru-001')}`);
    await page.locator('#app.embed').waitFor();
    await page.locator('.score-ring').waitFor();
    await shot('10-embed');
  }],
  ['ни на одной странице и в раскрытых карточках критериев нет «null» / «undefined» / «NaN»', async () => {
    const bad = /(^|[^\p{L}])(null|undefined|NaN)([^\p{L}]|$)/u;
    const pages = [['#/', 'набор'], ['#/conversations', 'Диалоги'], ['#/appeals', 'Апелляции'], ['#/checklists', 'Управление чек-листом'], ['#/analytics', 'Аналитика'], ['#/data', 'Данные']];
    for (const [hash, heading] of pages) {
      await open(hash, heading);
      await page.waitForTimeout(200);
      const text = await page.locator('#view').innerText();
      expect(!bad.test(text), `${hash}: ${text.match(bad)?.[0]}`);
    }
    for (const id of ['TEST:t-ru-002', 'TEST:t-call-001', 'TEST:t-en-001']) {
      await page.goto(`${BASE}/#/c/${encodeURIComponent(id)}`);
      await page.locator('.crit-head').first().waitFor();
      // expand every criterion (programmatic click: toasts may cover the headers)
      await page.evaluate(() => document.querySelectorAll('.crit:not(.open) .crit-head').forEach((x) => x.click()));
      for (const tab of ['Нарушения и риски', 'История', 'Качество текста']) {
        const text = await page.locator('#view').innerText();
        expect(!bad.test(text), `${id}: ${text.match(bad)?.[0]}`);
        const t = page.locator('.tabs button, [role=tab]', { hasText: tab }).first();
        if (await t.count()) { await t.click({ force: true }); await page.waitForTimeout(150); }
      }
      expect(!bad.test(await page.locator('#view').innerText()), `${id} (вкладки)`);
    }
  }],
];

for (const [name, fn] of flow) {
  if (!(await step(name, fn))) break;
}
await step('в консоли браузера нет ошибок', async () => {
  expect(consoleErrors.length === 0, consoleErrors.join(' | '));
});

await browser.close();
app.server.close();
tmp.cleanup();

const failed = results.filter((r) => !r.ok);
const skipped = flow.length + 1 - results.length;
console.log(`\nℹ steps ${flow.length + 1}  ℹ pass ${results.length - failed.length}  ℹ fail ${failed.length}${skipped ? `  ℹ not run ${skipped}` : ''}`);
console.log(`ℹ screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
