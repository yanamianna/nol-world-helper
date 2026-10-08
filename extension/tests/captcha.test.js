'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const productName='JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL9sAAAAASUVORK5CYII=';
const otherPng='data:image/png;base64,iVBORw0KGgo=';
const layerSelector='div.ModalCaptchaText_layerWrap__jn1bV';
const inputSelector='input[placeholder="請輸入畫面的文字 (不區分大小寫)"]';

function load() {
  class RouteURL extends URL {
    get search(){throw Error('query must not be read');}
    get searchParams(){throw Error('query must not be read');}
  }
  const forbidden=()=>{throw Error('no network, storage, canvas or automated events');};
  const context=vm.createContext({URL:RouteURL,fetch:forbidden,XMLHttpRequest:forbidden,localStorage:forbidden,chrome:{storage:forbidden},console:{log:forbidden,error:forbidden}});
  for(const file of ['adapters/global.js','captcha.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
  return {helper:context.NolHelper.captcha,root:context};
}

function element(textContent='',selections={},attributes={}) {
  return {textContent,selections,attributes,hidden:false,isConnected:true,style:{display:'block',visibility:'visible',opacity:'1'},
    querySelectorAll(selector){return this.selections[selector]||[];},
    getAttribute(name){return this.attributes[name]??null;},
    getClientRects(){return [{width:100,height:30}];},
    closest(selector){for(let node=this;node;node=node.parentElement)if(node.selector===selector)return node;return null;},
    click(){throw Error('no clicks');},dispatchEvent(){throw Error('no events');}
  };
}

function fixture() {
  const image=element('',{}, {src:png,alt:'Captcha Image'});
  Object.assign(image,{currentSrc:png,complete:true,naturalWidth:1,naturalHeight:1});
  const input=element('',{},{placeholder:'請輸入畫面的文字 (不區分大小寫)'});
  Object.defineProperty(input,'value',{get(){throw Error('input value must not be read');},set(){throw Error('input must not be filled');}});
  const heading=element('請輸入畫面的文字');
  const layer=element('',{':scope > h2.ModalCaptchaText_title__uRyg7':[heading],[inputSelector]:[input],'img[alt="Captcha Image"]':[image]});
  const content=element('',{':scope > div.ModalCaptchaText_layerWrap__jn1bV':[layer]});
  const footer=element('',{button:[element('完成輸入')]});
  const layout=element('',{':scope > div.ModalLayout_content__Zm2NK':[content],':scope > footer.ModalLayout_footer__88ZwY':[footer]});
  layout.selector='div.ModalLayout_innerWrap__c8kxP';
  layer.parentElement=content;content.parentElement=layout;footer.parentElement=layout;
  for(const node of [image,input,heading])node.parentElement=layer;
  const doc=element('',{
    [layerSelector]:[layer],
    'h3.SubHeader_headerTitle___LjIv':[element(productName)],
    'span.SubHeader_scheduleDate__UaD4B':[element('2026.10.30(周五) 7:00 PM')],
    'div.SeatMap_blockImg__QQUF7 img[alt="blockImg"]':[element('',{}, {alt:'blockImg',src:'//ent-ticketimage.interparkcdn.net/svg/26001167/087dd34c78914d7c972c56fc356b0e3b.svg'})]
  });
  doc.location={href:'https://tickets.interpark.com/onestop/seat?private=UNREAD_SENTINEL'};
  doc.defaultView={getComputedStyle(node){return node.style;}};
  doc.createElement=()=>{throw Error('must not create canvas or another image');};
  Object.defineProperty(doc,'cookie',{get(){throw Error('cookie must not be read');}});
  const ctx={task:{goodsCode:'26013793',placeCode:'26001167',productName}};
  return {doc,ctx,image,input,heading,layer,content,footer,layout};
}

function rejects(helper,f,code){assert.throws(()=>helper.capture(f.doc,f.ctx),error=>error.code===code);}

test('captures only the verified visible displayed image without reading or changing input',()=>{
  const {helper}=load(),f=fixture(),snapshot=helper.capture(f.doc,f.ctx);
  assert.equal(snapshot.imageDataUrl,png);
  assert.equal(snapshot.mimeType,'image/png');
  assert.equal(Object.isFrozen(snapshot),true);
  assert.equal(helper.isCurrent(snapshot,f.doc,f.ctx),true);
  assert.deepEqual(Object.keys(snapshot).sort(),['imageDataUrl','mimeType']);
  assert.equal(JSON.stringify(snapshot).includes('UNREAD_SENTINEL'),false);
  assert.equal(f.image.attributes.src,png);
});

test('requires every verified adapter marker and never examines image when verification fails',()=>{
  const {helper,root}=load();
  for(const state of [{kind:'seat',verified:true,code:'SEAT_CAPTCHA_REQUIRED'},{kind:'captcha',verified:false,code:'SEAT_CAPTCHA_REQUIRED'},{kind:'captcha',verified:true,code:'UNKNOWN'},null]){
    const f=fixture();root.NolHelper.adapters.global={inspect:()=>state};
    f.doc.querySelectorAll=()=>{throw Error('unverified DOM must not be examined');};
    rejects(helper,f,'CAPTCHA_PAGE_UNVERIFIED');
  }
  delete root.NolHelper.adapters.global;
  rejects(helper,fixture(),'CAPTCHA_PAGE_UNVERIFIED');
});

test('the actual adapter rejects other products, expired sessions and a closed challenge',()=>{
  const {helper}=load();
  for(const change of [
    f=>{f.ctx.task.goodsCode='26013792';},
    f=>{f.ctx.task.productName='Other product';},
    f=>{f.doc.location.href='https://tickets.interpark.com/onestop/schedule';},
    f=>{f.layer.hidden=true;},
    f=>{const dialog=element('',{':scope > div.nds-e-dialog__title':[element('10分钟的座位选择时间已超过')],':scope > div.nds-e-dialog__description':[element('请重新开始预订')],button:[element('确定')]});f.doc.selections['[role="dialog"][aria-modal="true"]']=[dialog];f.doc.selections['div.nds-e-dialog__container[role="dialog"][aria-modal="true"]']=[dialog];}
  ]){const f=fixture();change(f);rejects(helper,f,'CAPTCHA_PAGE_UNVERIFIED');}
});

test('capture needs exactly one visible layer and unique visible image and input',()=>{
  const {helper,root}=load();
  // Keep this unit focused on image-level validation even if adapter verification
  // was obtained immediately before the DOM changed.
  root.NolHelper.adapters.global={inspect:()=>({kind:'captcha',verified:true,code:'SEAT_CAPTCHA_REQUIRED'})};
  for(const change of [
    f=>{f.doc.selections[layerSelector]=[];},
    f=>{f.doc.selections[layerSelector]=[f.layer,f.layer];},
    f=>{f.layer.getClientRects=()=>[];},
    f=>{f.layer.selections['img[alt="Captcha Image"]']=[];},
    f=>{f.layer.selections['img[alt="Captcha Image"]']=[f.image,f.image];},
    f=>{f.image.hidden=true;},
    f=>{f.image.isConnected=false;},
    f=>{f.image.style.opacity='0';},
    f=>{f.layer.selections[inputSelector]=[f.input,f.input];},
    f=>{f.input.getClientRects=()=>[];}
  ]){const f=fixture();change(f);rejects(helper,f,'CAPTCHA_DOM_UNVERIFIED');}
});

test('accepts only supported base64 data image sources and never fetches another source',()=>{
  const {helper}=load();
  for(const src of [
    'https://example.test/captcha.png','blob:https://tickets.interpark.com/fixture',
    'data:image/svg+xml;base64,PHN2Zz4=','data:image/gif;base64,R0lGODlh',
    'data:image/png,raw','data:image/png;base64,','data:image/png;base64,abc',
    'data:image/png;base64,a===','data:image/png;base64,abcd\nefgh',
    ' data:image/png;base64,YQ==','data:image/png;charset=utf-8;base64,YQ=='
  ]){
    const f=fixture();f.image.attributes.src=src;f.image.currentSrc=src;
    rejects(helper,f,'CAPTCHA_IMAGE_UNSUPPORTED');
  }
  for(const mime of ['image/png','image/jpeg','image/webp']){
    const f=fixture(),src='data:'+mime+';base64,YWJj';
    f.image.attributes.src=src;f.image.currentSrc=src;
    assert.equal(helper.capture(f.doc,f.ctx).mimeType,mime);
  }
});

test('a displayed currentSrc different from the src attribute is never captured',()=>{
  const {helper}=load(),f=fixture();
  f.image.currentSrc='https://example.test/selected-by-srcset.png';
  rejects(helper,f,'CAPTCHA_IMAGE_UNSUPPORTED');
});

test('unloaded and failed-to-decode images cannot provide a usable snapshot',()=>{
  const {helper}=load();
  for(const change of [f=>{f.image.complete=false;},f=>{f.image.naturalWidth=0;},f=>{f.image.naturalHeight=0;}]){
    const f=fixture();change(f);rejects(helper,f,'CAPTCHA_IMAGE_NOT_READY');
  }
});

test('freshness detects a refresh of source or replacement of image, input and layer nodes',()=>{
  const {helper}=load();
  for(const change of [
    f=>{f.image.attributes.src=otherPng;f.image.currentSrc=otherPng;},
    f=>{f.layer.selections['img[alt="Captcha Image"]']=[{...f.image}];},
    f=>{f.layer.selections[inputSelector]=[{...f.input}];},
    f=>{const replacement={...f.layer};f.doc.selections[layerSelector]=[replacement];f.content.selections[':scope > div.ModalCaptchaText_layerWrap__jn1bV']=[replacement];}
  ]){
    const f=fixture(),snapshot=helper.capture(f.doc,f.ctx);change(f);
    assert.equal(helper.isCurrent(snapshot,f.doc,f.ctx),false);
  }
});

test('freshness re-verifies current page, visibility, image readiness and task identity',()=>{
  const {helper}=load();
  for(const change of [
    f=>{f.doc.location.href='https://tickets.interpark.com/onestop/schedule';},
    f=>{f.layer.hidden=true;},f=>{f.image.isConnected=false;},
    f=>{f.image.complete=false;},f=>{f.ctx.task.goodsCode='26013792';},
    f=>{f.doc.selections[layerSelector]=[];}
  ]){
    const f=fixture(),snapshot=helper.capture(f.doc,f.ctx);change(f);
    assert.equal(helper.isCurrent(snapshot,f.doc,f.ctx),false);
  }
});

test('input lookup keeps the visible snapshot node when an older hidden challenge comes first',()=>{
  const {helper}=load(),f=fixture();
  const oldInput=element('',{},{placeholder:'請輸入畫面的文字 (不區分大小寫)'});
  const oldLayer=element('',{[inputSelector]:[oldInput]});oldLayer.hidden=true;
  f.doc.selections[layerSelector]=[oldLayer,f.layer];
  const snapshot=helper.capture(f.doc,f.ctx);
  assert.equal(helper.getCurrentInput(snapshot,f.doc,f.ctx),f.input);
  assert.notEqual(helper.getCurrentInput(snapshot,f.doc,f.ctx),oldInput);
  f.image.attributes.src=otherPng;f.image.currentSrc=otherPng;
  assert.equal(helper.getCurrentInput(snapshot,f.doc,f.ctx),null);
  assert.equal(helper.getCurrentInput({},f.doc,f.ctx),null);
});

test('snapshots cannot be forged, serialized across documents, or reused after adapter failure',()=>{
  const {helper,root}=load(),f=fixture(),snapshot=helper.capture(f.doc,f.ctx);
  for(const forged of [null,42,{},JSON.parse(JSON.stringify(snapshot))])assert.equal(helper.isCurrent(forged,f.doc,f.ctx),false);
  assert.equal(helper.isCurrent(snapshot,fixture().doc,f.ctx),false);
  root.NolHelper.adapters.global={inspect(){throw Error('DOM is no longer available');}};
  assert.equal(helper.isCurrent(snapshot,f.doc,f.ctx),false);
});

test('candidate normalization only trims and uppercases six ASCII letters without repairing noise',()=>{
  const {helper}=load();
  assert.equal(helper.normalizeCandidate(' aBcDef\n'),'ABCDEF');
  assert.equal(helper.normalizeCandidate('ABCDEF'),'ABCDEF');
  for(const value of [null,42,{},'', 'ABCDE','ABCDEFG','ABC DE','ABC-DEF','AB1DEF','ＡＢＣＤＥＦ','ABCDß','\"ABCDEF\"','ABCDEF\nextra'])assert.equal(helper.normalizeCandidate(value),null,String(value));
});
