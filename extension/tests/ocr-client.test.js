'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ocr-client.js'), 'utf8');
// Arbitrary synthetic bytes test the client's format boundary only.
const image = 'data:image/png;base64,AAEC';
const secret = 'SYNTHETIC_PRIVATE_OCR_SENTINEL';
const plain = (value) => JSON.parse(JSON.stringify(value));

function response(data, options = {}) {
  let textReads = 0;
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    get textReads() { return textReads; },
    async text() { textReads += 1; if (options.textError) throw options.textError; return options.text === undefined ? JSON.stringify(data) : options.text; },
    async json() { throw new Error('client must validate bounded Response.text before parsing JSON'); }
  };
}

function harness(options = {}) {
  const calls = {permissions:[],fetch:[],cleared:[]};
  const timers = new Map();
  let nextTimer = 1;
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const settings = {permission:true,...options};
  const api = {
    runtime:{id:'synthetic-extension-id'},
    permissions:{async contains(value) {
      calls.permissions.push(plain(value));
      if (settings.permissionError) throw settings.permissionError;
      return settings.permission;
    }}
  };
  const context = vm.createContext({
    AbortController,
    setTimeout(callback, delay) { const id=nextTimer++; timers.set(id,{callback,delay}); return id; },
    clearTimeout(id) { calls.cleared.push(id); timers.delete(id); }
  });
  vm.runInContext(source, context, {filename:'ocr-client.js'});
  const client = context.NolHelper.localOCR.create(api, async (url, init) => {
    calls.fetch.push({url,init});
    resolveStarted(true);
    if (settings.fetcher) return settings.fetcher(url,init);
    return response(url.endsWith('/health') ? {ok:true,engine:'ddddocr'} : {ok:true,recognized:true,candidate:'ABCDEF'});
  });
  return {client,calls,timers,started,settings};
}

function rejectsCode(action, code) {
  return assert.rejects(() => Promise.resolve().then(action), (error) => {
    assert.equal(error.code, code);
    assert.equal(String(error.message).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
}

test('enabled checks only the optional loopback origin and makes no HTTP request', async () => {
  const h = harness();
  assert.equal(await h.client.enabled(), true);
  h.settings.permission = false;
  assert.equal(await h.client.enabled(), false);
  assert.deepEqual(h.calls.permissions,[{origins:['http://127.0.0.1/*']},{origins:['http://127.0.0.1/*']}]);
  assert.equal(h.calls.fetch.length,0);
});

test('missing permission prevents health and recognition network calls', async () => {
  const h = harness({permission:false});
  await rejectsCode(() => h.client.health(),'OCR_PERMISSION_REQUIRED');
  await rejectsCode(() => h.client.recognize(image),'OCR_PERMISSION_REQUIRED');
  assert.equal(h.calls.fetch.length,0);
  assert.equal(h.timers.size,0);
  h.settings.permission = true;
  assert.equal((await h.client.health()).ready,true);
});

test('health uses a fixed GET with extension identity, no credentials and a bounded deadline', async () => {
  const body = response({ok:true,engine:'ddddocr',image:secret,raw:secret,token:secret});
  const h = harness({fetcher:async () => body});
  assert.deepEqual(plain(await h.client.health()),{ready:true,engine:'ddddocr'});
  const {url,init}=h.calls.fetch[0];
  assert.equal(url,'http://127.0.0.1:8765/health');
  assert.equal(init.method,'GET');
  assert.equal(init.credentials,'omit');
  assert.equal(init.redirect,'error');
  assert.equal(init.cache,'no-store');
  assert.deepEqual(plain(init.headers),{'X-NOL-Extension-Id':'synthetic-extension-id'});
  assert.equal(Object.hasOwn(init,'body'),false);
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.textReads,1);
  assert.equal(h.timers.size,0);
  assert.equal(h.calls.cleared.length,1);
});

test('recognize POST sends only image bytes and returns only the validated six-letter candidate', async () => {
  const h = harness({fetcher:async () => response({ok:true,recognized:true,candidate:'ABCDEF',image:secret,raw:secret,confidence:secret,debug:{token:secret}})});
  const result = plain(await h.client.recognize(image));
  assert.deepEqual(Object.keys(result).sort(),['candidate','reason','recognized']);
  assert.equal(result.recognized,true);
  assert.equal(result.candidate,'ABCDEF');
  assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(JSON.stringify(result).includes('AAEC'),false);
  const {url,init}=h.calls.fetch[0];
  assert.equal(url,'http://127.0.0.1:8765/recognize');
  assert.equal(init.method,'POST');
  assert.equal(init.credentials,'omit');
  assert.equal(init.redirect,'error');
  assert.equal(init.cache,'no-store');
  assert.deepEqual(JSON.parse(init.body),{image:'AAEC'});
  assert.deepEqual(plain(init.headers),{'X-NOL-Extension-Id':'synthetic-extension-id','Content-Type':'application/json'});
});

test('malformed images are rejected before permission checks or network access', async () => {
  const h = harness();
  for (const value of [undefined,null,123,{},'', 'https://example.test/image.png','data:image/svg+xml;base64,AAEC','data:image/png;base64,','data:image/png;base64,AAA','data:image/png;base64,AA=E','data:image/png;base64,AAAA====','data:image/png;base64,AAEC\n','data:image/png;foo=x;base64,AAEC']) {
    await rejectsCode(() => h.client.recognize(value),'OCR_IMAGE_INVALID');
  }
  assert.equal(h.calls.permissions.length,0);
  assert.equal(h.calls.fetch.length,0);
});

test('image size is bounded while supported synthetic JPEG and WebP bodies remain valid', async () => {
  const h = harness();
  await rejectsCode(() => h.client.recognize('data:image/png;base64,'+'A'.repeat(500000)),'OCR_IMAGE_INVALID');
  assert.equal(h.calls.fetch.length,0);
  for (const type of ['jpeg','webp']) assert.equal((await h.client.recognize(`data:image/${type};base64,AAEC`)).recognized,true);
  assert.equal(h.calls.fetch.length,2);
});

test('nonmatching recognition values never return raw candidates or confidential fields', async () => {
  const h = harness();
  for (const candidate of ['',null,123,'ABCDE','ABCDEFG','abcDEF','ABC12F','ABC DEF','ＡＢＣＤＥＦ',secret]) {
    h.settings.fetcher = async () => response({ok:true,recognized:true,candidate,image:secret,raw:secret});
    const value = plain(await h.client.recognize(image));
    assert.equal(value.recognized,false);
    assert.equal(value.candidate,'');
    assert.equal(JSON.stringify(value).includes(secret),false);
  }
  h.settings.fetcher = async () => response({ok:true,recognized:false,candidate:'ABCDEF',raw:secret});
  assert.equal((await h.client.recognize(image)).recognized,false);
});

test('HTTP errors and invalid JSON/service envelopes are finite safe failures', async () => {
  const h = harness();
  const denied = response({raw:secret},{ok:false,status:403});
  h.settings.fetcher = async () => denied;
  await rejectsCode(() => h.client.health(),'OCR_SERVICE_ERROR');
  assert.equal(denied.textReads,0);
  for (const text of [secret,'null','[]','{"ok":false}',JSON.stringify({ok:true,raw:secret})]) {
    h.settings.fetcher = async () => response(null,{text});
    await rejectsCode(() => h.client.health(),'OCR_RESPONSE_INVALID');
  }
  h.settings.fetcher = async () => response({ok:true,engine:'unknown',raw:secret});
  await rejectsCode(() => h.client.health(),'OCR_RESPONSE_INVALID');
  assert.equal(h.timers.size,0);
});

test('the response text limit rejects oversized bodies and accepts the exact permitted boundary', async () => {
  const h = harness();
  const data = JSON.stringify({ok:true,engine:'ddddocr'});
  h.settings.fetcher = async () => response(null,{text:data.padEnd(4096,' ')});
  assert.equal((await h.client.health()).ready,true);
  h.settings.fetcher = async () => response(null,{text:data.padEnd(4097,' ')});
  await rejectsCode(() => h.client.health(),'OCR_RESPONSE_INVALID');
});

test('one pending request blocks a second request and releases busy state after success', async () => {
  let release;
  const barrier = new Promise((resolve) => { release=resolve; });
  const h = harness({fetcher:async () => {await barrier;return response({ok:true,engine:'ddddocr'});}});
  const pending=h.client.health();
  await h.started;
  assert.equal([...h.timers.values()][0].delay,10000);
  await rejectsCode(() => h.client.recognize(image),'OCR_BUSY');
  assert.equal(h.calls.fetch.length,1);
  release();
  await pending;
  h.settings.fetcher = null;
  assert.equal((await h.client.recognize(image)).recognized,true);
  assert.equal(h.timers.size,0);
});

test('network and redirect exceptions are redacted and failure releases busy state', async () => {
  const h = harness();
  for (const error of [new TypeError(secret+' redirect'),Object.assign(new Error(secret),{code:'OCR_FORGED'}),Object.assign(new Error(secret),{code:20})]) {
    h.settings.fetcher = async () => {throw error;};
    await rejectsCode(() => h.client.health(),'OCR_UNAVAILABLE');
    assert.equal(h.timers.size,0);
    h.settings.fetcher = null;
    assert.equal((await h.client.health()).ready,true);
  }
});

test('permission API exceptions never escape raw or initiate an HTTP request', async () => {
  const h = harness({permissionError:new Error(secret+' permission failure')});
  for (const action of [() => h.client.enabled(),() => h.client.health(),() => h.client.recognize(image)]) await rejectsCode(action,'OCR_UNAVAILABLE');
  assert.equal(h.calls.fetch.length,0);
  h.settings.permissionError = null;
  assert.equal((await h.client.health()).ready,true);
});

test('an aborted fetch returns a safe error and the next request can proceed', async () => {
  const h = harness({fetcher:async (_,init) => new Promise((_,reject) => init.signal.addEventListener('abort',() => reject(new DOMException(secret,'AbortError')),{once:true}))});
  const pending=h.client.health();
  await h.started;
  [...h.timers.values()][0].callback();
  await rejectsCode(() => pending,'OCR_UNAVAILABLE');
  assert.equal(h.calls.fetch[0].init.signal.aborted,true);
  assert.equal(h.timers.size,0);
  h.settings.fetcher = null;
  assert.equal((await h.client.recognize(image)).recognized,true);
});

test('Response.text failures are redacted and do not leave the client busy', async () => {
  const h = harness({fetcher:async () => response(null,{textError:new Error(secret+' response body failure')})});
  await rejectsCode(() => h.client.health(),'OCR_UNAVAILABLE');
  h.settings.fetcher = null;
  assert.equal((await h.client.health()).ready,true);
  assert.equal(h.timers.size,0);
});
