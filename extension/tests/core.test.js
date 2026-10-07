'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const context = vm.createContext({URL, Intl, Date, crypto: webcrypto});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8'), context, {filename: 'core.js'});
const H = context.NolHelper;

const NOW = Date.parse('2026-10-07T10:00:00Z');
const OPEN = Date.parse('2026-10-12T11:00:00Z');
const ticketUrl = 'https://world.nol.com/zh-CN/ticket/places/26001167/products/26013793';
const packageUrl = 'https://world.nol.com/zh-CN/ticket/places/26001167/products/26013792';
const profileInput = {
  id: 'profile-test', label: '测试联系人', lastName: 'WANG', firstName: 'YAN',
  email: 'test@example.com', countryCode: '+86', phone: '138-0013 8000'
};
const profiles = [H.normalizeProfile(profileInput)];

function taskInput(overrides = {}) {
  return {
    id: 'task-test', name: '普通票测试', productName: 'JEONGHAN X JOSHUA',
    productUrl: ticketUrl, goodsCode: '26013793', placeCode: '26001167',
    kind: 'ticket', stage: 'general', openAt: new Date(OPEN).toISOString(), officialEndAt: '2026-10-31T02:00:59.000Z',
    quantity: 2, maxTotal: null, currency: 'KRW', profileId: 'profile-test',
    alternatives: [{date: '2026-10-30', time: '19:00', seatGrade: '1', priceGrade: 'U1', people: 1, zones: ['A', 'B']}],
    ...overrides
  };
}

function ticketTask(overrides = {}) {
  return H.validateTask(taskInput(overrides), profiles, NOW);
}

function officialProduct(overrides = {}) {
  return {
    opening: {general: new Date(OPEN).toISOString(), generalEnd: '2026-10-31T02:00:59.000Z'},
    presaleChoices: [{seq: '170194', label: 'Membership Member', openAt: '2026-10-08T11:00:00.000Z', endAt: '2026-10-08T14:59:00.000Z'}],
    ...overrides
  };
}

function packageTask(overrides = {}) {
  return ticketTask({
    name: '双人套餐测试', productUrl: packageUrl, goodsCode: '26013792',
    kind: 'package', quantity: 1, maxTotal: null,
    alternatives: [{date: '2026-10-30', time: '19:00', packageLabel: 'INSPIRE Twin', seatGrade: '1', priceGrade: 'U1', people: 2, zones: []}],
    ...overrides
  });
}

function ticketOrder(overrides = {}) {
  return {
    goodsCode: '26013793', placeCode: '26001167', date: '2026-10-30', time: '19:00',
    seatGrade: '1', priceGrade: 'U1', zone: 'A', quantity: 2,
    total: 300000, currency: 'KRW', feesKnown: true, available: true,
    ...overrides
  };
}

function packageOrder(overrides = {}) {
  return ticketOrder({
    goodsCode: '26013792', packageLabel: 'INSPIRE Twin', people: 2,
    quantity: 1, zone: '', total: 1800000, ...overrides
  });
}

test('商品链接只绑定官方 HTTPS 商品；相似域名、凭据和改写编号被拒绝', () => {
  const parsed = H.parseProductUrl(`${ticketUrl}?tracking=example#detail`);
  assert.equal(parsed.goodsCode, '26013793');
  assert.equal(parsed.placeCode, '26001167');
  assert.equal(parsed.url, ticketUrl);
  for (const url of [
    ticketUrl.replace('world.nol.com', 'world.nol.com.example.org'),
    ticketUrl.replace('https:', 'http:'),
    ticketUrl.replace('https://', 'https://user:password@'),
    'https://world.nol.com/zh-CN/my-info'
  ]) assert.throws(() => H.parseProductUrl(url), `不应接受 ${url}`);
  assert.throws(() => ticketTask({goodsCode: '26013792'}));
  assert.throws(() => ticketTask({placeCode: '99999999'}));
});

test('缺少联系人、非韩元订单或购票选择时不能启用；旧预算统一视为无上限', () => {
  for (const change of [
    {profileId: ''}, {profileId: 'missing-profile'}, {currency: 'USD'}, {alternatives: []}
  ]) assert.throws(() => ticketTask(change));
  for (const maxTotal of [undefined, null, 0, 310000, Infinity]) assert.equal(ticketTask({maxTotal}).maxTotal, null);
  for (const quantity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => ticketTask({quantity}), `不应接受数量 ${quantity}`);
  }
});

test('错误的联系人信息不能成为可使用配置；格式化电话不会改变号码', () => {
  assert.equal(profiles[0].phone, '13800138000');
  for (const change of [
    {firstName: ''}, {lastName: ''}, {email: 'not-an-email'},
    {phone: '13800ABC'}, {countryCode: '86'}
  ]) assert.throws(() => H.normalizeProfile({...profileInput, ...change}));
});

test('过去开售需明确立即模式；无时区时间不能按本机时区猜测', () => {
  const past = taskInput({openAt: new Date(NOW - 1000).toISOString()});
  assert.throws(() => H.validateTask(past, profiles, NOW));
  assert.doesNotThrow(() => H.validateTask(past, profiles, NOW, true));
  assert.throws(() => ticketTask({openAt: '2026-10-12T19:00:00'}));
  assert.throws(() => ticketTask({openAt: 'not-a-date'}));
});

test('任务时间来源只允许官网；旧手动来源不可继续沿用', () => {
  assert.equal(ticketTask().openAtSource, 'official');
  assert.equal(ticketTask({stage: 'presale', openAtSource: 'official', preSaleSeq: 170194}).preSaleSeq, '170194');
  assert.throws(() => ticketTask({openAtSource: 'manual'}));
  assert.throws(() => ticketTask({officialEndAt: undefined}));
  assert.throws(() => ticketTask({officialEndAt: new Date(OPEN).toISOString()}));
});

test('官网普通开售与唯一有效预售分别选择正确的时间和预售编号', () => {
  const product = officialProduct();
  const regular = H.selectOfficialOpening(product, 'general');
  assert.equal(regular.openAt, product.opening.general);
  assert.equal(regular.endAt, product.opening.generalEnd);
  assert.equal(regular.preSaleSeq, '');
  const presale = H.selectOfficialOpening(product, 'presale');
  assert.equal(presale.openAt, product.presaleChoices[0].openAt);
  assert.equal(presale.endAt, product.presaleChoices[0].endAt);
  assert.equal(presale.preSaleSeq, '170194');
});

test('多个预售不能默认选择第一项；必须明确匹配官网预售编号', () => {
  const product = officialProduct();
  product.presaleChoices.push({seq: '170195', label: 'Second membership', openAt: '2026-10-09T11:00:00.000Z', endAt: '2026-10-09T14:59:00.000Z'});
  assert.throws(() => H.selectOfficialOpening(product, 'presale'));
  assert.throws(() => H.selectOfficialOpening(product, 'presale', 'not-official'));
  const selected = H.selectOfficialOpening(product, 'presale', '170195');
  assert.equal(selected.openAt, '2026-10-09T11:00:00.000Z');
  assert.equal(selected.preSaleSeq, '170195');
});

test('缺少或无效的官网时间不能退回商品日期、手填时间或缓存', () => {
  const product = officialProduct();
  for (const general of ['', undefined, 'not-a-date', '2026-10-12T19:00:00']) {
    assert.throws(() => H.selectOfficialOpening({...product, opening: {general}, openAt: new Date(OPEN).toISOString()}, 'general'));
  }
  assert.throws(() => H.selectOfficialOpening({...product, presaleChoices: []}, 'presale'));
  assert.throws(() => H.selectOfficialOpening({...product, presaleChoices: [{seq: '1', openAt: 'not-a-date'}]}, 'presale'));
  for (const generalEnd of ['', undefined, new Date(OPEN).toISOString(), new Date(OPEN - 1).toISOString()]) {
    assert.throws(() => H.selectOfficialOpening({...product, opening: {...product.opening, generalEnd}}, 'general'));
  }
});

test('不可能的演出日期和时刻不能保存为场次', () => {
  const base = taskInput().alternatives[0];
  for (const change of [{date: '2026-02-30'}, {date: '2026-13-01'}, {time: '24:00'}, {time: '19:60'}]) {
    assert.throws(() => ticketTask({alternatives: [{...base, ...change}]}));
  }
});

test('套餐必须明确档位或名称，并保留合法的每份人数', () => {
  const base = taskInput().alternatives[0];
  assert.throws(() => packageTask({alternatives: [{...base, seatGrade: '', priceGrade: '', packageLabel: '', people: 2}]}));
  for (const people of [0, -1, 1.5, Infinity]) {
    assert.throws(() => packageTask({alternatives: [{...base, people}]}), `不应把人数 ${people} 静默改成其他人数`);
  }
});

test('开售前绝不触发；达到时间且前台活跃才触发', () => {
  const base = {openAt: OPEN, visible: true, entryClaimed: false};
  assert.equal(H.classifyTrigger({...base, now: OPEN - 1, lastTick: OPEN - 200}), 'wait');
  assert.equal(H.classifyTrigger({...base, now: OPEN, lastTick: OPEN - 200}), 'fire');
  assert.equal(H.classifyTrigger({...base, openAt: new Date(OPEN).toISOString(), now: OPEN + 300, lastTick: OPEN}), 'fire');
});

test('入口领取后即使再次计时或切换前后台也不能重复触发', () => {
  for (const change of [
    {now: OPEN, visible: true}, {now: OPEN + 100, visible: true},
    {now: OPEN + 10000, visible: false}, {now: OPEN - 1, visible: true}
  ]) {
    assert.equal(H.classifyTrigger({openAt: OPEN, lastTick: OPEN - 100, entryClaimed: true, ...change}), 'claimed');
  }
});

test('后台到时、休眠大跳及错过开售窗口不会静默补触发', () => {
  const base = {openAt: OPEN, entryClaimed: false};
  assert.equal(H.classifyTrigger({...base, now: OPEN - 100, lastTick: OPEN - 200, visible: false}), 'hidden');
  assert.equal(H.classifyTrigger({...base, now: OPEN + 10, lastTick: OPEN, visible: false}), 'hidden');
  assert.equal(H.classifyTrigger({...base, now: OPEN + 1000, lastTick: OPEN - 2000, visible: true}), 'missed');
  assert.equal(H.classifyTrigger({...base, now: OPEN + 5001, lastTick: OPEN + 4900, visible: true}), 'missed');
  assert.equal(H.classifyTrigger({...base, now: OPEN + 60000, lastTick: OPEN - 1000, visible: true}), 'missed');
  assert.equal(H.classifyTrigger({...base, now: NaN, lastTick: OPEN, visible: true}), 'missed');
});

test('中韩开售时间换算跨午夜时保留正确日期', () => {
  const times = H.formatTimes('2026-10-30T15:30:00Z');
  assert.match(times.beijing, /2026[/-]10[/-]30/);
  assert.match(times.beijing, /23:30/);
  assert.match(times.korea, /2026[/-]10[/-]31/);
  assert.match(times.korea, /00:30/);
});

test('订单商品、场地、日期、指定时间、座区与数量必须匹配任务', () => {
  const task = ticketTask();
  assert.equal(H.checkOrder(task, ticketOrder()).ok, true);
  for (const change of [
    {goodsCode: '26013792'}, {placeCode: '99999999'}, {date: '2026-10-31'},
    {time: '20:00'}, {time: undefined}, {zone: 'C'}, {quantity: 1}, {quantity: 3}
  ]) assert.equal(H.checkOrder(task, ticketOrder(change)).ok, false, JSON.stringify(change));
});

test('确认的高金额不受旧预算限制；含费金额未知、无效或币种不符仍暂停', () => {
  const task = ticketTask({maxTotal: 310000});
  assert.equal(task.maxTotal, null);
  assert.equal(H.checkOrder(task, ticketOrder({total: 90000000})).ok, true);
  assert.equal(H.checkOrder({...task, maxTotal: 1}, ticketOrder({total: 90000000})).ok, true);
  for (const change of [
    {feesKnown: false}, {feesKnown: undefined},
    {total: undefined}, {total: NaN}, {total: Infinity}, {total: 0},
    {total: -1}, {currency: 'USD'}, {currency: undefined}
  ]) assert.equal(H.checkOrder(task, ticketOrder(change)).ok, false, JSON.stringify(change));
});

test('双人套餐一份与两份、其他人数或其他档位不能混同', () => {
  const task = packageTask();
  assert.equal(H.checkOrder(task, packageOrder()).ok, true);
  for (const change of [
    {quantity: 2}, {people: 1}, {people: undefined}, {seatGrade: '2'}, {priceGrade: 'U2'}
  ]) assert.equal(H.checkOrder(task, packageOrder(change)).ok, false, JSON.stringify(change));
  const named = packageTask({alternatives: [{date: '2026-10-30', time: '19:00', packageLabel: 'INSPIRE Twin', seatGrade: '', priceGrade: '', people: 2, zones: []}]});
  assert.equal(H.checkOrder(named, packageOrder({packageLabel: 'Other Hotel Twin'})).ok, false);
});

test('购票优先顺序先于价格；较便宜场次不能越过前面的可用选择', () => {
  const task = ticketTask({alternatives: [
    {date: '2026-10-30', time: '19:00', people: 1, zones: ['A']},
    {date: '2026-10-31', time: '18:00', people: 1, zones: ['B']}
  ]});
  const first = ticketOrder({marker: 'first', total: 90000000});
  const later = ticketOrder({marker: 'later-cheaper', date: '2026-10-31', time: '18:00', zone: 'B', total: 200000});
  assert.equal(H.pickAlternative(task, [later, first]).marker, 'first');
  assert.equal(H.pickAlternative(task, [later, {...first, available: false}]).marker, 'later-cheaper');
});

test('同场次先座区优先再低价；不可用、费用未知或错误商品不能参与排序', () => {
  const task = ticketTask();
  const best = ticketOrder({marker: 'A-cheap', zone: 'A', total: 280000});
  const items = [
    ticketOrder({marker: 'B-cheaper', zone: 'B', total: 240000}),
    ticketOrder({marker: 'unavailable', available: false, total: 100000}),
    ticketOrder({marker: 'unknown-fees', feesKnown: false, total: 100000}),
    ticketOrder({marker: 'wrong-product', goodsCode: '26013792', total: 100000}),
    ticketOrder({marker: 'A-expensive', zone: 'A', total: 300000}),
    best
  ];
  assert.equal(H.pickAlternative(task, items).marker, 'A-cheap');
  assert.equal(H.pickAlternative(task, items.slice(1, 4)), null);
});

test('套餐遵循购票优先顺序，高价不导致转向后面的酒店', () => {
  const task = packageTask({alternatives: [
    {date: '2026-10-30', time: '19:00', seatGrade: '1', priceGrade: 'U1', people: 2, zones: []},
    {date: '2026-10-30', time: '19:00', seatGrade: '3', priceGrade: 'U1', people: 2, zones: []}
  ]});
  const preferred = packageOrder({marker: 'preferred-hotel', total: 1800000});
  const cheaper = packageOrder({marker: 'cheaper-hotel', seatGrade: '3', total: 1690000});
  assert.equal(H.pickAlternative(task, [cheaper, preferred]).marker, 'preferred-hotel');
  assert.equal(H.pickAlternative(task, [cheaper, {...preferred, total: 2000001}]).marker, 'preferred-hotel');
  assert.equal(H.pickAlternative(task, [cheaper, {...preferred, available: false}]).marker, 'cheaper-hotel');
});

test('诊断导出保留状态，移除意外附带的联系人和会话凭据', () => {
  const secrets = ['private.person@example.com', 'TOKEN_SECRET_TEST', 'COOKIE_SECRET_TEST', 'PHONE_SECRET_TEST'];
  const run = {
    id: 'run-test', taskId: 'task-test', status: 'manual', step: 'login',
    reason: '等待人工登录', entryClaimed: true,
    profile: {email: secrets[0], phone: secrets[3]}, token: secrets[1], cookie: secrets[2],
    events: [{at: NOW, step: 'login', reason: '等待人工登录', payload: {token: secrets[1], email: secrets[0]}}]
  };
  const exported = H.redactedRun(run);
  assert.equal(exported.status, 'manual');
  assert.equal(exported.events[0].step, 'login');
  for (const secret of secrets) assert.equal(JSON.stringify(exported).includes(secret), false);
  assert.equal(run.profile.email, secrets[0], '导出不能修改本机运行对象');
});
