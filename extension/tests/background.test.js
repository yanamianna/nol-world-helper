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
  return { id, name: 'fixture task', productUrl, goodsCode: '26013792', placeCode: '26001167', productName: '', kind: 'package', stage: 'general', openAt: new Date(openAt).toISOString(), openAtSource: 'official', officialEndAt: '2026-10-31T02:00:59.000Z', quantity: 1, maxTotal: 2000000, currency: 'KRW', profileId: 'profile-1', alternatives: [{ date: '2026-10-30', time: '19:00', packageLabel: 'INSPIRE Entertainment Resort (2 People)', seatGrade: '1', priceGrade: 'U1', people: 2, zones: [] }] };
}

function armedState(overrides = {}) {
  return { profiles: [profile()], tasks: [task()], run: { id: 'run-1', taskId: 'task-1', tabId: 23, status: 'armed', step: '等待开票', reason: '', openAt: new Date(baseTime).toISOString(), officialOpenAt: new Date(baseTime).toISOString(), officialEndAt: '2026-10-31T02:00:59.000Z', entryClaimed: false, entryClicked: false, entryAttempted: false, entrySubmitted: false, events: [], updatedAt: baseTime, heartbeatAt: 0, ...overrides } };
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
  const calls = { fetch: [], writes: [], messages: [], clearAlarms: [], createAlarms: [], createTabs: [], accessLevels: [], scripts: [], permissions: [], options: 0 };
  const tabs = new Map([[23, { id: 23, windowId: 5, active: options.active !== false, url: options.tabUrl || productUrl }]]);
  let nextTab = 24;
  let nextId = 1;
  let resolveScriptStarted;
  const scriptStarted = new Promise((resolve) => { resolveScriptStarted = resolve; });
  const chrome = {
    permissions: { async contains(value) { calls.permissions.push(copy(value)); return options.ocrPermission===true; } },
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
    webNavigation: {onErrorOccurred: event(),async getFrame() {return {documentId:options.documentId};}},
    tabs: {
      async create(value) { const tab = { id: nextTab++, windowId: 5, ...value }; tabs.set(tab.id, tab); calls.createTabs.push(copy(tab)); return copy(tab); },
      async get(id) { if (!tabs.has(id)) throw new Error('tab absent'); return copy(tabs.get(id)); },
      async update(id, value) { const tab = tabs.get(id); if (!tab) throw new Error('tab absent'); Object.assign(tab, value); return copy(tab); },
      async sendMessage(tabId, value) { calls.messages.push({ tabId, value: copy(value) }); },
      onRemoved: event(), onUpdated: event()
    },
    windows: { async get(id) { return { id, focused: options.focused !== false }; } },
    scripting: {
      async executeScript(value) {
        calls.scripts.push(value);
        resolveScriptStarted(true);
        if (options.scriptBarrier && calls.scripts.length === 1) await options.scriptBarrier;
        if (options.scriptError) throw new Error(options.scriptError);
        return [{result: copy(options.scriptResult === undefined ? {submitted: true, code: 'ENTRY_REDIRECTING'} : options.scriptResult)}];
      }
    },
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
      calls.fetch.push({ url: String(url), credentials: settings.credentials, redirect: settings.redirect, headers: copy(settings.headers || {}), method: settings.method || 'GET', body: settings.body });
      if (String(url).startsWith('http://127.0.0.1:8765/')) {
        if (options.ocrFetchError) throw options.ocrFetchError;
        const data=options.ocrResponse===undefined ? (String(url).endsWith('/health')?{ok:true,engine:'ddddocr'}:{ok:true,recognized:true,candidate:'ABCDEF'}) : options.ocrResponse;
        return {ok:options.ocrHTTP===undefined || options.ocrHTTP===200,status:options.ocrHTTP || 200,async text() {return options.ocrText===undefined ? JSON.stringify(data) : options.ocrText;},async json() {throw new Error('OCR client must read and bound Response.text');}};
      }
      if (String(url) === productUrl) {
        if (options.productBarrier) await options.productBarrier;
        return { ok: true, status: 200, async text() { return options.productHtml === undefined ? html : options.productHtml; } };
      }
      if (String(url).startsWith('https://world.nol.com/api/ent-channel-out/v1/goods/salesinfo?')) {
        if (options.salesError) throw new Error(options.salesError);
        return {ok: options.salesHTTP === undefined || options.salesHTTP === 200, status: options.salesHTTP || 200, async json() { return copy(options.sales === undefined ? capturedSales : options.sales); }};
      }
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
  return { chrome, calls, database, clock, ui, site, send, scriptStarted, tabs, state: () => copy(database.nolHelperState) };
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
  assert.deepEqual(h.calls.clearAlarms, ['warm:run-1', 'deadline:run-1', 'sale:run-1']);
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
  assert.equal(response.data.opening.generalEnd, '2026-10-31T02:00:59.000Z');
  assert.equal(response.data.presaleChoices.length, 1);
  assert.equal(response.data.presaleChoices[0].seq, '170194');
  assert.equal(response.data.presaleChoices[0].openAt, '2026-10-08T11:00:00.000Z');
  assert.equal(response.data.presaleChoices[0].endAt, '2026-10-08T14:59:00.000Z');
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

test('SAVE_TASK ignores forged manual time and saves freshly read official sales bounds', async () => {
  const h = harness(armedState({status: 'stopped'}));
  const forged = {...task(), openAt: '2099-01-01T00:00:00.000Z', openAtSource: 'manual', officialEndAt: '2099-12-31T00:00:00.000Z', metadata: {opening: {general: '2099-01-01T00:00:00.000Z'}}};
  const saved = await h.send({type: 'SAVE_TASK', task: forged});
  assert.equal(saved.ok, true);
  assert.equal(saved.data.openAt, '2026-10-12T11:00:00.000Z');
  assert.equal(saved.data.officialEndAt, '2026-10-31T02:00:59.000Z');
  assert.equal(saved.data.openAtSource, 'official');
  assert.equal(h.state().tasks[0].openAt, saved.data.openAt);
  assert.equal(h.calls.fetch.length, 2);
});

test('ARM rereads official sales instead of using an old manual task or previously saved time', async () => {
  const initial = armedState({status: 'stopped'});
  initial.tasks[0].openAtSource = 'manual';
  initial.tasks[0].openAt = '2099-01-01T00:00:00.000Z';
  const sales = copy(capturedSales);
  sales.data.salesInfo.bookingOpenTime = '2026-10-13 20:00:00';
  const h = harness(initial, {sales});
  const armed = await h.send({type: 'ARM', taskId: 'task-1'});
  assert.equal(armed.ok, true);
  assert.equal(armed.data.openAt, '2026-10-13T11:00:00.000Z');
  assert.equal(h.state().tasks[0].openAt, '2026-10-13T11:00:00.000Z');
  assert.equal(h.state().tasks[0].openAtSource, 'official');
  assert.equal(h.calls.fetch.length, 2);
  assert.equal(h.calls.createTabs.length, 1);
});

test('multiple presales require an explicit official seq at save and at arm', async () => {
  const sales = copy(capturedSales);
  sales.data.preSalesInfo.push({...sales.data.preSalesInfo[0], seq: 170195, buttonName: 'Second membership', bookingOpenTime: '2026-10-09 20:00:00', bookingEndTime: '2026-10-09 23:59:00'});
  for (const preSaleSeq of ['', 'not-official']) {
    const initial = armedState({status: 'stopped'});
    initial.tasks[0] = {...initial.tasks[0], stage: 'presale', preSaleSeq};
    const h = harness(initial, {sales});
    assert.equal((await h.send({type: 'SAVE_TASK', task: initial.tasks[0]})).ok, false);
    assert.equal((await h.send({type: 'ARM', taskId: 'task-1'})).ok, false);
    assert.equal(h.calls.createTabs.length, 0);
  }
  const initial = armedState({status: 'stopped'});
  initial.tasks[0] = {...initial.tasks[0], stage: 'presale', preSaleSeq: '170195'};
  const h = harness(initial, {sales});
  const saved = await h.send({type: 'SAVE_TASK', task: initial.tasks[0]});
  assert.equal(saved.ok, true);
  assert.equal(saved.data.preSaleSeq, '170195');
  assert.equal(saved.data.openAt, '2026-10-09T11:00:00.000Z');
  const armed = await h.send({type: 'ARM', taskId: 'task-1'});
  assert.equal(armed.ok, true);
  assert.equal(armed.data.openAt, saved.data.openAt);
});

test('sales API errors or missing official times never enable a task through fallback data', async () => {
  const missingOpen = copy(capturedSales);
  delete missingOpen.data.salesInfo.bookingOpenTime;
  const missingEnd = copy(capturedSales);
  delete missingEnd.data.salesInfo.bookingEndTime;
  for (const options of [{salesHTTP: 503}, {salesError: 'offline'}, {sales: missingOpen}, {sales: missingEnd}]) {
    const initial = armedState({status: 'stopped'});
    const before = copy(initial.tasks);
    const h = harness(initial, options);
    assert.equal((await h.send({type: 'SAVE_TASK', task: {...task(), openAt: '2099-01-01T00:00:00.000Z'}})).ok, false);
    assert.equal((await h.send({type: 'ARM', taskId: 'task-1'})).ok, false);
    assert.equal(h.calls.createTabs.length, 0);
    assert.equal(h.calls.scripts.length, 0);
    assert.equal(h.state().run.status, 'stopped');
    assert.equal(h.state().tasks[0].openAt, before[0].openAt);
  }
});

test('an already open official sale needs immediate mode and an ended sale cannot arm', async () => {
  const open = Date.parse('2026-10-12T11:00:00.000Z');
  const h = harness(armedState({status: 'stopped'}), {now: open + 1000});
  assert.equal((await h.send({type: 'ARM', taskId: 'task-1'})).ok, false);
  assert.equal(h.calls.createTabs.length, 0);
  assert.equal((await h.send({type: 'ARM', taskId: 'task-1', immediate: true})).ok, true);
  const expired = harness(armedState({status: 'stopped'}), {now: Date.parse('2026-10-31T02:01:00.000Z')});
  assert.equal((await expired.send({type: 'ARM', taskId: 'task-1', immediate: true})).ok, false);
  assert.equal(expired.calls.createTabs.length, 0);
});

test('the claimed official API entry submits once and stores no returned credentials', async () => {
  const token = 'PRIVATE_ENTRY_TOKEN_SENTINEL';
  const h = harness(armedState({status: 'running', entryClaimed: true}), {scriptResult: {submitted: true, code: 'ENTRY_REDIRECTING', token, partner_token: token}});
  const request = {type: 'API_ENTRY', runId: 'run-1'};
  const responses = await Promise.all([h.send(request, h.site), h.send(request, h.site)]);
  assert.equal(responses.filter((response) => response.ok).length, 1);
  assert.equal(h.calls.scripts.length, 1);
  assert.equal(h.calls.scripts[0].world, 'MAIN');
  assert.equal(h.calls.scripts[0].target.tabId, 23);
  assert.equal(h.state().run.entryAttempted, true);
  assert.equal(h.state().run.entrySubmitted, true);
  assert.equal(h.state().run.entryResultCode, 'ENTRY_REDIRECTING');
  assert.equal(JSON.stringify(h.state()).includes(token), false);
  assert.equal(JSON.stringify(responses).includes(token), false);
  assert.equal((await h.send(request, h.site)).ok, false);
  assert.equal(h.calls.scripts.length, 1);
});

test('API entry rejects wrong callers, unclaimed runs, paused tasks, early times and mismatched products', async () => {
  for (const [changes, options, senderChanges, requestChanges] of [
    [{entryClaimed: false}, {}, {}, {}],
    [{status: 'paused', entryClaimed: true}, {}, {}, {}],
    [{status: 'stopped', entryClaimed: true}, {}, {}, {}],
    [{entryClaimed: true, status: 'running'}, {now: baseTime - 1}, {}, {}],
    [{entryClaimed: true, status: 'running'}, {}, {url: productUrl.replace('26013792', '26013793')}, {}],
    [{entryClaimed: true, status: 'running'}, {}, {frameId: 1}, {}],
    [{entryClaimed: true, status: 'running'}, {}, {}, {runId: 'not-the-run'}]
  ]) {
    const h = harness(armedState(changes), options);
    const reply = await h.send({type: 'API_ENTRY', runId: 'run-1', ...requestChanges}, {...h.site, ...senderChanges});
    assert.equal(reply.ok, false, JSON.stringify({changes, options, senderChanges, requestChanges}));
    assert.equal(h.calls.scripts.length, 0);
  }
  const h = harness(armedState({status: 'running', entryClaimed: true}));
  assert.equal((await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.ui)).ok, false);
  assert.equal(h.calls.scripts.length, 0);
});

test('an unknown API result or scripting failure pauses for takeover without repeating the attempt', async () => {
  for (const options of [{scriptResult: {submitted: true, code: 'ENTRY_UNKNOWN_RESPONSE'}}, {scriptError: 'script disconnected'}]) {
    const h = harness(armedState({status: 'running', entryClaimed: true}), options);
    await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site);
    assert.equal(h.state().run.status, 'waiting-manual');
    assert.equal(h.state().run.apiDispatched, true);
    assert.equal(h.state().run.entryAttempted, !options.scriptError);
    assert.equal(h.state().run.entrySubmitted, false);
    assert.equal(h.state().run.entryResultCode, 'ENTRY_RESULT_UNKNOWN');
    assert.equal((await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site)).ok, false);
    assert.equal(h.calls.scripts.length, 1);
  }
});

test('entry failures retain their exact takeover reason through generic page checks and rejected resumes', async () => {
  for (const [code, expected] of [
    ['ENTRY_LOGIN_REQUIRED', /官网完成登录/],
    ['ENTRY_EMAIL_REQUIRED', /官网补全邮箱/],
    ['ENTRY_VERIFICATION_FAILED', /网站验证失败/],
    ['ENTRY_VERIFICATION_EXPIRED', /网站验证已过期/],
    ['ENTRY_SDK_UNAVAILABLE', /验证组件未能加载/],
    ['ENTRY_RESPONSE_UNKNOWN', /入场请求结果不明确/]
  ]) {
    const submitted = code === 'ENTRY_RESPONSE_UNKNOWN';
    const secret = 'PRIVATE_FAILED_ENTRY_TOKEN';
    const h = harness(armedState({status: 'running', entryClaimed: true}), {scriptResult: {submitted, code, token: secret, url: 'https://tickets.interpark.com/gates/partner?partner_token=' + secret}});
    assert.equal((await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site)).ok, true);
    const failure = h.state().run;
    assert.equal(failure.entryResultCode, code);
    assert.equal(failure.status, 'waiting-manual');
    assert.match(failure.reason, expected);
    for (const status of ['manual', 'waiting', 'progress']) {
      const reply = await h.send({type: 'PAGE_STATE', runId: 'run-1', status, reason: '泛化页面提示 ' + secret}, h.site);
      assert.equal(reply.data, false, code + ': ' + status);
      assert.deepEqual(h.state().run, failure);
    }
    const resume = await h.send({type: 'RESUME'});
    assert.equal(resume.ok, false);
    assert.match(resume.error, expected);
    assert.match(resume.error, /停止后重新启动/);
    assert.deepEqual(h.state().run, failure);
    assert.equal((await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site)).ok, false);
    assert.equal(h.calls.scripts.length, 1);
    assert.equal(JSON.stringify(h.state()).includes(secret), false);
  }
});

test('pausing a finished entry failure keeps its original diagnosis and cannot resume verification', async () => {
  const h = harness(armedState({status: 'running', entryClaimed: true}), {scriptResult: {submitted: false, code: 'ENTRY_EMAIL_REQUIRED'}});
  await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site);
  const reason = h.state().run.reason;
  assert.equal((await h.send({type: 'PAUSE'})).ok, true);
  assert.equal(h.state().run.status, 'paused');
  assert.equal(h.state().run.entryResultCode, 'ENTRY_EMAIL_REQUIRED');
  assert.equal(h.state().run.reason, reason);
  assert.equal((await h.send({type: 'RESUME'})).ok, false);
  assert.equal(h.calls.scripts.filter((call) => call.func.name === 'officialEntry').length, 1);
});

test('pending verification ignores page polls and cancellation remains final even before a late result', async () => {
  let releaseScript;
  const scriptBarrier = new Promise((resolve) => { releaseScript = resolve; });
  const h = harness(armedState({status: 'running', entryClaimed: true}), {scriptBarrier});
  const entering = h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site);
  await h.scriptStarted;
  const pending = h.state().run;
  assert.equal((await h.send({type: 'PAGE_STATE', runId: 'run-1', status: 'manual', reason: '泛化页面检查'}, h.site)).data, false);
  assert.deepEqual(h.state().run, pending);
  assert.equal((await h.send({type: 'PAUSE'})).ok, true);
  assert.equal(h.state().run.entryResultCode, 'ENTRY_CANCELLED');
  assert.match(h.state().run.reason, /入场流程已取消/);
  assert.equal((await h.send({type: 'RESUME'})).ok, false);
  releaseScript();
  await entering;
  assert.equal(h.state().run.status, 'paused');
  assert.equal(h.state().run.entryResultCode, 'ENTRY_CANCELLED');
  assert.equal(h.state().run.entrySubmitted, false);
  assert.equal(h.calls.scripts.filter((call) => call.func.name === 'officialEntry').length, 1);
});

test('resume only observes after confirmed entry and never dispatches entry again', async () => {
  const h = harness(armedState({status: 'running', entryClaimed: true}));
  await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site);
  const gateSender = {...h.site, url: 'https://tickets.interpark.com/gates/zh/global/26013792'};
  assert.equal((await h.send({type: 'PAGE_STATE', runId: 'run-1', status: 'manual', reason: '人工完成预约页面验证'}, gateSender)).data, true);
  assert.equal((await h.send({type: 'RESUME'})).ok, true);
  assert.equal(h.state().run.status, 'running');
  assert.equal(h.state().run.entryResultCode, 'ENTRY_REDIRECTING');
  assert.equal(h.state().run.entrySubmitted, true);
  assert.match(h.state().run.reason, /仅继续观察/);
  assert.equal((await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site)).ok, false);
  assert.equal(h.calls.scripts.length, 1);
});

test('an unresolved dispatched run cannot resume, while a paused countdown before entry can', async () => {
  const unresolved = harness(armedState({status: 'paused', entryClaimed: true, apiDispatched: true}));
  assert.equal((await unresolved.send({type: 'RESUME'})).ok, false);
  assert.equal(unresolved.state().run.status, 'paused');
  assert.equal(unresolved.calls.scripts.length, 0);
  const countdown = harness(armedState({status: 'paused'}), {now: baseTime - 1000});
  assert.equal((await countdown.send({type: 'RESUME'})).ok, true);
  assert.equal(countdown.state().run.status, 'armed');
  assert.equal(countdown.state().run.entryClaimed, false);
  assert.equal(countdown.calls.scripts.length, 0);
});

test('a manual arrival at payment still stops an uncertain entry run', async () => {
  const h = harness(armedState({status: 'running', entryClaimed: true}), {scriptError: 'script disconnected'});
  await h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site);
  const gateSender = {...h.site, url: 'https://ticket.globalinterpark.com/Global/Play/Book/BookMain.asp'};
  assert.equal((await h.send({type: 'PAGE_STATE', runId: 'run-1', status: 'payment'}, gateSender)).data, true);
  assert.equal(h.state().run.status, 'payment');
  assert.equal(h.state().run.entryResultCode, 'ENTRY_RESULT_UNKNOWN');
  assert.equal((await h.send({type: 'RESUME'})).ok, false);
  assert.equal(h.calls.scripts.length, 1);
});

test('a recorded navigation failure survives late API success, page polling and pause', async () => {
  let releaseScript;
  const scriptBarrier = new Promise((resolve) => { releaseScript = resolve; });
  const h = harness(armedState({status: 'running', entryClaimed: true}), {scriptBarrier});
  const entering = h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site);
  await h.scriptStarted;
  // Simulate the independent navigation listener recording its finite result.
  const failed = h.state();
  failed.run.status = 'waiting-manual';
  failed.run.navigationErrorCode = 'ERR_CONNECTION_RESET';
  failed.run.reason = '官方售票页面连接中断，请检查连接后停止并重新启动。';
  h.database.nolHelperState = failed;
  releaseScript();
  await entering;
  assert.deepEqual(h.state().run, failed.run);
  for (const status of ['manual', 'waiting', 'progress']) {
    assert.equal((await h.send({type: 'PAGE_STATE', runId: 'run-1', status, reason: '泛化页面提示'}, h.site)).data, false);
    assert.equal(h.state().run.reason, failed.run.reason);
  }
  assert.equal((await h.send({type: 'PAUSE'})).ok, true);
  assert.equal(h.state().run.navigationErrorCode, 'ERR_CONNECTION_RESET');
  assert.equal(h.state().run.reason, failed.run.reason);
  const resume = await h.send({type: 'RESUME'});
  assert.equal(resume.ok, false);
  assert.match(resume.error, /连接失败.*停止后重新启动/);
  assert.equal(h.calls.scripts.filter((call) => call.func.name === 'officialEntry').length, 1);
});

test('a navigation failure also prevents resuming an already submitted entry', async () => {
  const h = harness(armedState({status: 'waiting-manual', entryClaimed: true, apiDispatched: true, entrySubmitted: true, navigationErrorCode: 'ERR_NAME_NOT_RESOLVED', reason: '官网地址无法解析'}));
  assert.equal((await h.send({type: 'RESUME'})).ok, false);
  assert.equal(h.state().run.status, 'waiting-manual');
  assert.equal(h.state().run.reason, '官网地址无法解析');
  assert.equal(h.calls.scripts.length, 0);
});

test('pause and stop settle promptly while API entry is pending and discard its late success', async () => {
  for (const type of ['PAUSE', 'STOP']) {
    let releaseScript;
    const scriptBarrier = new Promise((resolve) => { releaseScript = resolve; });
    const h = harness(armedState({status: 'running', entryClaimed: true}), {scriptBarrier});
    const entering = h.send({type: 'API_ENTRY', runId: 'run-1'}, h.site);
    let startTimer;
    const started = await Promise.race([h.scriptStarted, new Promise((resolve) => { startTimer = setTimeout(() => resolve(false), 200); })]);
    clearTimeout(startTimer);
    if (!started) {
      releaseScript();
      await entering;
      assert.fail('official script entry did not start');
    }
    let timer;
    const stopped = await Promise.race([
      h.send({type}, h.ui),
      new Promise((resolve) => { timer = setTimeout(() => resolve({blocked: true}), 200); })
    ]);
    clearTimeout(timer);
    releaseScript();
    await entering;
    assert.equal(stopped.ok, true, type + ' must not wait behind pending page fetch');
    assert.equal(h.state().run.status, type === 'PAUSE' ? 'paused' : 'stopped');
    assert.equal(h.state().run.entrySubmitted, false);
  }
});

test('a slow SAVE_TASK official refresh does not hold an unrelated opening-time claim', async () => {
  let releaseProduct;
  const productBarrier = new Promise((resolve) => { releaseProduct = resolve; });
  const h = harness(armedState(), {productBarrier});
  const saving = h.send({type: 'SAVE_TASK', task: task('task-2')});
  const claiming = h.send({type: 'CLAIM_ENTRY', runId: 'run-1', visible: true, lastTick: baseTime}, h.site);
  let timer;
  const claimBeforeRead = await Promise.race([claiming, new Promise((resolve) => { timer = setTimeout(() => resolve({blocked: true}), 200); })]);
  clearTimeout(timer);
  releaseProduct();
  await saving;
  await claiming;
  assert.equal(claimBeforeRead.ok, true);
  assert.equal(h.state().run.entryClaimed, true);
});

test('periodic official refresh moves an armed countdown when the sale is postponed', async () => {
  const options = {sales: copy(capturedSales)};
  const h = harness(armedState({status: 'stopped'}), options);
  const armed = await h.send({type: 'ARM', taskId: 'task-1'});
  assert.equal(armed.ok, true);
  options.sales.data.salesInfo.bookingOpenTime = '2026-10-13 20:00:00';
  await h.chrome.alarms.onAlarm.emit({name: 'sale:' + armed.data.id});
  assert.equal(h.state().run.status, 'armed');
  assert.equal(h.state().run.openAt, '2026-10-13T11:00:00.000Z');
  assert.equal(h.state().run.officialOpenAt, '2026-10-13T11:00:00.000Z');
  assert.equal(h.state().tasks[0].openAt, '2026-10-13T11:00:00.000Z');
  assert.ok(h.calls.createAlarms.some((alarm) => alarm.name === 'deadline:' + armed.data.id && alarm.value.when === Date.parse('2026-10-13T11:00:00.000Z') + 6000));
});

test('immediate mode retains official sale bounds so an unchanged refresh does not pause it', async () => {
  const now = Date.parse('2026-10-12T11:00:01.000Z');
  const h = harness(armedState({status: 'stopped'}), {now});
  const armed = await h.send({type: 'ARM', taskId: 'task-1', immediate: true});
  assert.equal(armed.ok, true);
  const triggerAt = armed.data.openAt;
  assert.equal(h.state().run.officialOpenAt, '2026-10-12T11:00:00.000Z');
  await h.chrome.alarms.onAlarm.emit({name: 'sale:' + armed.data.id});
  assert.equal(h.state().run.status, 'armed');
  assert.equal(h.state().run.openAt, triggerAt);
  assert.equal(h.state().run.officialEndAt, '2026-10-31T02:00:59.000Z');
});

test('a failed periodic official refresh pauses the armed run rather than retaining a stale countdown', async () => {
  const options = {sales: copy(capturedSales)};
  const h = harness(armedState({status: 'stopped'}), options);
  const armed = await h.send({type: 'ARM', taskId: 'task-1'});
  assert.equal(armed.ok, true);
  options.salesHTTP = 503;
  await h.chrome.alarms.onAlarm.emit({name: 'sale:' + armed.data.id});
  assert.equal(h.state().run.status, 'paused');
  assert.equal(h.state().run.entryClaimed, false);
  assert.equal(h.calls.scripts.length, 0);
  assert.ok(h.calls.clearAlarms.includes('sale:' + armed.data.id));
});

test('official main navigation timeout preserves entry guards and stores no gate credentials', async () => {
  const h = harness(armedState({status:'running',entryClaimed:true,apiDispatched:true,entrySubmitted:true,entryAttempted:true}));
  const gate = 'https://tickets.interpark.com/gates/partner?partner_token=SYNTHETIC_NAV_SECRET';
  h.tabs.get(23).url = gate;
  await h.chrome.webNavigation.onErrorOccurred.emit({tabId:23,frameId:0,url:gate,error:'net::ERR_CONNECTION_TIMED_OUT'});
  const r = h.state().run;
  assert.equal(r.status,'waiting-manual');
  assert.equal(r.navigationErrorCode,'ERR_CONNECTION_TIMED_OUT');
  assert.equal(r.navigationErrorHost,'tickets.interpark.com');
  assert.match(r.reason,/连接超时/);
  assert.equal(r.entryClaimed,true);
  assert.equal(r.entrySubmitted,true);
  assert.ok(h.calls.clearAlarms.includes('sale:run-1'));
  assert.equal(h.calls.scripts.length,0,'navigation error never retries entry');
  assert.equal(JSON.stringify(h.calls.writes).includes('SYNTHETIC_NAV_SECRET'),false);
  const diagnostic = await h.send({type:'EXPORT_DIAGNOSTICS'});
  assert.equal(diagnostic.data.run.navigationErrorCode,'ERR_CONNECTION_TIMED_OUT');
  assert.equal(JSON.stringify(diagnostic).includes('SYNTHETIC_NAV_SECRET'),false);
  assert.equal((await h.send({type:'RESUME'})).ok,false);
  assert.equal(h.state().run.status,'waiting-manual');
});

test('a newer pending navigation prevents an old failure from replacing the current run state', async () => {
  const gate = 'https://tickets.interpark.com/gates/partner?partner_token=OLD_SYNTHETIC';
  const h = harness(armedState({status:'running',entryClaimed:true,apiDispatched:true}));
  h.tabs.get(23).url = gate;
  h.tabs.get(23).pendingUrl = 'https://tickets.interpark.com/gates/partner?partner_token=NEW_SYNTHETIC';
  await h.chrome.webNavigation.onErrorOccurred.emit({tabId:23,frameId:0,url:gate,error:'net::ERR_CONNECTION_TIMED_OUT'});
  assert.equal(h.state().run.status,'running');
  assert.equal(h.state().run.navigationErrorCode,undefined);
  assert.equal(h.calls.writes.length,0);
  h.tabs.get(23).pendingUrl = gate;
  await h.chrome.webNavigation.onErrorOccurred.emit({tabId:23,frameId:0,url:gate,error:'net::ERR_CONNECTION_TIMED_OUT'});
  assert.equal(h.state().run.status,'waiting-manual');
});

test('cancelled, unrelated, unclaimed and missing-tab navigation errors have no side effects', async () => {
  const gate = 'https://tickets.interpark.com/gates/partner';
  for (const change of [{frameId:1},{tabId:24},{error:'net::ERR_ABORTED'},{url:'https://unrelated.example.test/'}]) {
    const h = harness(armedState({status:'running',entryClaimed:true,apiDispatched:true}));
    h.tabs.get(23).url = gate;
    await h.chrome.webNavigation.onErrorOccurred.emit({tabId:23,frameId:0,url:gate,error:'net::ERR_CONNECTION_TIMED_OUT',...change});
    assert.equal(h.calls.writes.length,0);
  }
  const unclaimed = harness();
  unclaimed.tabs.get(23).url = gate;
  await unclaimed.chrome.webNavigation.onErrorOccurred.emit({tabId:23,frameId:0,url:gate,error:'net::ERR_CONNECTION_TIMED_OUT'});
  assert.equal(unclaimed.calls.writes.length,0);
  const missing = harness(armedState({status:'running',entryClaimed:true}));
  missing.tabs.delete(23);
  await missing.chrome.webNavigation.onErrorOccurred.emit({tabId:23,frameId:0,url:gate,error:'net::ERR_CONNECTION_TIMED_OUT'});
  assert.equal(missing.calls.writes.length,0);
});

const waitingProductName = 'JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON';
const waitingSite = {url:'https://tickets.interpark.com/waiting?key=SYNTHETIC_QUEUE_SECRET',id:'test-extension',tab:{id:23},frameId:0};
const waitingMessage = {type:'PAGE_STATE',runId:'run-1',status:'waiting',verified:true,code:'WAITING_QUEUE_VERIFIED',productName:waitingProductName,position:42446,totalWaiting:48869,reason:'unsafe caller reason SYNTHETIC_QUEUE_SECRET'};
function waitingState(overrides = {}) {
  const initial=armedState({status:'waiting-manual',entryClaimed:true,apiDispatched:true,entryResultCode:'ENTRY_RESULT_UNKNOWN',...overrides});
  initial.tasks[0].productName=waitingProductName;
  return initial;
}

test('verified assigned queue observation resolves an unknown entry result without inventing an API submission', async () => {
  const h=harness(waitingState({navigationErrorCode:'ERR_CONNECTION_TIMED_OUT',navigationErrorHost:'tickets.interpark.com'}),{tabUrl:waitingSite.url,documentId:'current-queue-document'});
  assert.equal((await h.send(waitingMessage,{...waitingSite,documentId:'current-queue-document'})).data,true);
  const r=h.state().run;
  assert.equal(r.status,'running');
  assert.equal(r.step,'正在官方排队');
  assert.equal(r.queueObserved,true);
  assert.equal(r.queuePosition,42446);
  assert.equal(r.queueTotal,48869);
  assert.equal(r.navigationErrorCode,null);
  assert.equal(r.entrySubmitted,false);
  assert.equal(r.entryResultCode,'ENTRY_RESULT_UNKNOWN');
  assert.match(r.reason,/42,446/);
  assert.equal(JSON.stringify(h.calls.writes).includes('SYNTHETIC_QUEUE_SECRET'),false);
  assert.equal(h.calls.scripts.length,0);
  assert.equal((await h.send({type:'PAUSE'})).ok,true);
  const afterPause=h.calls.scripts.length;
  assert.equal((await h.send({type:'RESUME'})).ok,true);
  assert.equal(h.state().run.status,'running');
  assert.equal(h.calls.scripts.length,afterPause,'resume only observes the existing queue');
  const diagnostic=(await h.send({type:'EXPORT_DIAGNOSTICS'})).data;
  assert.equal(diagnostic.run.queueObserved,true);
  assert.equal(JSON.stringify(diagnostic).includes('SYNTHETIC_QUEUE_SECRET'),false);
});

test('queue observations reject other products, unverified structure, invalid counts and non-queue routes', async () => {
  for(const change of [{productName:waitingProductName+' + Hotels'},{verified:false},{status:'progress'},{position:0},{position:48870},{totalWaiting:NaN},{position:'42446'}]) {
    const h=harness(waitingState());
    assert.equal((await h.send({...waitingMessage,...change},waitingSite)).data,false);
    assert.equal(h.calls.writes.length,0);
    assert.equal(h.state().run.queueObserved,undefined);
  }
  for(const url of ['https://tickets.interpark.com/gates/partner','https://ticket.globalinterpark.com/waiting']) {
    const h=harness(waitingState());
    assert.equal((await h.send(waitingMessage,{...waitingSite,url})).data,false);
    assert.equal(h.calls.writes.length,0);
  }
  const h=harness(waitingState({entryClaimed:false}));
  assert.equal((await h.send(waitingMessage,waitingSite)).data,false);
  assert.equal(h.calls.writes.length,0);
});

test('queue counts update from the same product without interpreting booking percentage as inventory', async () => {
  const h=harness(waitingState(),{tabUrl:waitingSite.url});
  assert.equal((await h.send(waitingMessage,waitingSite)).data,true);
  assert.equal((await h.send({...waitingMessage,productName:waitingProductName.normalize('NFKC').toLowerCase(),position:39816,totalWaiting:47845,bookingRate:99},waitingSite)).data,true);
  assert.equal(h.state().run.queuePosition,39816);
  assert.equal(h.state().run.queueTotal,47845);
  assert.equal(h.state().run.bookingRate,undefined);
  assert.equal(h.calls.scripts.length,0);
});

test('a late API callback cannot erase a queue confirmed in the actual assigned page', async () => {
  let releaseScript;
  const scriptBarrier=new Promise(resolve=>{releaseScript=resolve;});
  const h=harness(waitingState({status:'running',apiDispatched:false}),{scriptBarrier,scriptResult:{submitted:false,code:'ENTRY_RESULT_UNKNOWN'}});
  const entering=h.send({type:'API_ENTRY',runId:'run-1'},h.site);
  await h.scriptStarted;
  h.tabs.get(23).url=waitingSite.url;
  assert.equal((await h.send(waitingMessage,waitingSite)).data,true);
  releaseScript();await entering;
  assert.equal(h.state().run.status,'running');
  assert.equal(h.state().run.step,'正在官方排队');
  assert.equal(h.state().run.queueObserved,true);
  assert.equal(h.state().run.queuePosition,42446);
});

test('a delayed queue message cannot clear a newer navigation or document failure', async () => {
  for(const options of [{tabUrl:'https://tickets.interpark.com/gates/partner'},{tabUrl:waitingSite.url,documentId:'new-document'}]) {
    const h=harness(waitingState({navigationErrorCode:'ERR_CONNECTION_TIMED_OUT'}),options);
    assert.equal((await h.send(waitingMessage,{...waitingSite,documentId:'old-document'})).data,false);
    assert.equal(h.state().run.navigationErrorCode,'ERR_CONNECTION_TIMED_OUT');
    assert.equal(h.calls.writes.length,0);
  }
  const h=harness(waitingState({navigationErrorCode:'ERR_CONNECTION_TIMED_OUT'}),{tabUrl:waitingSite.url});
  h.tabs.get(23).pendingUrl='https://tickets.interpark.com/gates/partner';
  assert.equal((await h.send(waitingMessage,waitingSite)).data,false);
  assert.equal(h.calls.writes.length,0);
});

const ocrSeatURL='https://tickets.interpark.com/onestop/seat';
const ocrSecret='SYNTHETIC_PRIVATE_OCR_ROUTE_SENTINEL';
const ocrBase64=Buffer.from(ocrSecret).toString('base64');
const ocrImage='data:image/png;base64,'+ocrBase64;
function ocrSender(h, changes={}) {return {...h.site,url:ocrSeatURL,...changes};}

test('trusted extension OCR status and health work without a task and health uses the real client contract', async () => {
  const h=harness(null,{ocrPermission:true});
  assert.deepEqual(copy((await h.send({type:'OCR_STATUS'})).data),{enabled:true});
  assert.equal(h.calls.fetch.length,0);
  assert.deepEqual(copy((await h.send({type:'OCR_HEALTH'})).data),{ready:true,engine:'ddddocr'});
  assert.equal(h.calls.fetch.length,1);
  const request=h.calls.fetch[0];
  assert.equal(request.url,'http://127.0.0.1:8765/health');
  assert.equal(request.method,'GET');
  assert.equal(request.credentials,'omit');
  assert.equal(request.redirect,'error');
  assert.deepEqual(request.headers,{'X-NOL-Extension-Id':'test-extension'});
  assert.equal(h.calls.writes.length,0);
  assert.equal(h.state(),undefined);
});

test('the current official seat mainframe can check status and recognize synthetic bytes without an active task', async () => {
  const h=harness(null,{ocrPermission:true,tabUrl:ocrSeatURL});
  const sender=ocrSender(h);
  assert.equal((await h.send({type:'GET_CONTEXT'},sender)).data,null);
  assert.deepEqual(copy((await h.send({type:'OCR_STATUS'},sender)).data),{enabled:true});
  const recognized=await h.send({type:'OCR_RECOGNIZE',imageDataUrl:ocrImage},sender);
  assert.equal(recognized.ok,true);
  assert.equal(recognized.data.recognized,true);
  assert.equal(recognized.data.candidate,'ABCDEF');
  assert.equal(h.calls.fetch.length,1);
  const request=h.calls.fetch[0];
  assert.equal(request.url,'http://127.0.0.1:8765/recognize');
  assert.equal(request.method,'POST');
  assert.equal(request.credentials,'omit');
  assert.equal(request.redirect,'error');
  assert.deepEqual(request.headers,{'X-NOL-Extension-Id':'test-extension','Content-Type':'application/json'});
  assert.deepEqual(JSON.parse(request.body),{image:ocrBase64});
  assert.equal(h.calls.writes.length,0);
  assert.equal(h.calls.scripts.length,0);
  assert.equal(h.state(),undefined);
  assert.equal(JSON.stringify((await h.send({type:'EXPORT_DIAGNOSTICS'})).data).includes(ocrBase64),false);
});

test('optional OCR permission is reported as disabled and prevents HTTP for site recognition or extension health', async () => {
  const h=harness(null,{tabUrl:ocrSeatURL});
  for(const sender of [h.ui,ocrSender(h)]) assert.deepEqual(copy((await h.send({type:'OCR_STATUS'},sender)).data),{enabled:false});
  assert.equal((await h.send({type:'OCR_RECOGNIZE',imageDataUrl:ocrImage},ocrSender(h))).ok,false);
  assert.equal((await h.send({type:'OCR_HEALTH'})).ok,false);
  assert.equal(h.calls.fetch.length,0);
  assert.equal(h.calls.writes.length,0);
});

test('site callers cannot invoke OCR health even from the current official seat mainframe', async () => {
  const h=harness(null,{ocrPermission:true,tabUrl:ocrSeatURL});
  const denied=await h.send({type:'OCR_HEALTH'},ocrSender(h));
  assert.equal(denied.ok,false);
  assert.match(denied.error,/扩展弹窗/);
  assert.equal(h.calls.fetch.length,0);
  assert.equal(h.calls.permissions.length,0);
});

test('OCR site routes reject unsupported origins, paths, credentials and non-mainframe senders before HTTP', async () => {
  for(const change of [
    {url:'http://tickets.interpark.com/onestop/seat'},
    {url:'https://tickets.interpark.com.evil.test/onestop/seat'},
    {url:'https://world.nol.com/onestop/seat'},
    {url:'https://ticket.globalinterpark.com/onestop/seat'},
    {url:'https://tickets.interpark.com:444/onestop/seat'},
    {url:'https://tickets.interpark.com/onestop/seat/'},
    {url:'https://tickets.interpark.com/onestop/schedule'},
    {url:'https://tickets.interpark.com/waiting'},
    {url:'https://synthetic-user:synthetic-pass@tickets.interpark.com/onestop/seat'},
    {url:'chrome-extension://test-extension.evil/options.html'},
    {url:'invalid'},
    {frameId:1},
    {frameId:undefined},
    {tab:undefined}
  ]) {
    const h=harness(null,{ocrPermission:true,tabUrl:change.url || ocrSeatURL});
    const sender=ocrSender(h,change);
    for(const type of ['OCR_STATUS','OCR_RECOGNIZE']) assert.equal((await h.send({type,imageDataUrl:ocrImage},sender)).ok,false,JSON.stringify({change,type}));
    assert.equal(h.calls.fetch.length,0);
    assert.equal(h.calls.permissions.length,0);
    assert.equal(h.calls.writes.length,0);
  }
});

test('a changed, pending or closed seat tab cannot invoke OCR using a stale sender URL', async () => {
  for(const change of [
    (h) => {h.tabs.get(23).url='https://tickets.interpark.com/onestop/schedule';},
    (h) => {h.tabs.get(23).url=ocrSeatURL+'?new=synthetic-session';},
    (h) => {h.tabs.get(23).pendingUrl='https://tickets.interpark.com/onestop/schedule';},
    (h) => {h.tabs.delete(23);}
  ]) {
    const h=harness(null,{ocrPermission:true,tabUrl:ocrSeatURL});
    change(h);
    for(const type of ['OCR_STATUS','OCR_RECOGNIZE']) assert.equal((await h.send({type,imageDataUrl:ocrImage},ocrSender(h))).ok,false);
    assert.equal(h.calls.fetch.length,0);
    assert.equal(h.calls.permissions.length,0);
    assert.equal(h.calls.writes.length,0);
  }
});

test('OCR candidates are returned but image, query and raw service data never enter run storage or diagnostics', async () => {
  const seatURL=ocrSeatURL+'?ignored='+ocrSecret;
  const h=harness(armedState({status:'waiting-manual',entryClaimed:true}),{ocrPermission:true,tabUrl:seatURL,ocrResponse:{ok:true,recognized:true,candidate:'ABCDEF',image:ocrImage,raw:ocrSecret,token:ocrSecret}});
  const before=h.state();
  const recognized=await h.send({type:'OCR_RECOGNIZE',imageDataUrl:ocrImage},ocrSender(h,{url:seatURL}));
  assert.equal(recognized.data.candidate,'ABCDEF');
  assert.deepEqual(Object.keys(recognized.data).sort(),['candidate','reason','recognized']);
  assert.deepEqual(h.state(),before);
  assert.equal(h.calls.writes.length,0);
  assert.equal(h.calls.messages.length,0);
  assert.equal(h.state().run.events.length,0);
  const diagnostic=(await h.send({type:'EXPORT_DIAGNOSTICS'})).data;
  for(const value of [ocrImage,ocrBase64,ocrSecret,'ABCDEF']) {
    assert.equal(JSON.stringify(recognized).includes(value),value==='ABCDEF');
    assert.equal(JSON.stringify(diagnostic).includes(value),false);
    assert.equal(JSON.stringify(h.calls.writes).includes(value),false);
  }
});

test('malformed site image data never reaches permissions or HTTP and does not change a run', async () => {
  const h=harness(armedState(),{ocrPermission:true,tabUrl:ocrSeatURL});
  const before=h.state();
  for(const imageDataUrl of [null,'', 'https://example.test/image.png','data:image/svg+xml;base64,AAEC','data:image/png;base64,AAA']) {
    assert.equal((await h.send({type:'OCR_RECOGNIZE',imageDataUrl},ocrSender(h))).ok,false);
  }
  assert.deepEqual(h.state(),before);
  assert.equal(h.calls.permissions.length,0);
  assert.equal(h.calls.fetch.length,0);
  assert.equal(h.calls.writes.length,0);
});

test('OCR HTTP, oversized response and raw local failure messages remain bounded safe errors without writes', async () => {
  for(const change of [{ocrHTTP:403},{ocrText:' '.repeat(4097)},{ocrText:ocrSecret},{ocrFetchError:new Error(ocrSecret+' redirect refused')}]) {
    const h=harness(null,{ocrPermission:true,tabUrl:ocrSeatURL,...change});
    const failure=await h.send({type:'OCR_RECOGNIZE',imageDataUrl:ocrImage},ocrSender(h));
    assert.equal(failure.ok,false);
    assert.equal(JSON.stringify(failure).includes(ocrSecret),false);
    assert.equal(JSON.stringify(failure).includes(ocrBase64),false);
    assert.equal(h.calls.fetch.length,1);
    assert.equal(h.calls.writes.length,0);
    assert.equal(h.state(),undefined);
  }
});
