import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import handler from '../api/grade.js';

const feedback = { score: 80, summary: '講評', modelAnswers: [{ text: 'A', type: 'a' }, { text: 'B', type: 'b' }], corrections: [], keyVocab: [] };
function screen(fetchImpl) {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const store = new Map(), nodes = new Map(), calls = [];
  let now = Date.parse('2026-10-26T01:30:00Z');
  class Clock extends Date { static now() { return now; } }
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, innerText: '', placeholder: '', classList: { toggle() {}, add() {}, remove() {} }, querySelector() { return node(id + ':child'); } });
    return nodes.get(id);
  };
  const ctx = vm.createContext({
    window: {}, tailwind: {}, navigator: {}, Date: Clock, console, setTimeout, setInterval,
    document: { getElementById: node },
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    fetch: async (...args) => { calls.push(args); return fetchImpl(...args); }
  });
  vm.runInContext(source, ctx);
  vm.runInContext(`showLoading = () => {}; hideLoading = () => {}; showToast = () => {}; hideFeedbackUI = () => {};
    updateStreakOnSubmit = () => {}; displayFeedbackUI = () => {}; saveHistoryItem = () => {};
    displayQuestionUI = q => { document.getElementById('userTranslation').value = ''; };
    appState.currentQuestion = {id:'q1', japanese:'問題', level:'level', category:'category'};`, ctx);
  node('userTranslation').value = 'My answer';
  return { ctx, store, node, calls, setNow: value => { now = value; }, now: () => now, run: code => vm.runInContext(code, ctx) };
}
test('successful grading locks a second attempt and unlocks exactly 12 hours later', async () => {
  const ui = screen(async () => ({ ok: true, json: async () => feedback }));
  await ui.run('submitTranslation()');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.run('remainingCooldown()'), 12 * 3600000);
  await ui.run('submitTranslation()');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.node('btnSubmit').disabled, true);
  const completedAt = ui.now();
  ui.setNow(completedAt + 12 * 3600000 - 1);
  assert.equal(ui.run('remainingCooldown()'), 1);
  ui.setNow(completedAt + 12 * 3600000);
  ui.run('loadDailyAttempts()');
  assert.equal(ui.run('remainingCooldown()'), 0);
  assert.equal(ui.node('btnSubmit').disabled, false);
});
test('API failure retains draft and does not consume the question', async () => {
  const ui = screen(async () => ({ ok: false, status: 429, json: async () => ({ error: '混雑中' }) }));
  await ui.run('submitTranslation()');
  assert.equal(ui.run('remainingCooldown()'), 0);
  assert.equal(ui.store.has('eigoboost_12h_attempt'), false);
  assert.equal(JSON.parse(ui.store.get('eigoboost_12h_question')).answer, 'My answer');
  assert.equal(ui.node('btnSubmit').disabled, false);
});
test('question reload and setting changes reuse the saved question without an API call', async () => {
  const ui = screen(async () => ({ ok: true, json: async () => ({ japanese: '新しい問題', hint: 'ヒント' }) }));
  ui.run('appState.currentQuestion = null');
  ui.node('settingLevel').value = 'level'; ui.node('settingCategory').value = 'category';
  await ui.run('generateNewQuestion()');
  ui.node('userTranslation').value = 'Draft'; ui.run('saveQuestionDraft()');
  await ui.run('generateNewQuestion()');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.node('userTranslation').value, 'Draft');
  assert.equal(ui.run('appState.currentQuestion.japanese'), '新しい問題');
});
test('simultaneous clicks in one tab submit only once', async () => {
  let release;
  const ui = screen(() => new Promise(resolve => { release = resolve; }));
  const first = ui.run('submitTranslation()');
  await ui.run('submitTranslation()');
  assert.equal(ui.calls.length, 1);
  release({ ok: true, json: async () => feedback });
  await first;
});
function res() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(value) { this.body = value; return this; } }; }
const request = { method: 'POST', body: { action: 'grade', level: 'level', category: 'category', japanese: '問題', userTranslation: 'My answer' } };
test('upstream daily 429 is returned as 429 without retrying', async t => {
  process.env.GEMINI_API_KEY = 'fake-key';
  const original = globalThis.fetch;
  let calls = 0;
  t.after(() => { globalThis.fetch = original; delete process.env.GEMINI_API_KEY; });
  globalThis.fetch = async () => { calls++; return { ok: false, status: 429, headers: new Headers(), json: async () => ({ error: { details: [{ violations: [{ quotaId: 'RequestsPerDay' }] }] } }) }; };
  const response = res(); await handler(request, response);
  assert.equal(response.code, 429);
  assert.equal(response.body.code, 'API_DAILY_LIMIT');
  assert.equal(calls, 1);
});
test('temporary 429 respects Retry-After', async t => {
  process.env.GEMINI_API_KEY = 'fake-key';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; delete process.env.GEMINI_API_KEY; });
  globalThis.fetch = async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }), json: async () => ({ error: {} }) });
  const response = res(); await handler(request, response);
  assert.equal(response.code, 429);
  assert.equal(response.headers['Retry-After'], '90');
});
test('malformed AI response is rejected before the browser consumes a question', async t => {
  process.env.GEMINI_API_KEY = 'fake-key';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; delete process.env.GEMINI_API_KEY; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"score":80}' }] } }] }) });
  const response = res(); await handler(request, response);
  assert.equal(response.code, 502);
});
