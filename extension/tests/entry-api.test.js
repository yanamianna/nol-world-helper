'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../entry-api.js'), 'utf8');
const exportsContext = vm.createContext({});
vm.runInContext(source, exportsContext);
const entrySource = '(' + exportsContext.NolHelper.officialEntry.toString() + ')';
const cancelSource = '(' + exportsContext.NolHelper.cancelOfficialEntry.toString() + ')';
const productURL = 'https://world.nol.com/zh-CN/ticket/places/26001167/products/26013793';
const baseTime = Date.parse('2026-10-12T11:00:00Z');
const captchaSecret = 'MOCK_VERIFICATION_SECRET';
const accessSecret = 'MOCK_PARTNER_ACCESS_SECRET';
const refreshSecret = 'MOCK_PARTNER_REFRESH_SECRET';
const plain = (value) => JSON.parse(JSON.stringify(value));
const payload = (overrides = {}) => ({ runId: 'run-one', goodsCode: '26013793', placeCode: '26001167', openAt: baseTime, endAt: baseTime + 600000, ...overrides });

function harness(options = {}) {
  const clock = { now: baseTime };
  class ClockDate extends Date { static now() { return clock.now; } }
  const timers = new Map();
  let timerId = 0;
  const calls = { requests: [], widgets: [], ready: [], removed: [], scripts: [], navigation: [], logs: [] };
  function element(tag) {
    const listeners = new Map();
    return {
      tagName: tag.toUpperCase(), style: {}, children: [], removed: false,
      setAttribute(name, value) { this[name] = value; },
      append(...children) { this.children.push(...children); },
      appendChild(child) {
        this.children.push(child);
        if (child.tagName === 'SCRIPT') {
          calls.scripts.push(child);
          if (options.loadSDK !== false) queueMicrotask(() => { window.turnstile = sdk; child.emit('load'); });
        }
        return child;
      },
      remove() { this.removed = true; },
      addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
      emit(type) { for (const callback of [...listeners.get(type) || []]) callback(); }
    };
  }
  const existingScript = options.existingScript === true ? element('script') : options.existingScript;
  if (options.existingScript === true) existingScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__nolWorldTurnstileOnLoad&render=explicit';
  const document = {
    visibilityState: options.hidden ? 'hidden' : 'visible', head: element('head'), body: element('body'),
    createElement: element, querySelectorAll() { return existingScript ? [existingScript] : []; }
  };
  let currentURL = options.url || productURL;
  const location = { get href() { return currentURL; }, set href(url) { currentURL = url; calls.navigation.push(url); } };
  const sdk = {
    ready(callback) { calls.ready.push(callback); if (options.readySDK !== false) queueMicrotask(callback); },
    render(container, config) { calls.widgets.push({ container, config }); return 'widget-' + calls.widgets.length; },
    remove(id) { calls.removed.push(id); }
  };
  const window = { location, ...(options.sdk === false ? {} : { turnstile: sdk }) };
  async function fetch(url, init) {
    const call = { url: String(url), method: init.method || 'GET', headers: plain(init.headers), body: init.body, credentials: init.credentials, redirect: init.redirect, signal: init.signal };
    calls.requests.push(call);
    if (options.fetch) return options.fetch(call, calls.requests.length);
    const response = call.url.includes('/enter/token') ? { access_token: accessSecret, refresh_token: refreshSecret } : call.url.includes('/users/enter?') ? { enterHasEmail: true } : { uid: 'mock-user-id' };
    return { ok: true, status: 200, async json() { return response; } };
  }
  const context = vm.createContext({ window, document, URL, URLSearchParams, AbortController, Map, Date: ClockDate, fetch,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { log(...values) { calls.logs.push(values); }, error(...values) { calls.logs.push(values); } }
  });
  // Execute serialized functions in a fresh page world, without any NolHelper.
  const start = vm.runInContext(entrySource, context);
  const cancel = vm.runInContext(cancelSource, context);
  return { start, cancel, context, calls, document, window, clock, sdk, timers, existingScript,
    restoreURL() { currentURL = productURL; },
    timeout(ms) { const timer = [...timers.values()].find((value) => value.ms === ms); assert.ok(timer, 'expected scheduled timeout'); timer.callback(); }
  };
}

async function until(check) {
  for (let i = 0; i < 40; i += 1) { if (check()) return; await Promise.resolve(); }
  assert.ok(check(), 'async stage did not start');
}
const postCount = (h) => h.calls.requests.filter((call) => call.method === 'POST').length;

test('serialized entry rejects wrong URL, product, dates and background page without any request', async () => {
  for (const [options, config, code] of [
    [{ url: productURL.replace('https:', 'http:') }, payload(), 'ENTRY_PAGE_MISMATCH'],
    [{ url: productURL.replace('world.nol.com', 'world.nol.com.evil.test') }, payload(), 'ENTRY_PAGE_MISMATCH'],
    [{}, payload({ goodsCode: '99999990' }), 'ENTRY_PAGE_MISMATCH'],
    [{}, payload({ openAt: baseTime + 1 }), 'ENTRY_BEFORE_OPEN'],
    [{}, payload({ openAt: baseTime - 1, endAt: baseTime }), 'ENTRY_SALE_ENDED'],
    [{}, payload({ endAt: '2026-10-12 20:00:00' }), 'ENTRY_INVALID_CONFIG'],
    [{ hidden: true }, payload(), 'ENTRY_PAGE_NOT_VISIBLE']
  ]) {
    const h = harness(options);
    assert.equal((await h.start(config)).code, code);
    assert.equal(h.calls.requests.length, 0);
  }
});

test('normal SDK callback submits once, follows exact official gate and exposes no secrets in result or registry', async () => {
  const h = harness();
  const pending = h.start(payload());
  await until(() => h.calls.widgets.length === 1);
  assert.equal(postCount(h), 0, 'wait for actual challenge completion');
  assert.deepEqual(h.calls.requests[0].headers, { 'X-Service-Origin': 'global', 'X-Triple-User-Lang': 'zh-CN' });
  assert.equal(h.calls.requests[0].credentials, 'same-origin');
  assert.match(h.calls.requests[0].url, /goods_code=26013793&place_code=26001167$/);
  assert.equal(h.calls.requests[1].url, 'https://world.nol.com/api/users');
  const config = h.calls.widgets[0].config;
  assert.equal(config.sitekey, '0x4AAAAAACXBa0-HrwgZXh6u');
  assert.equal(config.appearance, 'interaction-only');
  assert.equal(config['response-field'], false);
  assert.equal(Object.hasOwn(config, 'action'), false);
  config.callback(captchaSecret);
  config.callback('DUPLICATE_TOKEN_MUST_NOT_SUBMIT');
  const result = plain(await pending);
  assert.deepEqual(result, { submitted: true, code: 'ENTRY_REDIRECTING' });
  assert.equal(postCount(h), 1);
  const post = h.calls.requests.at(-1);
  assert.equal(post.url, 'https://world.nol.com/api/users/enter/token');
  assert.deepEqual(post.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(post.body), { goodsCode: '26013793', placeCode: '26001167', turnstileToken: captchaSecret });
  const gate = new URL(h.calls.navigation[0]);
  assert.equal(gate.origin + gate.pathname, 'https://tickets.interpark.com/gates/partner');
  assert.deepEqual(Object.fromEntries(gate.searchParams), { gc: '26013793', pc: '26001167', bc: '10965', cc: 'gates_global', lg: 'zh', partner_token: accessSecret, partner_token_r: refreshSecret, user_id: 'mock-user-id' });
  const exposed = JSON.stringify({ result, registryRuns: [...h.window.__nolWorldHelperEntryApiV1.runs], logs: h.calls.logs });
  for (const secret of [captchaSecret, accessSecret, refreshSecret]) assert.equal(exposed.includes(secret), false);
  assert.equal(h.calls.logs.length, 0);
  assert.equal(h.document.body.children[0].removed, true);
  assert.deepEqual(h.calls.removed, ['widget-1']);
  h.restoreURL();
  assert.equal((await h.start(payload())).code, 'ENTRY_ALREADY_ATTEMPTED');
  assert.equal(postCount(h), 1);
  assert.equal(h.timers.size, 0);
});

test('login, email and unknown status pause before any verification or POST', async () => {
  for (const [status, body, code] of [
    [401, {}, 'ENTRY_LOGIN_REQUIRED'],
    [404, {}, 'ENTRY_EMAIL_REQUIRED'],
    [400, { errorCode: 'ENTER_EMAIL_NOT_FOUND' }, 'ENTRY_EMAIL_REQUIRED'],
    [200, { enterHasEmail: false }, 'ENTRY_EMAIL_REQUIRED'],
    [200, { unexpected: true }, 'ENTRY_STATUS_UNKNOWN'],
    [503, {}, 'ENTRY_STATUS_UNKNOWN']
  ]) {
    const h = harness({ fetch: async () => ({ status, ok: status === 200, json: async () => body }) });
    assert.equal((await h.start(payload())).code, code);
    assert.equal(postCount(h), 0);
    assert.equal(h.calls.widgets.length, 0);
    assert.equal(h.calls.requests.length, 1);
  }
});

test('an already running task cannot render or submit a second challenge', async () => {
  const h = harness();
  const pending = h.start(payload());
  await until(() => h.calls.widgets.length === 1);
  assert.equal((await h.start(payload())).code, 'ENTRY_ALREADY_STARTED');
  assert.equal((await h.start(payload({ runId: 'another-run' }))).code, 'ENTRY_OTHER_RUN_ACTIVE');
  assert.equal(h.calls.widgets.length, 1);
  h.cancel('run-one');
  assert.equal((await pending).code, 'ENTRY_CANCELLED');
});

test('cancel while waiting for verification removes the widget and never submits, including late callbacks', async () => {
  const h = harness();
  const pending = h.start(payload());
  await until(() => h.calls.widgets.length === 1);
  assert.deepEqual(plain(h.cancel('run-one')), { cancelled: true, submitted: false, code: 'ENTRY_CANCELLED' });
  assert.deepEqual(plain(await pending), { submitted: false, code: 'ENTRY_CANCELLED' });
  h.calls.widgets[0].config.callback(captchaSecret);
  await Promise.resolve();
  assert.equal(postCount(h), 0);
  assert.deepEqual(h.calls.removed, ['widget-1']);
  assert.equal(h.document.body.children[0].removed, true);
  assert.equal((await h.start(payload())).code, 'ENTRY_ALREADY_STARTED');
});

test('page identity and sale window are checked again after the human challenge', async () => {
  for (const mutation of [
    (h) => { h.window.location.href = productURL.replace('26013793', '99999990'); },
    (h) => { h.clock.now = baseTime + 600000; },
    (h) => { h.document.visibilityState = 'hidden'; }
  ]) {
    const h = harness();
    const pending = h.start(payload());
    await until(() => h.calls.widgets.length === 1);
    mutation(h);
    h.calls.widgets[0].config.callback(captchaSecret);
    assert.equal((await pending).submitted, false);
    assert.equal(postCount(h), 0);
  }
});

test('failed, malformed and ambiguous token responses retain the attempted POST and never retry', async () => {
  for (const postResponse of [
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, status: 200, json: async () => ({ access_token: accessSecret }) }),
    async () => { throw new Error('transport failed with sensitive body'); }
  ]) {
    const h = harness({ fetch: async (call) => call.method === 'POST' ? postResponse() : ({ ok: true, status: 200, json: async () => call.url.includes('/enter?') ? { enterHasEmail: true } : {} }) });
    const pending = h.start(payload());
    await until(() => h.calls.widgets.length === 1);
    h.calls.widgets[0].config.callback(captchaSecret);
    assert.deepEqual(plain(await pending), { submitted: true, code: 'ENTRY_RESPONSE_UNKNOWN' });
    assert.equal((await h.start(payload())).code, 'ENTRY_ALREADY_ATTEMPTED');
    assert.equal(postCount(h), 1);
    assert.equal(h.calls.navigation.length, 0);
  }
});

test('a stalled POST is bounded even if fetch ignores abort; cancel after submit retains the single attempt', async () => {
  for (const cancel of [false, true]) {
    const h = harness({ fetch: async (call) => call.method === 'POST' ? new Promise(() => {}) : ({ ok: true, status: 200, json: async () => call.url.includes('/enter?') ? { enterHasEmail: true } : {} }) });
    const pending = h.start(payload());
    await until(() => h.calls.widgets.length === 1);
    h.calls.widgets[0].config.callback(captchaSecret);
    await until(() => postCount(h) === 1);
    if (cancel) assert.equal(h.cancel('run-one').submitted, true);
    else h.timeout(15000);
    assert.deepEqual(plain(await pending), { submitted: true, code: cancel ? 'ENTRY_CANCELLED' : 'ENTRY_RESPONSE_UNKNOWN' });
    assert.equal((await h.start(payload())).code, 'ENTRY_ALREADY_ATTEMPTED');
    assert.equal(h.calls.requests.at(-1).signal.aborted, true);
    assert.equal(postCount(h), 1);
    assert.equal(h.timers.size, 0);
  }
});

test('SDK loads only the official script; stalled or cancelled SDK loading makes no POST', async () => {
  const h = harness({ sdk: false });
  const pending = h.start(payload());
  await until(() => h.calls.widgets.length === 1);
  assert.equal(h.calls.scripts.length, 1);
  assert.equal(h.calls.scripts[0].src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  h.calls.widgets[0].config.callback(captchaSecret);
  assert.equal((await pending).code, 'ENTRY_REDIRECTING');
  for (const cancel of [false, true]) {
    const stalled = harness({ sdk: false, loadSDK: false });
    const waiting = stalled.start(payload());
    await until(() => stalled.calls.scripts.length === 1);
    if (cancel) stalled.cancel('run-one'); else stalled.timeout(10000);
    assert.equal((await waiting).code, cancel ? 'ENTRY_CANCELLED' : 'ENTRY_SDK_LOAD_TIMEOUT');
    assert.equal(postCount(stalled), 0);
    assert.equal(stalled.calls.scripts[0].removed, true);
    assert.equal(stalled.timers.size, 0);
  }
});

test('a preloaded SDK waits for its ready callback before rendering or submitting', async () => {
  const h = harness({ readySDK: false });
  const pending = h.start(payload());
  await until(() => h.calls.ready.length === 1);
  assert.equal(h.calls.widgets.length, 0);
  assert.equal(postCount(h), 0);
  assert.equal(h.calls.scripts.length, 0);
  h.calls.ready[0]();
  await until(() => h.calls.widgets.length === 1);
  h.calls.widgets[0].config.callback(captchaSecret);
  assert.equal((await pending).code, 'ENTRY_REDIRECTING');
  assert.equal(postCount(h), 1);
  assert.equal(h.timers.size, 0);
});

test('script load before the SDK object keeps waiting within the original deadline', async () => {
  const h = harness({ sdk: false, loadSDK: false });
  const pending = h.start(payload());
  await until(() => h.calls.scripts.length === 1);
  const deadline = [...h.timers.entries()].find(([, timer]) => timer.ms === 10000);
  h.calls.scripts[0].emit('load');
  assert.equal(h.calls.widgets.length, 0);
  assert.equal(h.timers.get(deadline[0]), deadline[1], 'load must not restart the deadline');
  h.window.turnstile = h.sdk;
  h.timeout(50);
  await until(() => h.calls.widgets.length === 1);
  h.calls.widgets[0].config.callback(captchaSecret);
  assert.equal((await pending).code, 'ENTRY_REDIRECTING');
  assert.equal(postCount(h), 1);
  assert.equal(h.calls.scripts.length, 1);
  assert.equal(h.timers.size, 0);
});

test('an existing website script is observed without changing its URL or onload callback', async () => {
  const h = harness({ sdk: false, existingScript: true });
  const websiteCallback = () => {};
  h.window.__nolWorldTurnstileOnLoad = websiteCallback;
  h.existingScript.onload = websiteCallback;
  const src = h.existingScript.src;
  const pending = h.start(payload());
  await until(() => [...h.timers.values()].some(timer => timer.ms === 10000));
  h.window.turnstile = h.sdk;
  h.existingScript.emit('load');
  await until(() => h.calls.widgets.length === 1);
  h.calls.widgets[0].config.callback(captchaSecret);
  assert.equal((await pending).code, 'ENTRY_REDIRECTING');
  assert.equal(h.calls.scripts.length, 0);
  assert.equal(h.existingScript.src, src);
  assert.equal(h.existingScript.onload, websiteCallback);
  assert.equal(h.window.__nolWorldTurnstileOnLoad, websiteCallback);
  assert.equal(h.existingScript.removed, false);
  assert.equal(h.timers.size, 0);
});

test('an existing script whose load event already happened can become ready later without reloading', async () => {
  const h = harness({ sdk: false, existingScript: true });
  h.existingScript.emit('load');
  const pending = h.start(payload());
  await until(() => [...h.timers.values()].some(timer => timer.ms === 50));
  h.window.turnstile = h.sdk;
  h.timeout(50);
  await until(() => h.calls.widgets.length === 1);
  h.calls.widgets[0].config.callback(captchaSecret);
  assert.equal((await pending).code, 'ENTRY_REDIRECTING');
  assert.equal(h.calls.scripts.length, 0);
  assert.equal(h.existingScript.removed, false);
  assert.equal(postCount(h), 1);
  assert.equal(h.timers.size, 0);
});

test('SDK script errors and readiness timeout have distinct codes, no POST and no retry', async () => {
  for (const mode of ['script-error', 'ready-timeout']) {
    const h = harness(mode === 'script-error' ? { sdk: false, loadSDK: false } : { readySDK: false });
    const pending = h.start(payload());
    if (mode === 'script-error') {
      await until(() => h.calls.scripts.length === 1);
      h.calls.scripts[0].emit('error');
    } else {
      await until(() => h.calls.ready.length === 1);
      h.timeout(10000);
    }
    assert.deepEqual(plain(await pending), { submitted: false, code: mode === 'script-error' ? 'ENTRY_SDK_LOAD_FAILED' : 'ENTRY_SDK_READY_TIMEOUT' });
    assert.equal(postCount(h), 0);
    assert.equal(h.calls.widgets.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal((await h.start(payload())).code, 'ENTRY_ALREADY_STARTED');
    if (mode === 'ready-timeout') h.calls.ready[0]();
    else h.calls.scripts[0].emit('load');
    await Promise.resolve();
    assert.equal(h.calls.widgets.length, 0);
    assert.equal(postCount(h), 0);
  }
});

test('cancelling SDK readiness or existing-script polling clears timers and ignores late completion', async () => {
  for (const mode of ['ready', 'poll']) {
    const h = harness(mode === 'ready' ? { readySDK: false } : { sdk: false, existingScript: true });
    const pending = h.start(payload());
    await until(() => mode === 'ready' ? h.calls.ready.length === 1 : [...h.timers.values()].some(timer => timer.ms === 50));
    const late = mode === 'ready' ? h.calls.ready[0] : [...h.timers.values()].find(timer => timer.ms === 50).callback;
    assert.equal(h.cancel('run-one').submitted, false);
    assert.deepEqual(plain(await pending), { submitted: false, code: 'ENTRY_CANCELLED' });
    assert.equal(h.timers.size, 0);
    h.window.turnstile = h.sdk;
    late();
    if (h.existingScript) h.existingScript.emit('load');
    await Promise.resolve();
    assert.equal(h.calls.widgets.length, 0);
    assert.equal(postCount(h), 0);
    assert.equal(h.calls.scripts.length, 0);
    if (h.existingScript) assert.equal(h.existingScript.removed, false);
  }
});

test('synchronous SDK ready and widget render failures expose only fixed separate codes', async () => {
  for (const phase of ['ready', 'render']) {
    const h = harness();
    h.sdk[phase] = () => { throw new Error('SENSITIVE_SDK_INTERNAL_DETAIL'); };
    const result = plain(await h.start(payload()));
    assert.deepEqual(result, { submitted: false, code: phase === 'ready' ? 'ENTRY_SDK_UNAVAILABLE' : 'ENTRY_WIDGET_INIT_FAILED' });
    assert.equal(JSON.stringify(result).includes('SENSITIVE'), false);
    assert.equal(postCount(h), 0);
    assert.equal(h.calls.scripts.length, 0);
    assert.equal(h.calls.logs.length, 0);
    assert.equal(h.timers.size, 0);
    if (phase === 'render') assert.equal(h.document.body.children[0].removed, true);
  }
});

test('verification failure and overall human timeout pause without a POST', async () => {
  for (const outcome of ['error-callback', 'expired-callback', 'timeout']) {
    const h = harness();
    const pending = h.start(payload());
    await until(() => h.calls.widgets.length === 1);
    if (outcome === 'timeout') h.timeout(180000);
    else h.calls.widgets[0].config[outcome]('ignored-detail');
    const result = await pending;
    assert.equal(result.submitted, false);
    assert.equal(postCount(h), 0);
    assert.equal(h.calls.logs.length, 0);
  }
});
