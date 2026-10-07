'use strict';
importScripts('core.js', 'adapters/nol.js', 'adapters/global.js');
const H = globalThis.NolHelper;
const KEY = 'nolHelperState';
const HOSTS = new Set(['world.nol.com', 'tickets.interpark.com', 'ticket.globalinterpark.com']);
const TERMINAL = new Set(['stopped', 'payment', 'missed']);
const capabilities = [
  {id:'nol-entry',label:'NOL 商品入口',status:'verified',detail:'公开页面按钮结构已核对；登录、公告和验证码需要人工处理。'},
  {id:'global-checkout',label:'场次 / 选票 / 订单',status:'manual',detail:'登录后流程尚未实测，当前交给人工操作，自动支付始终关闭。'}
];
let chain = chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
function serialize(job) { const result = chain.then(job); chain = result.catch(()=>{}); return result; }
const empty = () => ({tasks:[],profiles:[],run:null});
async function read() {
  const state = (await chrome.storage.local.get(KEY))[KEY] || empty();
  // A previously saved budget also becomes unlimited under the current policy.
  return {...state, tasks:state.tasks.map(task=>({...task,maxTotal:null}))};
}
function trusted(sender) { return !!sender.url?.startsWith(chrome.runtime.getURL('')); }
function allowed(url) { try {const u = new URL(url); return u.protocol === 'https:' && HOSTS.has(u.hostname) && !u.port;} catch {return false;} }
function record(run, step, reason = '') {
  run.step = step; run.reason = reason; run.updatedAt = Date.now();
  run.events = [...(run.events || []), {at:run.updatedAt,step,reason}].slice(-80);
}
async function write(state) {
  await chrome.storage.local.set({[KEY]:state});
  const r=state.run;
  await chrome.action.setBadgeText({text:r?.status==='armed'?'ON':r?.status==='running'?'RUN':r?.status==='waiting-manual'?'手动':r?.status==='paused'?'暂停':r?.status==='missed'?'错过':''});
  await chrome.action.setBadgeBackgroundColor({color:r?.status==='waiting-manual'?'#B45309':'#2563EB'});
  if(r?.tabId) chrome.tabs.sendMessage(r.tabId,{type:'CONTEXT_CHANGED'}).catch(()=>{});
}
function publicState(s) {return {...s, run:s.run ? {...s.run,task:s.tasks.find(t=>t.id===s.run.taskId)} : null, capabilities};}
function context(s, sender) {
  if (!allowed(sender.url) || !sender.tab || s.run?.tabId !== sender.tab.id || TERMINAL.has(s.run.status)) return null;
  return {run:s.run, task:s.tasks.find(t=>t.id===s.run.taskId), capabilities};
}
async function clearAlarms(run) {
  if (!run) return;
  await chrome.alarms.clear(`warm:${run.id}`); await chrome.alarms.clear(`deadline:${run.id}`);
}
function koreanIso(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)) return '';
  const ms=Date.parse(value.replace(' ','T')+'+09:00'); return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}
async function fetchProduct(url) {
  const product = H.parseProductUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),15000);
  try {
    const response = await fetch(product.url, {credentials:'omit',signal:controller.signal,redirect:'error'});
    if (!response.ok) throw new Error(`商品页读取失败 (${response.status})`);
    const parsed = H.adapters.nol.extractProduct(await response.text(),product.url);
    if(!parsed) throw new Error('商品页结构无法识别，请稍后重试；可手动配置商品与开售时间');
    const query = new URLSearchParams({goodsCode:product.goodsCode,placeCode:product.placeCode,bizCode:'10965'});
    const sales = await fetch(`https://world.nol.com/api/ent-channel-out/v1/goods/salesinfo?${query}`, {credentials:'omit',signal:controller.signal,redirect:'error',headers:{'X-Service-Origin':'global','X-Service-Language':'zh-CN'}});
    let data = {};
    if(sales.ok) data = (await sales.json()).data || {};
    if(data.goodsCode && String(data.goodsCode)!==product.goodsCode || data.placeCode && String(data.placeCode)!==product.placeCode) throw new Error('网站返回的开售资料与商品不一致');
    const regular = data.salesInfo?.bookingOpenTime || parsed.bookingOpenTime;
    const presales = Array.isArray(data.preSalesInfo) ? data.preSalesInfo : [];
    const pre = presales.find(x=>x.bookingOpenTime) || {};
    const presale = pre.bookingOpenTime || '';
    return {...parsed,...product,productUrl:product.url,opening:{general:koreanIso(regular),presale:koreanIso(presale)},salesInfo:data,
      prices:(parsed.prices || []).map(p=>({...p,label:[p.seatGradeName,p.priceGradeName].filter(Boolean).join(' · ') || p.label || '',price:Number(p.salesPrice ?? p.price),people:/2\s*(人|people)/i.test(p.seatGradeName || '')?2:/1\s*(人|person)/i.test(p.seatGradeName || '')?1:null}))};
  } finally {clearTimeout(timer);}
}
async function handle(message,sender) {
  const ui = trusted(sender);
  const siteTypes = new Set(['GET_CONTEXT','CLAIM_ENTRY','ENTRY_RESULT','PAGE_STATE','HEARTBEAT','PAUSE']);
  if (!ui && !siteTypes.has(message?.type)) throw new Error('此操作只能由扩展设置页执行');
  if (message.type==='READ_PRODUCT') return fetchProduct(message.url);
  const s = await read();
  const c = ui ? null : context(s,sender);
  if (!ui && !c) {if(message.type==='GET_CONTEXT') return null; throw new Error('当前页面没有被启动的任务');}
  switch (message.type) {
    case 'GET_STATE': return publicState(s);
    case 'GET_CONTEXT': return c;
    case 'SAVE_PROFILE': {
      const p=H.normalizeProfile(message.profile);
      if(s.run && !TERMINAL.has(s.run.status) && s.tasks.find(t=>t.id===s.run.taskId)?.profileId===p.id) throw new Error('请先停止任务再修改其联系人');
      s.profiles = [...s.profiles.filter(x=>x.id!==p.id),p]; await write(s); return p;
    }
    case 'DELETE_PROFILE':
      if(s.tasks.some(t=>t.profileId===message.id)) throw new Error('该联系人仍被任务使用，请先删除或修改任务');
      s.profiles=s.profiles.filter(p=>p.id!==message.id); await write(s); return true;
    case 'SAVE_TASK': {
      const t=H.validateTask(message.task,s.profiles,Date.now(),true);
      if(s.run?.taskId===t.id && !TERMINAL.has(s.run.status)) throw new Error('请先停止任务再编辑');
      s.tasks=[...s.tasks.filter(x=>x.id!==t.id),t]; await write(s); return t;
    }
    case 'DELETE_TASK':
      if(s.run?.taskId===message.id && !TERMINAL.has(s.run.status)) throw new Error('请先停止任务');
      s.tasks=s.tasks.filter(t=>t.id!==message.id); await write(s); return true;
    case 'ARM': {
      if(s.run && !TERMINAL.has(s.run.status)) throw new Error('已有活动任务，请先停止它');
      const original=s.tasks.find(t=>t.id===message.taskId);
      if(!original) throw new Error('任务不存在');
      const immediate=message.immediate===true;
      const t=H.validateTask(original,s.profiles,Date.now(),immediate);
      if(immediate && Date.parse(t.openAt)>Date.now()) throw new Error('尚未开票，请使用定时启动');
      const openAt=immediate ? new Date(Date.now()+1000).toISOString() : t.openAt;
      const tab=await chrome.tabs.create({url:t.productUrl,active:Date.parse(openAt)-Date.now()<=300000});
      s.run={id:H.makeId(),taskId:t.id,tabId:tab.id,status:'armed',openAt,step:'等待开票',reason:'保持商品页前台、电脑清醒；公告与登录请提前处理。',entryClaimed:false,entryClicked:false,events:[],updatedAt:Date.now(),heartbeatAt:0};
      await write(s);
      await chrome.alarms.create(`warm:${s.run.id}`,{when:Math.max(Date.now()+500,Date.parse(openAt)-300000)});
      await chrome.alarms.create(`deadline:${s.run.id}`,{when:Date.parse(openAt)+6000});
      return s.run;
    }
    case 'CLAIM_ENTRY': {
      const r=c.run;
      if(r.status!=='armed' || r.entryClaimed || message.runId!==r.id) throw new Error('入口已处理或任务已暂停');
      const parsed=H.parseProductUrl(sender.url);
      if(parsed.goodsCode!==c.task.goodsCode || parsed.placeCode!==c.task.placeCode) throw new Error('当前商品不匹配');
      const tab=await chrome.tabs.get(r.tabId), win=await chrome.windows.get(tab.windowId);
      if(!tab.active || !win.focused || message.visible!==true) throw new Error('请将商品页保持在前台');
      const decision=H.classifyTrigger({now:Date.now(),openAt:r.openAt,visible:true,entryClaimed:r.entryClaimed,lastTick:message.lastTick});
      if(decision!=='fire') throw new Error(decision==='wait'?'尚未开票':'已错过触发窗口，请重新启动');
      r.entryClaimed=true; r.status='running'; r.triggerAt=Date.now(); r.latencyMs=r.triggerAt-Date.parse(r.openAt);
      record(r,'启动官方入口','入口只执行一次；等待网站验证和跳转'); await write(s); return {runId:r.id,claimed:true};
    }
    case 'ENTRY_RESULT':
      if(message.runId!==c.run.id || !c.run.entryClaimed) throw new Error('任务入口状态不匹配');
      c.run.entryClicked=message.clicked===true;
      if(!message.clicked) {c.run.status='waiting-manual';record(c.run,'需要人工操作','预约入口未能点击；请人工操作，扩展不会重试。');}
      else record(c.run,'已点击官方入口','等待网站登录、验证、排队或页面跳转');
      await write(s); return true;
    case 'PAGE_STATE':
      if(message.runId!==c.run.id || ['paused','missed','stopped','payment'].includes(c.run.status)) return false;
      if(!['waiting','manual','payment','progress'].includes(message.status)) throw new Error('未知页面状态');
      if(message.status==='payment') {c.run.status='payment';record(c.run,'已到付款页','扩展已停止，请自行检查并付款');await clearAlarms(c.run);}
      else if(message.status==='manual') {c.run.status='waiting-manual';record(c.run,'需要人工操作',String(message.reason || '页面尚未适配，请人工接管').slice(0,200));}
      else if(c.run.entryClaimed) {c.run.status='running';record(c.run,'等待网站处理',String(message.reason || '').slice(0,200));}
      await write(s); return true;
    case 'HEARTBEAT': c.run.heartbeatAt=Date.now(); await chrome.storage.local.set({[KEY]:s}); return true;
    case 'PAUSE':
      if(!s.run || TERMINAL.has(s.run.status)) return false;
      s.run.status='paused';record(s.run,'已暂停',ui?'由你暂停任务':String(message.reason || '页面状态变化，需要检查').slice(0,200));await write(s);return true;
    case 'RESUME': {
      if(!s.run || !['paused','waiting-manual'].includes(s.run.status)) throw new Error('没有可继续的任务');
      if(!s.run.entryClaimed && Date.parse(s.run.openAt)<=Date.now()) throw new Error('触发时间已过，请停止后使用“立即开始”');
      s.run.status=s.run.entryClaimed?'running':'armed';record(s.run,'继续观察','不会再次点击已经启动过的购票入口');await write(s);return true;
    }
    case 'STOP':
      if(s.run){await clearAlarms(s.run);s.run.status='stopped';record(s.run,'已停止','停止扩展不会取消网站中已有订单或队列');await write(s);}return true;
    case 'DELETE_ALL': await clearAlarms(s.run); await chrome.storage.local.remove(KEY); await chrome.action.setBadgeText({text:''}); if(s.run?.tabId) chrome.tabs.sendMessage(s.run.tabId,{type:'CONTEXT_CHANGED'}).catch(()=>{});return true;
    case 'EXPORT_DIAGNOSTICS': return {version:chrome.runtime.getManifest().version,at:new Date().toISOString(),capabilities,run:H.redactedRun(s.run)};
    case 'OPEN_OPTIONS': await chrome.runtime.openOptionsPage();return true;
    default: throw new Error('未知扩展操作');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  // Public reads do not block an opening-time claim behind network requests.
  const work=message?.type==='READ_PRODUCT' ? (trusted(sender)?fetchProduct(message.url):Promise.reject(new Error('无权限'))) : serialize(()=>handle(message,sender));
  work.then(data=>respond({ok:true,data}),e=>respond({ok:false,error:e.message || '操作失败'}));return true;
});
async function restart(reason) {
  const s=await read(); if(s.run && !TERMINAL.has(s.run.status)){await clearAlarms(s.run);s.run.status='paused';record(s.run,'需要重新检查',reason);await write(s);}
}
chrome.runtime.onStartup.addListener(()=>serialize(()=>restart('浏览器已重启，请检查并重新启动任务')));
chrome.runtime.onInstalled.addListener(()=>serialize(()=>restart('扩展已加载或更新，请重新启动任务')));
chrome.alarms.onAlarm.addListener(alarm=>serialize(async()=>{
  const s=await read(),r=s.run;if(!r || !alarm.name.endsWith(r.id)) return;
  if(alarm.name.startsWith('warm:') && r.status==='armed') {
    try {await chrome.tabs.update(r.tabId,{active:true});record(r,'开票准备','请保持此商品页前台，完成登录和公告处理');await write(s);}catch {r.status='paused';record(r,'商品页已关闭','请停止后重新启动任务');await write(s);}
  }
  if(alarm.name.startsWith('deadline:') && r.status==='armed' && !r.entryClaimed){r.status='missed';record(r,'错过开票触发','扩展不会延迟补点，请重新检查再立即开始');await write(s);}
}));
chrome.tabs.onRemoved.addListener(tabId=>serialize(async()=>{const s=await read();if(s.run?.tabId===tabId && !TERMINAL.has(s.run.status)){s.run.status='paused';record(s.run,'购票页已关闭','请停止后重新启动任务');await write(s);}}));
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(!change.url) return;
  serialize(async()=>{
    const s=await read(),r=s.run;if(!r || TERMINAL.has(r.status)) return;
    if(tabId===r.tabId && !allowed(change.url) && r.entryClaimed) {r.status='waiting-manual';record(r,'跳转到未适配页面','当前域名不在扩展适配范围，请人工继续');await write(s);}
    else if(tab.openerTabId===r.tabId && allowed(change.url) && r.entryClaimed && r.status!=='paused') {r.tabId=tabId;record(r,'已跟随官方新窗口','后续操作按已验证页面能力执行');await write(s);}
  });
});
