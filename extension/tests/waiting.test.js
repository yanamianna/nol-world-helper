'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const productName = 'JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON';
const source = fs.readFileSync(path.join(__dirname, '../adapters/global.js'), 'utf8');

function adapter() {
  // Parsing the route is allowed; reading a queue query/hash is not needed.
  class RouteURL extends URL {
    get search() { throw new Error('queue query must not be read'); }
    get searchParams() { throw new Error('queue query must not be read'); }
    get hash() { throw new Error('queue fragment must not be read'); }
  }
  const context = vm.createContext({URL: RouteURL, fetch() { throw new Error('queue adapter cannot fetch'); }});
  vm.runInContext(source, context, {filename:'global.js'});
  return context.NolHelper.adapters.global;
}

function element(textContent, selections = {}) {
  return {
    textContent,
    selections,
    querySelectorAll(selector) { return this.selections[selector] || []; },
    click() { throw new Error('queue adapter cannot click'); }
  };
}

function fixture(options = {}) {
  // DOM classes/labels supplied from the live desktop queue observation on
  // 2026-10-08. This fixture has no real queue key, cookies or session data.
  const goods = element(options.goodsName === undefined ? productName : options.goodsName);
  const heading = element(options.heading === undefined ? '等候人數過多待機中\n請稍候片刻' : options.heading);
  const title = element('', {':scope > div.Wait_goodsName__Sjp96':[goods], ':scope > h2':[heading]});
  const position = element(options.position === undefined ? '42,446' : options.position);
  const rankLabel = element('我的等候順位');
  const main = element('', {':scope > h3':[rankLabel], ':scope > strong':[position]});
  const total = element(options.total === undefined ? '48,869' : options.total);
  const totalLabel = element('現在等候人數');
  const totalLeft = element('', {':scope > h4':[totalLabel]});
  const totalRow = element('', {':scope > div.StatusBox_columnLeft__PZwMU':[totalLeft], ':scope > div.StatusBox_columnRight__1bbL6':[total]});
  const rateLabel = element('訂購率');
  const rateLeft = element('', {':scope > h4':[rateLabel]});
  const rate = element('99%');
  Object.defineProperty(rate, 'textContent', {get() { throw new Error('booking rate is not inventory and must not be read'); }});
  const rateRow = element('', {':scope > div.StatusBox_columnLeft__PZwMU':[rateLeft], ':scope > div.StatusBox_columnRight__1bbL6':[rate]});
  const box = element('', {'div.StatusBox_mainText__9gJXJ':[main], 'div.StatusBox_sub__T7h1k > div.StatusBox_row__rN2QG':[totalRow,rateRow]});
  const doc = element('', {'div.Wait_title__HYBF4':[title], 'div.StatusBox_wrap__r_RyI.StatusBox_isDesktop__MyXzq':[box]});
  doc.location = {href:options.url || 'https://tickets.interpark.com/waiting'};
  doc.location.reload = () => { throw new Error('queue adapter cannot refresh'); };
  const ctx = {task:{productName:options.taskName === undefined ? productName : options.taskName, goodsCode:'26013793',placeCode:'26001167'}};
  return {doc,ctx,goods,heading,title,position,rankLabel,main,total,totalLabel,totalLeft,totalRow,rateRow,box};
}

test('the observed queue structure reports verified rank and total for the exact configured product', () => {
  const global = adapter(), f = fixture();
  const state = global.inspect(f.doc, f.ctx);
  assert.equal(state.kind, 'waiting');
  assert.equal(state.verified, true);
  assert.equal(state.route, 'waiting');
  assert.equal(state.code, 'WAITING_QUEUE_VERIFIED');
  assert.equal(state.position, 42446);
  assert.equal(state.totalWaiting, 48869);
  assert.equal(state.productName, productName);
  assert.match(state.reason, /42,446.*48,869/);
  assert.match(state.reason, /请勿刷新或重新进入/);
  assert.equal(/99|余票|剩余座位/.test(state.reason), false);
  const step = global.step(f.doc, f.ctx);
  assert.equal(step.status, 'waiting');
  assert.equal(step.verified, true);
  assert.equal(step.position, 42446);
  assert.equal(step.totalWaiting, 48869);
});

test('queue rank is read again from the page without changing the page or interpreting the rate', () => {
  const global = adapter(), f = fixture();
  assert.equal(global.step(f.doc, f.ctx).position, 42446);
  f.position.textContent = '40,001';
  f.total.textContent = '47,000';
  assert.equal(global.step(f.doc, f.ctx).position, 40001);
  assert.equal(global.step(f.doc, f.ctx).totalWaiting, 47000);
  assert.throws(() => global.enter(f.doc, f.ctx), (error) => error.code === 'GLOBAL_DOM_UNVERIFIED');
});

test('the observed near-entry heading remains a verified queue at rank 4600 of 28483', () => {
  const global = adapter(), f = fixture({heading:'您的轮到即将到来，请准备好预订',position:'4,600',total:'28,483'});
  const state = global.inspect(f.doc, f.ctx);
  assert.equal(state.kind, 'waiting');
  assert.equal(state.verified, true);
  assert.equal(state.code, 'WAITING_QUEUE_VERIFIED');
  assert.equal(state.position, 4600);
  assert.equal(state.totalWaiting, 28483);
  const step = global.step(f.doc, f.ctx);
  assert.equal(step.status, 'waiting');
  assert.equal(step.route, 'waiting');
  assert.equal(step.position, 4600);
  assert.equal(step.totalWaiting, 28483);
  assert.match(step.reason, /4,600.*28,483/);
  assert.match(step.reason, /请勿刷新或重新进入/);
  // A similar unobserved heading must not become a booking/payment state.
  f.heading.textContent += '，立即付款';
  assert.equal(global.step(f.doc, f.ctx).status, 'manual');
});

test('product matching normalizes Unicode and whitespace but requires the complete official name', () => {
  const global = adapter();
  const normalized = fixture({taskName:'jeonghan x joshua journey into[DREAMING]-INCHEON'});
  assert.equal(global.inspect(normalized.doc, normalized.ctx).verified, true);
  for (const taskName of ['', 'JEONGHAN X JOSHUA', 'JEONGHAN X JOSHUA JOURNEY INTO [DREAMING] - SEOUL', '［Play＆Stay］' + productName + ' + Hotels']) {
    const f = fixture({taskName});
    assert.equal(global.step(f.doc, f.ctx).status, 'manual', taskName);
    assert.equal(global.inspect(f.doc, f.ctx).verified, false);
  }
});

test('a wrong or missing product is rejected before queue numbers are read', () => {
  const global = adapter();
  for (const goodsName of ['Other performance', '']) {
    const f = fixture({goodsName});
    Object.defineProperty(f.position, 'textContent', {get() { throw new Error('numbers must not be inspected before product matching'); }});
    assert.equal(global.step(f.doc, f.ctx).status, 'manual');
    assert.equal(global.inspect(f.doc, f.ctx).verified, false);
  }
});

test('waiting recognition requires the exact HTTPS host and exact observed route', () => {
  const global = adapter();
  for (const url of ['http://tickets.interpark.com/waiting','https://tickets.interpark.com.evil.test/waiting','https://user@tickets.interpark.com/waiting','https://tickets.interpark.com:444/waiting','https://ticket.globalinterpark.com/waiting','https://tickets.interpark.com/waiting/','https://tickets.interpark.com/gates/partner']) {
    const f = fixture({url});
    assert.equal(global.step(f.doc, f.ctx).status, 'manual', url);
    assert.equal(global.inspect(f.doc, f.ctx).verified, false, url);
  }
});

test('queue recognition never reads or returns query contents', () => {
  const global = adapter(), sentinel = 'PRIVATE_QUERY_SENTINEL';
  const f = fixture({url:'https://tickets.interpark.com/waiting?ignored=' + sentinel});
  const state = global.inspect(f.doc, f.ctx);
  assert.equal(state.verified, true);
  assert.equal(JSON.stringify(state).includes(sentinel), false);
  assert.equal(JSON.stringify(global.step(f.doc, f.ctx)).includes(sentinel), false);
});

test('changed headings, missing nodes and duplicated queue structures stay manual', () => {
  const global = adapter();
  for (const change of [
    (f) => { f.doc.selections['div.Wait_title__HYBF4'] = []; },
    (f) => { f.doc.selections['div.Wait_title__HYBF4'] = [f.title, f.title]; },
    (f) => { f.doc.selections['div.StatusBox_wrap__r_RyI.StatusBox_isDesktop__MyXzq'] = []; },
    (f) => { f.heading.textContent = 'Payment'; },
    (f) => { f.rankLabel.textContent = '订购率'; },
    (f) => { f.main.selections[':scope > strong'] = [f.position, f.position]; },
    (f) => { f.totalLabel.textContent = '訂購率'; },
    (f) => { f.box.selections['div.StatusBox_sub__T7h1k > div.StatusBox_row__rN2QG'] = [f.totalRow, f.totalRow]; },
    (f) => { f.totalRow.selections[':scope > div.StatusBox_columnRight__1bbL6'] = []; }
  ]) {
    const f = fixture();
    change(f);
    assert.equal(global.step(f.doc, f.ctx).status, 'manual');
    assert.equal(global.inspect(f.doc, f.ctx).verified, false);
  }
});

test('invalid, unsafe or contradictory numeric values are never treated as a valid queue', () => {
  const global = adapter();
  for (const position of ['','0','-1','1.5','4,24','42,446 人','99%','NaN','9007199254740992','50,000']) {
    const f = fixture({position});
    assert.equal(global.step(f.doc, f.ctx).status, 'manual', position);
    assert.equal(global.inspect(f.doc, f.ctx).code, 'WAITING_COUNT_UNKNOWN', position);
  }
  for (const total of ['', '0', '99%', '4,888', '9007199254740992']) {
    const f = fixture({total});
    assert.equal(global.step(f.doc, f.ctx).status, 'manual', total);
  }
  const fullwidth = fixture({position:'４２,４４６',total:'４８,８６９'});
  assert.equal(global.step(fullwidth.doc, fullwidth.ctx).position, 42446);
});
