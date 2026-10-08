'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({URL});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'navigation.js'), 'utf8'), context, {filename:'navigation.js'});
const H = context.NolHelper;

function run(overrides = {}) {
  return {id:'run-test', tabId:7, status:'running', entryClaimed:true, apiDispatched:true, entrySubmitted:true, ...overrides};
}
function event(overrides = {}) {
  return {tabId:7, frameId:0, url:'https://tickets.interpark.com/gates/partner?entryToken=synthetic-test-token#synthetic-fragment', error:'net::ERR_CONNECTION_TIMED_OUT', ...overrides};
}

test('当前任务主页面连接超时只输出主机、安全错误码与接管原因', () => {
  const currentRun = run(), details = event();
  const originalRun = JSON.stringify(currentRun), originalEvent = JSON.stringify(details);
  const result = H.navigationFailure(details, currentRun);
  assert.deepEqual(Object.keys(result).sort(), ['errorCode', 'host', 'reason']);
  assert.equal(result.host, 'tickets.interpark.com');
  assert.equal(result.errorCode, 'ERR_CONNECTION_TIMED_OUT');
  assert.match(result.reason, /连接超时/);
  assert.match(result.reason, /人工接管/);
  assert.match(result.reason, /不会自动重试/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic|entryToken|gates\/partner/);
  assert.equal(JSON.stringify(currentRun), originalRun);
  assert.equal(JSON.stringify(details), originalEvent);
});

test('暂停、终止、未进入及其他标签或子框架的错误均忽略', () => {
  for (const status of ['armed', 'paused', 'stopped', 'payment', 'missed', undefined, 'unexpected']) {
    assert.equal(H.navigationFailure(event(), run({status})), null);
  }
  for (const currentRun of [undefined, null, run({entryClaimed:false}), run({entryClaimed:1}), run({tabId:-1}), run({tabId:'7'})]) {
    assert.equal(H.navigationFailure(event(), currentRun), null);
  }
  for (const details of [undefined, null, event({tabId:8}), event({frameId:1}), event({frameId:'0'})]) {
    assert.equal(H.navigationFailure(details, run()), null);
  }
});

test('仅接受三个已验证的官方 HTTPS 精确主机', () => {
  for (const host of ['world.nol.com', 'tickets.interpark.com', 'ticket.globalinterpark.com']) {
    assert.equal(H.navigationFailure(event({url:`https://${host}/booking`}), run()).host, host);
  }
  for (const url of [
    'http://tickets.interpark.com/gates/partner',
    'https://tickets.interpark.com.example.org/gates/partner',
    'https://unknown.interpark.com/gates/partner',
    'https://tickets.interpark.com:8443/gates/partner',
    'https://user:synthetic-password@tickets.interpark.com/gates/partner',
    'chrome-error://chromewebdata/', 'about:blank', '', 'invalid'
  ]) assert.equal(H.navigationFailure(event({url}), run()), null);
});

test('正常取消忽略，等待接管的活动任务仍能识别网络错误', () => {
  for (const error of ['net::ERR_ABORTED', 'ERR_ABORTED']) {
    assert.equal(H.navigationFailure(event({error}), run()), null);
  }
  const result = H.navigationFailure(event({error:'ERR_NAME_NOT_RESOLVED'}), run({status:'waiting-manual'}));
  assert.equal(result.errorCode, 'ERR_NAME_NOT_RESOLVED');
  assert.match(result.reason, /加载失败/);
});

test('未知错误文本和伪装的错误码被收敛为有限的通用错误，不泄露文本', () => {
  for (const error of [undefined, '', 'net::ERR_UNKNOWN_SYNTHETIC_SECRET', 'net::ERR_FAILED?token=synthetic-test-token', 'https://example.org/?token=synthetic-test-token']) {
    const result = H.navigationFailure(event({error}), run());
    assert.equal(result.errorCode, 'NAVIGATION_FAILED');
    assert.doesNotMatch(JSON.stringify(result), /synthetic|example\.org|token=/);
  }
});

test('当前导航匹配优先尚未提交的新页面，旧页面错误和不同会话参数不命中', () => {
  const details = event(), nextUrl = details.url.replace('synthetic-test-token', 'synthetic-new-token');
  assert.equal(H.navigationMatchesTab(details, {id:7, url:details.url}), true);
  assert.equal(H.navigationMatchesTab(details, {id:7, url:'https://world.nol.com/en', pendingUrl:details.url}), true);
  assert.equal(H.navigationMatchesTab(details, {id:7, url:details.url, pendingUrl:nextUrl}), false);
  assert.equal(H.navigationMatchesTab(details, {id:7, url:nextUrl}), false);
  for (const tab of [null, undefined, {id:8, url:details.url}, {id:7}, {id:7, url:''}, {id:7, url:'chrome-error://chromewebdata/'}]) {
    assert.equal(H.navigationMatchesTab(details, tab), false);
  }
});
