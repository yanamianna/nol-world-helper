'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const productName = 'JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON';
const scheduleText = '2026.10.30(周五) 7:00 PM';
const mapSource = '//ent-ticketimage.interparkcdn.net/svg/26001167/087dd34c78914d7c972c56fc356b0e3b.svg';
const selectors = {
  title:'h3.SubHeader_headerTitle___LjIv', schedule:'span.SubHeader_scheduleDate__UaD4B',
  image:'div.SeatMap_blockImg__QQUF7 img[alt="blockImg"]', layer:'div.ModalCaptchaText_layerWrap__jn1bV',
  heading:':scope > h2.ModalCaptchaText_title__uRyg7', input:'input[placeholder="請輸入畫面的文字 (不區分大小寫)"]'
};

function adapter() {
  class RouteURL extends URL {
    get search() { throw new Error('booking query must not be read'); }
    get searchParams() { throw new Error('booking query must not be read'); }
    get hash() { throw new Error('booking fragment must not be read'); }
  }
  const context = vm.createContext({URL:RouteURL, fetch() { throw new Error('read-only booking adapter cannot fetch'); }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../adapters/global.js'), 'utf8'), context);
  return context.NolHelper.adapters.global;
}

function element(textContent='', selections={}, attributes={}) {
  return {
    textContent, selections, attributes, hidden:false, style:{display:'block',visibility:'visible',opacity:'1'},
    querySelectorAll(selector) { return this.selections[selector] || []; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    getClientRects() { return [{width:100,height:30}]; },
    click() { throw new Error('read-only booking adapter cannot click'); }
  };
}

function fixture({captcha=true, url='https://tickets.interpark.com/onestop/seat', task={}}={}) {
  // Minimal nodes recorded from the actual desktop page on 2026-10-08.
  // No challenge image/value, browser state, key, query or credentials.
  const title = element(productName), schedule = element(scheduleText);
  const image = element('', {}, {src:mapSource,alt:'blockImg'});
  const heading = element('請輸入畫面的文字');
  const input = element('', {}, {placeholder:'請輸入畫面的文字 (不區分大小寫)'});
  Object.defineProperty(input, 'value', {get() { throw new Error('CAPTCHA value must not be read'); },set() { throw new Error('CAPTCHA value must not be written'); }});
  const button = element('完成輸入');
  const layer = element('', {[selectors.heading]:[heading],[selectors.input]:[input],button:[button]});
  const doc = element('', {[selectors.title]:[title],[selectors.schedule]:[schedule],[selectors.image]:[image],[selectors.layer]:captcha?[layer]:[]});
  doc.location = {href:url, reload() { throw new Error('read-only adapter cannot reload'); }};
  doc.defaultView = {getComputedStyle(node) { return node.style; }};
  const ctx = {task:{productName,goodsCode:'26013793',placeCode:'26001167',...task}, requestEntry() { throw new Error('seat observation cannot enter'); }};
  return {doc,ctx,title,schedule,image,heading,input,button,layer};
}

function expiredDialog(f) {
  const title=element('10分钟的座位选择时间已超过');
  const description=element('请重新开始预订');
  const button=element('确定');
  const dialog=element('',{':scope > div.nds-e-dialog__title':[title],':scope > div.nds-e-dialog__description':[description],button:[button]});
  f.doc.selections['[role="dialog"][aria-modal="true"]']=[dialog];
  f.doc.selections['div.nds-e-dialog__container[role="dialog"][aria-modal="true"]']=[dialog];
  return {dialog,title,description,button};
}

test('the observed ordinary-ticket seat page reports visible CAPTCHA and remains manual', () => {
  const global = adapter(), f = fixture();
  const state = global.inspect(f.doc,f.ctx);
  assert.equal(state.kind,'captcha');
  assert.equal(state.verified,true);
  assert.equal(state.route,'onestop-seat');
  assert.equal(state.code,'SEAT_CAPTCHA_REQUIRED');
  assert.equal(state.productName,productName);
  assert.equal(state.scheduleText,scheduleText);
  assert.ok(state.reason.includes(productName) && state.reason.includes(scheduleText));
  assert.match(state.reason,/本人.*验证码/);
  assert.equal(global.step(f.doc,f.ctx).status,'manual');
  assert.equal(global.step(f.doc,f.ctx).code,'SEAT_CAPTCHA_REQUIRED');
});

test('an observed seat page without a visible CAPTCHA remains manual with unverified seat and hold actions', () => {
  const global = adapter(), f = fixture({captcha:false});
  const state = global.inspect(f.doc,f.ctx);
  assert.equal(state.kind,'seat');
  assert.equal(state.verified,true);
  assert.equal(state.code,'SEAT_PAGE_MANUAL');
  assert.match(state.reason,/选座与锁座尚未验证/);
  assert.equal(global.step(f.doc,f.ctx).status,'manual');
  assert.throws(() => global.enter(f.doc,f.ctx), error => error.code==='GLOBAL_DOM_UNVERIFIED');
});

test('the observed expiry dialog takes precedence over CAPTCHA even after the map unmounts', () => {
  const global=adapter();
  for(const removeMap of [false,true]) {
    const f=fixture();expiredDialog(f);
    if(removeMap) f.doc.selections[selectors.image]=[];
    Object.defineProperty(f.heading,'textContent',{get(){throw new Error('expired session must not inspect CAPTCHA');}});
    const state=global.inspect(f.doc,f.ctx);
    assert.equal(state.kind,'expired');
    assert.equal(state.verified,true);
    assert.equal(state.code,'SEAT_SESSION_EXPIRED');
    assert.match(state.reason,/已过期/);
    assert.match(state.reason,/不会.*自动重新入场/);
    assert.equal(global.step(f.doc,f.ctx).status,'manual');
    assert.equal(global.step(f.doc,f.ctx).code,'SEAT_SESSION_EXPIRED');
  }
});

test('an unknown or changed visible modal remains unknown instead of requesting CAPTCHA', () => {
  const global=adapter();
  for(const change of [
    (f,d)=>{d.title.textContent='Unknown notice';},
    (f,d)=>{d.description.textContent='Changed description';},
    (f,d)=>{d.button.textContent='Other action';},
    (f,d)=>{f.doc.selections['div.nds-e-dialog__container[role="dialog"][aria-modal="true"]']=[];},
    (f,d)=>{f.doc.selections['[role="dialog"][aria-modal="true"]']=[d.dialog,d.dialog];}
  ]) {
    const f=fixture(), d=expiredDialog(f);change(f,d);
    const state=global.inspect(f.doc,f.ctx);
    assert.equal(state.verified,false);
    assert.equal(state.code,'SEAT_MODAL_UNVERIFIED');
    assert.equal(global.step(f.doc,f.ctx).status,'manual');
  }
});

test('hidden expiry dialog does not override a currently visible CAPTCHA', () => {
  const global=adapter();
  for(const hide of [dialog=>{dialog.hidden=true;},dialog=>{dialog.getClientRects=()=>[];},dialog=>{dialog.style.display='none';}]) {
    const f=fixture(), d=expiredDialog(f);hide(d.dialog);
    Object.defineProperty(d.title,'textContent',{get(){throw new Error('hidden expiry must not be inspected');}});
    assert.equal(global.inspect(f.doc,f.ctx).code,'SEAT_CAPTCHA_REQUIRED');
    assert.equal(global.step(f.doc,f.ctx).status,'manual');
  }
});

test('hidden or unrendered challenge layers never produce a CAPTCHA-required false positive', () => {
  const global = adapter();
  for (const hide of [
    f => {f.layer.hidden=true;},
    f => {f.layer.getClientRects=()=>[];},
    f => {f.layer.style.display='none';},
    f => {f.layer.style.visibility='hidden';},
    f => {f.layer.style.opacity='0';},
    f => {f.layer.parentElement=element();f.layer.parentElement.style.display='none';}
  ]) {
    const f = fixture();hide(f);
    Object.defineProperty(f.heading,'textContent',{get() {throw new Error('hidden challenge must not be inspected');}});
    assert.equal(global.inspect(f.doc,f.ctx).code,'SEAT_PAGE_MANUAL');
    assert.equal(global.step(f.doc,f.ctx).status,'manual');
  }
});

test('the full task product name, observed goods code and place code are required together', () => {
  const global = adapter();
  for (const task of [
    {productName:''},{productName:'JEONGHAN X JOSHUA'},
    {productName:productName+' + Hotels'}, {productName:productName.replace('INCHEON','SEOUL')},
    {goodsCode:'26013792'},{goodsCode:''},{placeCode:'26001168'},{placeCode:''}
  ]) {
    const f=fixture({task});
    assert.equal(global.inspect(f.doc,f.ctx).verified,false,JSON.stringify(task));
    assert.equal(global.step(f.doc,f.ctx).status,'manual');
  }
  const f=fixture({task:{productName:'jeonghan x joshua journey into [DREAMING] - INCHEON'}});
  assert.equal(global.inspect(f.doc,f.ctx).verified,true);
});

test('a matching task and DOM for an unobserved performance do not broaden this adapter', () => {
  const global=adapter(), f=fixture({task:{productName:'Other performance'}});
  f.title.textContent='Other performance';
  assert.equal(global.inspect(f.doc,f.ctx).code,'SEAT_PRODUCT_MISMATCH');
  assert.equal(global.step(f.doc,f.ctx).status,'manual');
});

test('missing, duplicated or changed title and schedule structures stay unknown', () => {
  const global=adapter();
  for (const change of [
    f=>{f.doc.selections[selectors.title]=[];},
    f=>{f.doc.selections[selectors.title]=[f.title,f.title];},
    f=>{f.title.textContent='Other performance';},
    f=>{f.doc.selections[selectors.schedule]=[];},
    f=>{f.doc.selections[selectors.schedule]=[f.schedule,f.schedule];},
    f=>{f.schedule.textContent='2026.10.31(周六) 7:00 PM';},
    f=>{f.doc.selections['iframe, frame']=[element()];}
  ]) {
    const f=fixture();change(f);
    assert.equal(global.inspect(f.doc,f.ctx).verified,false);
    assert.equal(global.step(f.doc,f.ctx).status,'manual');
  }
});

test('the mobile duplicate title is not confused with the observed desktop title', () => {
  const global=adapter(), f=fixture();
  f.doc.selections['h3.SubHeader_scheduleTitle__SB1gB']=[element(productName)];
  assert.equal(global.inspect(f.doc,f.ctx).verified,true);
  f.doc.selections[selectors.title]=[];
  assert.equal(global.inspect(f.doc,f.ctx).verified,false);
});

test('hidden seat layout retained under another step never verifies as the visible seat page', () => {
  const global=adapter();
  for (const name of ['title','schedule','image']) {
    for (const hide of [node=>{node.hidden=true;},node=>{node.getClientRects=()=>[];},node=>{node.style.display='none';}]) {
      const f=fixture({url:'https://tickets.interpark.com/onestop/seat?step=price'});
      hide(f[name]);
      assert.equal(global.inspect(f.doc,f.ctx).verified,false,name);
      assert.equal(global.step(f.doc,f.ctx).status,'manual',name);
    }
  }
});

test('the map must be the observed exact image for the configured venue', () => {
  const global=adapter();
  for (const src of [
    mapSource.replace('26001167','26001168'),mapSource.replace('ent-ticketimage.interparkcdn.net','example.test'),
    mapSource.replace('087dd34c78914d7c972c56fc356b0e3b','different-map'),
    'http:'+mapSource,mapSource+'?token=UNREAD_PRIVATE_SENTINEL',mapSource+'#unknown'
  ]) {
    const f=fixture();f.image.attributes.src=src;
    assert.equal(global.inspect(f.doc,f.ctx).code,'SEAT_MAP_UNVERIFIED');
    assert.equal(global.step(f.doc,f.ctx).status,'manual');
  }
  const f=fixture();f.image.attributes.src='https:'+mapSource;
  assert.equal(global.inspect(f.doc,f.ctx).verified,true);
  for (const images of [[],[f.image,f.image]]) {
    f.doc.selections[selectors.image]=images;
    assert.equal(global.inspect(f.doc,f.ctx).code,'SEAT_MAP_UNVERIFIED');
  }
});

test('visible challenge controls require the actual observed labels and unique input/button', () => {
  const global=adapter();
  for (const change of [
    f=>{f.heading.textContent='Different verification';},
    f=>{f.layer.selections[selectors.heading]=[];},
    f=>{f.layer.selections[selectors.input]=[];},
    f=>{f.layer.selections[selectors.input]=[f.input,f.input];},
    f=>{f.input.getClientRects=()=>[];},
    f=>{f.button.textContent='Next';},
    f=>{f.layer.selections.button=[f.button,f.button];},
    f=>{f.doc.selections[selectors.layer]=[f.layer,f.layer];}
  ]) {
    const f=fixture();change(f);
    assert.equal(global.inspect(f.doc,f.ctx).code,'SEAT_DOM_UNVERIFIED');
    assert.equal(global.step(f.doc,f.ctx).status,'manual');
  }
});

test('only the exact observed seat route can use this recognition', () => {
  const global=adapter();
  for (const url of [
    'https://tickets.interpark.com/onestop/schedule','https://tickets.interpark.com/onestop/seat/',
    'https://ticket.globalinterpark.com/onestop/seat','http://tickets.interpark.com/onestop/seat',
    'https://user@tickets.interpark.com/onestop/seat','https://tickets.interpark.com:444/onestop/seat',
    'https://tickets.interpark.com.evil.test/onestop/seat'
  ]) {
    const f=fixture({url});
    assert.equal(global.inspect(f.doc,f.ctx).verified,false,url);
    assert.equal(global.step(f.doc,f.ctx).status,'manual',url);
  }
});

test('seat-page recognition never reads or returns query and fragment contents', () => {
  const global=adapter(), sentinel='PRIVATE_BOOKING_SENTINEL';
  const f=fixture({url:'https://tickets.interpark.com/onestop/seat?ignored='+sentinel+'#'+sentinel});
  assert.equal(global.inspect(f.doc,f.ctx).verified,true);
  assert.equal(JSON.stringify(global.inspect(f.doc,f.ctx)).includes(sentinel),false);
  assert.equal(JSON.stringify(global.step(f.doc,f.ctx)).includes(sentinel),false);
});

test('observing the same page stays read-only and never reads or enters a CAPTCHA value', () => {
  const global=adapter(), f=fixture();
  const before={title:f.title.textContent,schedule:f.schedule.textContent,src:f.image.attributes.src,button:f.button.textContent};
  for(let index=0;index<2;index++) assert.equal(global.step(f.doc,f.ctx).status,'manual');
  assert.deepEqual({title:f.title.textContent,schedule:f.schedule.textContent,src:f.image.attributes.src,button:f.button.textContent},before);
  delete f.layer.getClientRects;
  assert.equal(global.inspect(f.doc,f.ctx).code,'SEAT_CAPTCHA_REQUIRED');
});
