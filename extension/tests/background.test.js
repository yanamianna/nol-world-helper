'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extension = path.resolve(__dirname, '..');
const baseTime = Date.parse('2026-10-07T11:00:00.000Z');
const productUrl = 'https://world.nol.com/zh-CN/ticket/places/26001167/products/26013792';
const html = fs.readFileSync(path.join(__dirname, 'fixtures/product.html'), 'utf8');
const runtime = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/product-runtime.json'), 'utf8'));
const capturedSales = runtime.responses.find((response) => response.url.includes('/goods/salesinfo?')).json;
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function profile() {
  return { id: 'profile-1', label: 'PRIVATE_CONTACT_SENTINEL', lastName: 'PrivateLastName', firstName: 'PrivateFirstName', email: 'private-sentinel@example.test', phone: '123456789', countryCode: '+86' };
}

function task(id = 'task-1', openAt = baseTime) {
  return { id, name: 'fixture task', productUrl, goodsCode: '26013792', placeCode: '26001167', productName: '', kind: 'package', stage: 'general', openAt: new Date(openAt).toISOString(), quantity: 1, maxTotal: 2000000, currency: 'KRW', profileId: 'profile-1', alternatives: [{ date: '2026-10-30', time: '19:00', packageLabel: 'INSPIRE Entertainment Resort (2 People)', seatGrade: '1', priceGrade: 'U1', people: 2, zones: [] }] };
}

function armedState(overrides = {}) {
  return { profiles: [profile()], tasks: [task()], run: { id: 'run-1', taskId: 'task-1', tabId: 23, status: 'armed', step: '等待开票', reason: '', openAt: new Date(baseTime).toISOString(), entryClaimed: false, entryClicked: false, events: [], updatedAt: baseTime, heartbeatAt: 0, ...overrides } };
}

function event() {
  const listeners = [];
  return { addListener(listener) { listeners.push(listener); }, async emit(...arguments_) { return Promise.all(listeners.map((listener) => listener(...arguments_))); }, listeners };
}

function harness(initial = armedState(), options = {}) {
  const clock = { now: options.now === undefined ? baseTime : options.now };
  class ControlledDate extends Date {
    constructor(...arguments_) { super(...(arguments_.length ? arguments_ : [clock.now])); }
    static now() { return clock.now; }
  }
  const database = initial === null ? {} : { nolHelperState: copy(initial) };
  const calls = { fetch: [], writes: [], messages: [], clearAlarms: [], createAlarms: [], createTabs: [], accessLevels: [], options: 0 };
  const tabs = new Map([[23, { id: 23, windowId: 5, active: options.active !== false, url: productUrl }]]);
  let nextTab = 24;
  let nextId = 1;
  const chrome = {
    storage: { local: {
      async setAccessLevel(value) { calls.accessLevels.push(copy(value)); },
      async get(key) { return { [key]: copy(database[key]) }; },
      async set(values) { Object.assign(database, copy(values)); calls.writes.push(copy(values)); },
      async remove(key) { delete database[key]; }
    } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    runtime: {
      id: 'test-extension',
      getURL(relative) { return 'chrome-extension://test-extension/' + relative; },
      getManifest() { return { version: '0.1.0' }; },
      async openOptionsPage() { calls.options += 1; },
      onMessage: event(), onStartup: event(), onInstalled: event()
    },
    tabs: {
      async create(value) { const tab = { id: nextTab++, windowId: 5, ...value }; tabs.set(tab.id, tab); calls.createTabs.push(copy(tab)); return copy(tab); },
      async get(id) { if (!tabs.has(id)) throw new Error('tab absent'); return copy(tabs.get(id)); },
      async update(id, value) { const tab = tabs.get(id); if (!tab) throw new Error('tab absent'); Object.assign(tab, value); return copy(tab); },
      async sendMessage(tabId, value) { calls.messages.push({ tabId, value: copy(value) }); },
      onRemoved: event(), onUpdated: event()
    },
    windows: { async get(id) { return { id, focused: options.focused !== false }; } },
    alarms: {
      async clear(name) { calls.clearAlarms.push(name); return true; },
      async create(name, value) { calls.createAlarms.push({ name, value: copy(value) }); },
      onAlarm: event()
    }
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, AbortController, Date: ControlledDate, setTimeout, clearTimeout,
    crypto: { randomUUID() { return 'generated-id-' + nextId++; } },
    async fetch(url, settings = {}) {
      calls.fetch.push({ url: String(url), credentials: settings.credentials, redirect: settings.redirect, headers: copy(settings.headers || {}), method: settings.method || 'GET' });
      if (String(url) === productUrl) {
        if (options.productBarrier) await options.productBarrier;
        return { ok: true, status: 200, async text() { return options.productHtml === undefined ? html : options.productHtml; } };
      }
      if (String(url).startsWith('https://world.nol.com/api/ent-channel-out/v1/goods/salesinfo?')) return { ok: true, status: 200, async json() { return copy(capturedSales); } };
      throw new Error('Unexpected network request: ' + url);
    }
  });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(extension, file), 'utf8'), context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  const ui = { url: chrome.runtime.getURL('options.html'), id: chrome.runtime.id };
  const site = { url: productUrl, id: chrome.runtime.id, tab: { id: 23 }, frameId: 0 };
  function send(message, sender = ui) {
    return new Promise((resolve, reject) => {
      try { chrome.runtime.onMessage.listeners[0](copy(message), copy(sender), resolve); } catch (error) { reject(error); }
    });
  }
  return { chrome, calls, database, clock, ui, site, send, state: () => copy(database.nolHelperState) };
}

test('settings-only messages require the actual extension origin, while the assigned site gets only task context', async () => {
  const h = harness();
  const state = await h.send({ type: 'GET_STATE' });
  assert.equal(state.ok, true);
  assert.equal(state.data.profiles[0].email, profile().email);
  assert.equal(state.data.tasks[0].maxTotal, null, 'legacy saved budgets must also become unlimited');
  for (const type of ['GET_STATE', 'ARM', 'SAVE_PROFILE', 'DELETE_ALL', 'READ_PRODUCT', 'OPEN_OPTIONS']) {
    const denied = await h.send({ type, taskId: 'task-1', url: productUrl }, h.site);
    assert.equal(denied.ok, false, type);
  }
  const siteContext = await h.send({ type: 'GET_CONTEXT' }, h.site);
  assert.equal(siteContext.ok, true);
  assert.equal(siteContext.data.task.id, 'task-1');
  assert.equal(siteContext.data.task.maxTotal, null);
  assert.equal(JSON.stringify(siteContext.data).includes(profile().email), false);
  assert.equal(JSON.stringify(siteContext.data).includes(profile().lastName), false);
  for (const sender of [{ url: 'chrome-extension://test-extension.evil/options.html' }, { ...h.site, url: 'https://world.nol.com.evil.test/zh-CN/ticket' }, { ...h.site, tab: { id: 99 } }]) {
    const denied = await h.send({ type: 'GET_STATE' }, sender);
    assert.equal(denied.ok, false);
    assert.equal((await h.send({ type: 'GET_CONTEXT' }, sender)).data, null);
  }
  assert.deepEqual(h.calls.accessLevels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.equal(h.calls.fetch.length, 0);
});

test('a second task cannot arm while any active, paused or manual run owns the browser', async () => {
  for (const status of ['armed', 'running', 'paused', 'waiting-manual']) {
    const initial = armedState({ status });
    initial.tasks.push(task('task-2', baseTime + 60000));
    const h = harness(initial);
    const result = await h.send({ type: 'ARM', taskId: 'task-2' });
    assert.equal(result.ok, false, status);
    assert.match(result.error, /已有活动任务/);
    assert.equal(h.calls.createTabs.length, 0);
    assert.equal(h.state().run.taskId, 'task-1');
  }
  const initial = armedState({ status: 'stopped' });
  initial.tasks.push(task('task-2', baseTime + 60000));
  const h = harness(initial);
  assert.equal((await h.send({ type: 'ARM', taskId: 'task-2' })).ok, true);
  assert.equal(h.state().run.taskId, 'task-2');
  assert.equal(h.calls.createTabs.length, 1);
});

test('simultaneous entry claims are serialized and persist exactly one success', async () => {
  const h = harness();
  const claim = { type: 'CLAIM_ENTRY', runId: 'run-1', visible: true, lastTick: baseTime - 100 };
  const results = await Promise.all([h.send(claim, h.site), h.send(claim, h.site)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  const saved = h.state().run;
  assert.equal(saved.entryClaimed, true);
  assert.equal(saved.status, 'running');
  assert.equal(saved.triggerAt, baseTime);
  assert.equal(saved.events.length, 1);
  assert.equal(h.calls.writes.length, 1);
});

test('pause and stop revoke future claims, including queued requests', async () => {
  for (const type of ['PAUSE', 'STOP']) {
    const h = harness();
    const replies = await Promise.all([h.send({ type }, type === 'PAUSE' ? h.site : h.ui), h.send({ type: 'CLAIM_ENTRY', runId: 'run-1', visible: true, lastTick: baseTime }, h.site)]);
    assert.equal(replies[0].ok, true);
    assert.equal(replies[1].ok, false);
    assert.equal(h.state().run.entryClaimed, false);
    assert.equal(h.state().run.status, type === 'PAUSE' ? 'paused' : 'stopped');
  }
});

test('not-yet-open, expired, interrupted, hidden and unfocused pages cannot claim an entry', async () => {
  for (const [options, messageChanges] of [[{ now: baseTime - 1 }, {}], [{ now: baseTime + 5001 }, {}], [{ now: baseTime + 1000 }, { lastTick: baseTime - 1501 }], [{ active: false }, {}], [{ focused: false }, {}], [{}, { visible: false }]]) {
    const h = harness(armedState(), options);
    const reply = await h.send({ type: 'CLAIM_ENTRY', runId: 'run-1', visible: true, lastTick: h.clock.now - 100, ...messageChanges }, h.site);
    assert.equal(reply.ok, false, JSON.stringify({ options, messageChanges }));
    assert.equal(h.state().run.entryClaimed, false);
    assert.equal(h.calls.writes.length, 0);
  }
});

test('browser startup pauses the saved run and clears alarms without replaying its entry', async () => {
  const h = harness();
  await h.chrome.runtime.onStartup.emit();
  const state = await h.send({ type: 'GET_STATE' });
  assert.equal(state.data.run.status, 'paused');
  assert.equal(state.data.run.entryClaimed, false);
  assert.deepEqual(h.calls.clearAlarms, ['warm:run-1', 'deadline:run-1']);
  assert.equal(h.calls.createTabs.length, 0);
  assert.equal((await h.send({ type: 'CLAIM_ENTRY', runId: 'run-1', visible: true, lastTick: baseTime }, h.site)).ok, false);
});

test('delete-all removes contacts and gives the existing content script no run context', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'DELETE_ALL' })).ok, true);
  assert.equal(h.state(), undefined);
  const context = await h.send({ type: 'GET_CONTEXT' }, h.site);
  assert.equal(context.ok, true);
  assert.equal(context.data, null);
  assert.equal((await h.send({ type: 'CLAIM_ENTRY', runId: 'run-1', visible: true, lastTick: baseTime }, h.site)).ok, false);
  assert.ok(h.calls.messages.some((message) => message.tabId === 23 && message.value.type === 'CONTEXT_CHANGED'));
});

test('public product reads use only captured public data, omit credentials and never return saved contacts', async () => {
  const h = harness();
  const before = h.state();
  const response = await h.send({ type: 'READ_PRODUCT', url: productUrl });
  assert.equal(response.ok, true);
  assert.equal(response.data.goodsCode, '26013792');
  assert.equal(response.data.prices.length, 24);
  assert.equal(response.data.opening.general, '2026-10-12T11:00:00.000Z');
  assert.equal(response.data.opening.presale, '2026-10-08T11:00:00.000Z');
  const serialized = JSON.stringify(response.data);
  for (const secret of [profile().email, profile().phone, profile().label, profile().lastName]) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(h.state(), before);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.fetch.length, 2);
  for (const request of h.calls.fetch) {
    assert.equal(request.method, 'GET');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'error');
    assert.equal(Object.keys(request.headers).some((name) => /cookie|authorization/i.test(name)), false);
    assert.equal(/users\/|token|waiting|gates\//.test(request.url), false);
  }
});

test('an unverified booking page is a manual stop, not a report of reaching payment', async () => {
  const h = harness(armedState({ status: 'running', entryClaimed: true, entryClicked: true }));
  const gateSender = { ...h.site, url: 'https://ticket.globalinterpark.com/Global/Play/Book/BookMain.asp' };
  const reply = await h.send({ type: 'PAGE_STATE', runId: 'run-1', status: 'manual', reason: '实际预约控件尚未验证' }, gateSender);
  assert.equal(reply.ok, true);
  assert.equal(h.state().run.status, 'waiting-manual');
  assert.equal(h.state().run.entryClicked, true);
  assert.equal(h.state().run.status === 'payment', false);
  assert.equal((await h.send({ type: 'CLAIM_ENTRY', runId: 'run-1', visible: true, lastTick: baseTime }, h.site)).ok, false);
});

test('a slow public product read never holds the serialized opening-time entry claim', async () => {
  let releaseProduct;
  const productBarrier = new Promise((resolve) => { releaseProduct = resolve; });
  const h = harness(armedState(), { productBarrier });
  const reading = h.send({ type: 'READ_PRODUCT', url: productUrl });
  const claiming = h.send({ type: 'CLAIM_ENTRY', runId: 'run-1', visible: true, lastTick: baseTime }, h.site);
  let timer;
  const claimBeforeRead = await Promise.race([claiming, new Promise((resolve) => { timer = setTimeout(() => resolve({ blocked: true }), 200); })]);
  clearTimeout(timer);
  releaseProduct();
  const product = await reading;
  await claiming;
  assert.equal(claimBeforeRead.ok, true, 'public network reads must not block the entry queue');
  assert.equal(product.ok, true);
  assert.equal(h.state().run.entryClaimed, true);
});
