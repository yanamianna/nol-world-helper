'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extension = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(__dirname, 'fixtures/product.html'), 'utf8');
// Expectations independently recorded from the anonymous public capture.
const capturedDetail = { goodsName: '［Play＆Stay］JEONGHAN X JOSHUA JOURNEY INTO［DREAMING］- INCHEON + Hotels', goodsCode: '26013792', placeCode: '26001167', priceCount: 24, bookingOpenTime: '2026-10-12 20:00:00' };
const url = 'https://world.nol.com/zh-CN/ticket/places/26001167/products/26013792';
const entryMarkup = /<div class="show_laptop grid-area_purchase-button[^>]*>\s*<button\b([^>]*)>([\s\S]*?)<\/button>/.exec(html);
assert.ok(entryMarkup, 'the selector fixture must come from the captured real product page');
const capturedClass = /class="([^"]*)"/.exec(entryMarkup[1])[1];

function loadAdapters() {
  const context = vm.createContext({ URL, Date });
  for (const filename of ['nol.js', 'global.js']) vm.runInContext(fs.readFileSync(path.join(extension, 'adapters', filename), 'utf8'), context, { filename });
  return context.NolHelper.adapters;
}

function button(options = {}) {
  const attributes = new Map([['class', capturedClass]]);
  if (options.disabled) attributes.set('disabled', '');
  if (options.ariaDisabled) attributes.set('aria-disabled', 'true');
  if (options.ariaBusy) attributes.set('aria-busy', 'true');
  return {
    className: capturedClass,
    textContent: entryMarkup[2].replace(/<[^>]*>/g, ''),
    disabled: !!options.disabled,
    isConnected: true,
    clicks: 0,
    computedStyle: { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', ...options.style },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    closest() { return options.inertAncestor ? {} : null; },
    matches(selector) { return selector === ':disabled' && !!options.disabled; },
    getClientRects() { return options.hidden ? [] : [{ width: 280, height: 48 }]; },
    click() { this.clicks += 1; }
  };
}

function documentStub(entries = [button()], options = {}) {
  return {
    location: { href: options.url || url },
    documentElement: { outerHTML: options.html === undefined ? html : options.html },
    defaultView: { getComputedStyle(element) { return element.computedStyle; } },
    querySelectorAll(selector) {
      if (selector === '.grid-area_purchase-button > button.nds-e-rectangle-button--variant_filled_primary') return entries;
      if (selector === '[role="dialog"][aria-modal="true"]') return options.modals || [];
      throw new Error('unobserved selector: ' + selector);
    }
  };
}

function context(overrides = {}) {
  return {
    task: { productUrl: url, goodsCode: '26013792', placeCode: '26001167', openAt: 1000, maxTotal: null, ...overrides.task },
    run: { id: 'run-one', entryClaimed: true, entryClicked: false, ...overrides.run },
    now: overrides.now === undefined ? 1000 : overrides.now,
    requestEntry: overrides.requestEntry || (async () => ({submitted: true, code: 'ENTRY_REDIRECTING'}))
  };
}

function throwsCode(action, expected) {
  assert.throws(action, (error) => error.code === expected);
}

function rejectsCode(action, expected) {
  return assert.rejects(action, (error) => error.code === expected);
}

test('NOL matches only exact HTTPS public ticket product URLs', () => {
  const { nol } = loadAdapters();
  assert.equal(nol.matches(url), true);
  for (const bad of ['http://world.nol.com/zh-CN/ticket/places/26001167/products/26013792', url.replace('world.nol.com', 'world.nol.com.evil.test'), url.replace('world.nol.com', 'user@world.nol.com'), url.replace('/products/26013792', '/products/26013792/order'), 'https://world.nol.com/zh-CN/my-info']) assert.equal(nol.matches(bad), false);
});

test('real captured RSC yields product metadata and all 24 price grades without executing scripts', () => {
  const { nol } = loadAdapters();
  const product = nol.extractProduct(html, url);
  assert.equal(product.goodsName, capturedDetail.goodsName);
  assert.equal(product.goodsCode, capturedDetail.goodsCode);
  assert.equal(product.placeCode, capturedDetail.placeCode);
  assert.equal(product.prices.length, capturedDetail.priceCount);
  assert.equal(product.prices[0].salesPrice, 1750000);
  assert.equal(product.prices[23].seatGrade, '24');
  assert.equal(product.opening.bookingOpenTime, capturedDetail.bookingOpenTime);
  assert.equal(Object.prototype.hasOwnProperty.call(product, 'playSeq'), false);
  assert.equal(nol.extractProduct(html, url.replace('26013792', '26013793')), null);
  assert.equal(nol.extractProduct('<script>throw new Error("must not execute");</script>', url), null);
  assert.equal(nol.extractProduct('<script>self.__next_f.push([1,"malformed"])</script>', url), null);
});

test('verified entry structure is used, and the disabled style utility is not a disabled state', () => {
  const { nol } = loadAdapters();
  const entry = button();
  assert.match(entry.className, /disabled:cursor_not-allowed/);
  const state = nol.inspect(documentStub([entry]), context());
  assert.equal(state.kind, 'entry');
  assert.equal(state.canEnter, true);
  assert.equal(state.entryButton, entry);
});

test('a unique visible entry requests the official API once and never clicks the DOM', async () => {
  const { nol } = loadAdapters();
  const entry = button();
  const doc = documentStub([entry, button({ hidden: true })]);
  let requests = 0;
  const ctx = context({requestEntry: async () => { requests += 1; return {submitted: true, code: 'ENTRY_REDIRECTING'}; }});
  assert.equal((await nol.enter(doc, ctx)).submitted, true);
  await rejectsCode(() => nol.enter(doc, ctx), 'ENTRY_ALREADY_ATTEMPTED');
  assert.equal(requests, 1);
  assert.equal(entry.clicks, 0);
});

test('two visible candidates and absent candidates cannot enter', async () => {
  const { nol } = loadAdapters();
  await rejectsCode(() => nol.enter(documentStub([button(), button()]), context()), 'ENTRY_AMBIGUOUS');
  await rejectsCode(() => nol.enter(documentStub([]), context()), 'ENTRY_NOT_VISIBLE');
});

test('a disabled official button does not delay the time-checked API entry', async () => {
  for (const options of [{disabled: true}, {ariaDisabled: true}, {ariaBusy: true}]) {
    const { nol } = loadAdapters();
    const entry = button(options);
    let requests = 0;
    const result = await nol.enter(documentStub([entry]), context({requestEntry: async () => { requests += 1; return {submitted: true, code: 'ENTRY_REDIRECTING'}; }}));
    assert.equal(result.submitted, true);
    assert.equal(requests, 1);
    assert.equal(entry.clicks, 0);
  }
});

test('invisible and inert entries cannot request the API', async () => {
  for (const [options, code] of [[{ hidden: true }, 'ENTRY_NOT_VISIBLE'], [{ inertAncestor: true }, 'ENTRY_NOT_VISIBLE'], [{ style: { pointerEvents: 'none' } }, 'ENTRY_NOT_VISIBLE']]) {
    const { nol } = loadAdapters();
    const entry = button(options);
    await rejectsCode(() => nol.enter(documentStub([entry]), context()), code);
    assert.equal(entry.clicks, 0);
  }
});

test('the observed announcement modal forces manual handling without dismissing it', async () => {
  const { nol } = loadAdapters();
  assert.match(html, /role="dialog"/);
  const modal = button();
  const doc = documentStub([button()], { modals: [modal] });
  await rejectsCode(() => nol.enter(doc, context()), 'MODAL_REQUIRES_MANUAL');
  assert.equal(nol.step(doc, context()).status, 'manual');
  assert.equal(modal.clicks, 0);
});

test('the configured goods and place must match both URL and metadata', async () => {
  const { nol } = loadAdapters();
  await rejectsCode(() => nol.enter(documentStub(), context({ task: { goodsCode: '26013793' } })), 'PRODUCT_MISMATCH');
  const other = url.replace('26013792', '26013793');
  const state = nol.inspect(documentStub([button()], { url: other }), context({ task: { productUrl: other, goodsCode: '26013793' } }));
  assert.equal(state.code, 'PRODUCT_METADATA_MISMATCH');
});

test('claim, opening time and persisted prior attempt guard every entry', async () => {
  const { nol } = loadAdapters();
  const doc = documentStub();
  await rejectsCode(() => nol.enter(doc, context({ run: { entryClaimed: false } })), 'ENTRY_NOT_CLAIMED');
  await rejectsCode(() => nol.enter(doc, context({ now: 999 })), 'BEFORE_OPEN_TIME');
  await rejectsCode(() => nol.enter(doc, context({ run: { entryClicked: true } })), 'ENTRY_ALREADY_ATTEMPTED');
});

test('a failed API attempt is not retried locally or changed into a DOM click', async () => {
  const { nol } = loadAdapters();
  const entry = button();
  const doc = documentStub([entry]);
  let requests = 0;
  const ctx = context({requestEntry: async () => { requests += 1; throw new Error('network outcome unknown'); }});
  await assert.rejects(() => nol.enter(doc, ctx), /network outcome unknown/);
  await rejectsCode(() => nol.enter(doc, ctx), 'ENTRY_ALREADY_ATTEMPTED');
  assert.equal(requests, 1);
  assert.equal(entry.clicks, 0);
});

test('global gates remain explicitly unverified; no generic payment title enables automation', () => {
  const { global } = loadAdapters();
  const doc = { location: { href: 'https://tickets.interpark.com/gates/partner?partner_token=secret' }, title: 'Payment 支付' };
  assert.equal(global.matches(doc.location.href), true);
  const state = global.inspect(doc, context());
  assert.equal(state.kind, 'unknown');
  assert.equal(state.verified, false);
  assert.equal(state.route, 'partner-gate');
  assert.equal(JSON.stringify(state).includes('secret'), false);
  assert.equal(global.step(doc, context()).status, 'manual');
  throwsCode(() => global.enter(doc, context()), 'GLOBAL_DOM_UNVERIFIED');
  assert.equal(global.matches('https://ticket.globalinterpark.com/Global/Play/Goods/GoodsInfo.asp'), true);
  assert.equal(global.matches('https://ticket.globalinterpark.com.evil.test/'), false);
  assert.equal(global.matches('https://ent-waiting-api.interpark.com/'), false);
});
