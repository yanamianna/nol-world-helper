'use strict';
importScripts('core.js', 'entry-api.js', 'navigation.js', 'adapters/nol.js', 'adapters/global.js', 'ocr-client.js');
const H = globalThis.NolHelper;
let localOCR;
async function handleOCR(message,sender) {
  if(!trusted(sender)) {
    let page;
    try {page=new URL(sender.url);} catch {throw new Error('当前页面无法使用验证码辅助。');}
    if(sender.frameId!==0 || !sender.tab || page.protocol!=='https:' || page.hostname!=='tickets.interpark.com' || page.port || page.username || page.password || page.pathname!=='/onestop/seat') throw new Error('仅正式选座主页面可以使用验证码辅助。');
    let tab;try {tab=await chrome.tabs.get(sender.tab.id);}catch {throw new Error('选座页面已关闭。');}
    if((tab.pendingUrl||tab.url)!==sender.url) throw new Error('选座页面已经变化，请重新检查。');
    if(message.type==='OCR_HEALTH') throw new Error('请从扩展弹窗检查本机服务。');
  }
  localOCR ||= H.localOCR.create(chrome,fetch);
  if(message.type==='OCR_STATUS') return {enabled:await localOCR.enabled()};
  if(message.type==='OCR_HEALTH') return localOCR.health();
  if(message.type==='OCR_RECOGNIZE') return localOCR.recognize(message.imageDataUrl);
  throw new Error('未知识别操作。');
}
const KEY = 'nolHelperState';
const HOSTS = new Set(['world.nol.com', 'tickets.interpark.com', 'ticket.globalinterpark.com']);
const TERMINAL = new Set(['stopped', 'payment', 'missed']);
const capabilities = [
  {id:'nol-entry',label:'NOL 官方入场 API',status:'partial',detail:'按官网时间单次调用；客户端接线已核对，真实登录入场待实测，网站验证由你完成。'},
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
  if (!allowed(sender.url) || !sender.tab || sender.frameId!==0 || s.run?.tabId !== sender.tab.id || TERMINAL.has(s.run.status)) return null;
  return {run:s.run, task:s.tasks.find(t=>t.id===s.run.taskId), capabilities};
}
async function clearAlarms(run) {
  if (!run) return;
  await chrome.alarms.clear(`warm:${run.id}`); await chrome.alarms.clear(`deadline:${run.id}`);
  await chrome.alarms.clear(`sale:${run.id}`);
}
function koreanIso(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)) return '';
  const local=value.replace(' ','T'), ms=Date.parse(local+'+09:00');
  return Number.isFinite(ms) && new Date(ms+9*3600000).toISOString().slice(0,19)===local ? new Date(ms).toISOString() : '';
}
async function fetchProduct(url) {
  const product = H.parseProductUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),15000);
  try {
    const response = await fetch(product.url, {credentials:'omit',signal:controller.signal,redirect:'error'});
    if (!response.ok) throw new Error(`商品页读取失败 (${response.status})`);
    const parsed = H.adapters.nol.extractProduct(await response.text(),product.url);
    if(!parsed) throw new Error('商品页结构无法识别，请稍后重新读取官网资料');
    const query = new URLSearchParams({goodsCode:product.goodsCode,placeCode:product.placeCode,bizCode:'10965'});
    const sales = await fetch(`https://world.nol.com/api/ent-channel-out/v1/goods/salesinfo?${query}`, {credentials:'omit',signal:controller.signal,redirect:'error',headers:{'X-Service-Origin':'global','X-Triple-User-Lang':'zh-CN'}});
    if (!sales.ok) throw new Error(`官网开售接口读取失败 (${sales.status})，任务不会使用旧时间启动`);
    const data = (await sales.json()).data;
    if (!data || String(data.goodsCode)!==product.goodsCode || String(data.placeCode)!==product.placeCode) throw new Error('网站返回的开售资料与商品不一致');
    const regular = data.salesInfo?.bookingOpenTime;
    const presales = Array.isArray(data.preSalesInfo) ? data.preSalesInfo : [];
    const presaleChoices = presales.map(p=>({seq:String(p.seq || ''),label:String(p.buttonName || p.preBookingKindName || '会员预售'),openAt:koreanIso(p.bookingOpenTime),endAt:koreanIso(p.bookingEndTime)})).filter(p=>p.seq && p.openAt && p.endAt && Date.parse(p.endAt)>Date.parse(p.openAt));
    return {...parsed,...product,productUrl:product.url,opening:{general:koreanIso(regular),generalEnd:koreanIso(data.salesInfo?.bookingEndTime),presale:presaleChoices.length===1?presaleChoices[0].openAt:''},presaleChoices,salesInfo:data,
      prices:(parsed.prices || []).map(p=>({...p,label:[p.seatGradeName,p.priceGradeName].filter(Boolean).join(' · ') || p.label || '',price:Number(p.salesPrice ?? p.price),people:/2\s*(人|people)/i.test(p.seatGradeName || '')?2:/1\s*(人|person)/i.test(p.seatGradeName || '')?1:null}))};
  } finally {clearTimeout(timer);}
}
function officialTask(input, product) {
  const window=H.selectOfficialOpening(product,input.stage,input.preSaleSeq);
  return {...input,openAt:window.openAt,officialEndAt:window.endAt,preSaleSeq:window.preSaleSeq,openAtSource:'official',officialCheckedAt:Date.now(),productName:product.goodsName || input.productName};
}
async function cancelEntry(run) {
  if (!run?.apiDispatched || !run.tabId) return;
  try {await chrome.scripting.executeScript({target:{tabId:run.tabId},world:'MAIN',func:H.cancelOfficialEntry,args:[run.id]});} catch (_) { /* A navigated or closed document has no live verification to cancel. */ }
}
const apiReasons = {
  ENTRY_REDIRECTING:'官方入场接口已返回成功，正在进入官方售票流程。',
  ENTRY_LOGIN_REQUIRED:'请先在官网完成登录，停止后重新启动任务。',
  ENTRY_EMAIL_REQUIRED:'请先在官网补全邮箱，停止后重新启动任务。',
  ENTRY_RESPONSE_UNKNOWN:'入场请求结果不明确，请检查官网状态；扩展不会重复提交。',
  ENTRY_RESULT_UNKNOWN:'页面已跳转或接口结果不明确，请检查官网状态；扩展不会重试。',
  ENTRY_CANCELLED:'入场流程已取消，请检查官网状态，停止后重新启动任务；不会重试。',
  ENTRY_VERIFICATION_FAILED:'网站验证失败，请在官网检查，停止后重新启动任务。',
  ENTRY_VERIFICATION_EXPIRED:'网站验证已过期，请检查官网状态，停止后重新启动任务。',
  ENTRY_TIMEOUT:'网站验证或入场请求超时，请检查官网状态；扩展不会重试。',
  ENTRY_SDK_UNAVAILABLE:'网站验证组件未能加载，请检查官网状态。',
  ENTRY_SALE_ENDED:'所选官网开售窗口已结束。'
};
function entryReason(code) { return apiReasons[code] || '入场流程未完成，请在官网检查状态，停止后重新启动任务；扩展不会重试。'; }
async function runEntry(message,sender) {
  const payload=await serialize(async()=>{
    const s=await read(),c=context(s,sender),r=c?.run;
    if (!c || message.runId!==r.id || r.status!=='running' || !r.entryClaimed || r.apiDispatched) throw new Error('入场接口已处理、任务已暂停或页面不匹配');
    const page=H.parseProductUrl(sender.url);
    if (page.goodsCode!==c.task.goodsCode || page.placeCode!==c.task.placeCode) throw new Error('当前商品不匹配');
    if (Date.now()<Date.parse(c.task.openAt) || Date.now()>=Date.parse(c.task.officialEndAt)) throw new Error('当前不在官网公布的开售时间窗口内');
    r.apiDispatched=true;record(r,'正在进行官方验证','登录、邮箱和人机验证通过后，将单次提交官方入场接口。');await write(s);
    return {runId:r.id,tabId:r.tabId,goodsCode:c.task.goodsCode,placeCode:c.task.placeCode,openAt:c.task.openAt,endAt:c.task.officialEndAt};
  });
  let result;
  try {
    const {tabId,...args}=payload;
    const values=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:H.officialEntry,args:[args]});
    result=values?.[0]?.result;
    if (!result || typeof result.code!=='string' || typeof result.submitted!=='boolean') result={submitted:false,code:'ENTRY_RESULT_UNKNOWN'};
  } catch (_) {result={submitted:false,code:'ENTRY_RESULT_UNKNOWN'};}
  // Only finite status codes cross the page/extension boundary; never return a page URL or credentials.
  const codes=new Set(['ENTRY_REDIRECTING','ENTRY_LOGIN_REQUIRED','ENTRY_EMAIL_REQUIRED','ENTRY_RESPONSE_UNKNOWN','ENTRY_CANCELLED','ENTRY_RESULT_UNKNOWN','ENTRY_VERIFICATION_FAILED','ENTRY_VERIFICATION_EXPIRED','ENTRY_TIMEOUT','ENTRY_SDK_UNAVAILABLE','ENTRY_SALE_ENDED','ENTRY_INVALID_CONFIG','ENTRY_PAGE_MISMATCH','ENTRY_PAGE_NOT_VISIBLE','ENTRY_BEFORE_OPEN','ENTRY_ALREADY_ATTEMPTED','ENTRY_ALREADY_STARTED','ENTRY_CONTEXT_UNAVAILABLE','ENTRY_OTHER_RUN_ACTIVE','ENTRY_STATUS_UNKNOWN','ENTRY_REQUEST_FAILED','ENTRY_REQUEST_TIMEOUT']);
  const safe={submitted:result.submitted===true,code:codes.has(result.code)?result.code:'ENTRY_RESULT_UNKNOWN'};
  await serialize(async()=>{
    const s=await read(),r=s.run;if (!r || r.id!==payload.runId) return;
    if (TERMINAL.has(r.status) || r.status==='paused' || r.navigationErrorCode || r.queueObserved) return;
    r.entryAttempted=safe.submitted;r.entrySubmitted=safe.submitted && safe.code==='ENTRY_REDIRECTING';r.entryResultCode=safe.code;
    if (!TERMINAL.has(r.status) && r.status!=='paused') {
      r.status=r.entrySubmitted?'running':'waiting-manual';
      record(r,r.entrySubmitted?'已提交官方入场接口':'需要人工检查',entryReason(safe.code));
    }
    await write(s);
  });
  return safe;
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
      const t=H.validateTask(officialTask(message.task,message.officialProduct),s.profiles,Date.now(),true);
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
      const t=H.validateTask(officialTask(original,message.officialProduct),s.profiles,Date.now(),immediate);
      if (Date.now()>=Date.parse(t.officialEndAt)) throw new Error('官网公布的所选开售窗口已结束');
      if(immediate && Date.parse(t.openAt)>Date.now()) throw new Error('尚未开票，请使用定时启动');
      s.tasks=s.tasks.map(task=>task.id===t.id?t:task);
      const openAt=immediate ? new Date(Date.now()+1000).toISOString() : t.openAt;
      const tab=await chrome.tabs.create({url:t.productUrl,active:Date.parse(openAt)-Date.now()<=300000});
      s.run={id:H.makeId(),taskId:t.id,tabId:tab.id,status:'armed',openAt,officialOpenAt:t.openAt,officialEndAt:t.officialEndAt,officialCheckedAt:t.officialCheckedAt,step:'等待官网开售',reason:'保持商品页前台、电脑清醒；公告与登录请提前处理。',entryClaimed:false,apiDispatched:false,entryAttempted:false,entrySubmitted:false,entryResultCode:null,events:[],updatedAt:Date.now(),heartbeatAt:0};
      await write(s);
      await chrome.alarms.create(`warm:${s.run.id}`,{when:Math.max(Date.now()+500,Date.parse(openAt)-300000)});
      await chrome.alarms.create(`deadline:${s.run.id}`,{when:Date.parse(openAt)+6000});
      await chrome.alarms.create(`sale:${s.run.id}`,{periodInMinutes:1});
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
      record(r,'准备官方入场接口','只执行一次；等待网站正常验证和跳转'); await write(s); return {runId:r.id,claimed:true};
    }
    case 'ENTRY_RESULT': throw new Error('请刷新商品页以使用新的官方入场接口');
    case 'PAGE_STATE':
      if(message.runId!==c.run.id || ['paused','missed','stopped','payment'].includes(c.run.status)) return false;
      if(!['waiting','manual','payment','progress'].includes(message.status)) throw new Error('未知页面状态');
      if(message.code==='WAITING_QUEUE_VERIFIED') {
        const page=new URL(sender.url),normalize=value=>typeof value==='string'?value.normalize('NFKC').replace(/\s+/gu,'').toUpperCase():'';
        if(message.status!=='waiting' || message.verified!==true || !c.run.entryClaimed || page.hostname!=='tickets.interpark.com' || page.pathname!=='/waiting' || !normalize(c.task.productName) || normalize(message.productName)!==normalize(c.task.productName) || !Number.isSafeInteger(message.position) || message.position<=0 || !Number.isSafeInteger(message.totalWaiting) || message.totalWaiting<message.position) return false;
        // An old queue document must not clear a newer navigation failure.
        // These comparisons remain in memory; no URL or document ID is stored.
        let currentTab,currentFrame;
        try {
          currentTab=await chrome.tabs.get(sender.tab.id);
          if(sender.documentId) currentFrame=await chrome.webNavigation.getFrame({tabId:sender.tab.id,frameId:0});
        } catch {return false;}
        if((currentTab.pendingUrl || currentTab.url)!==sender.url || sender.documentId && currentFrame?.documentId!==sender.documentId) return false;
        c.run.queueObserved=true;c.run.queuePosition=message.position;c.run.queueTotal=message.totalWaiting;c.run.queueObservedAt=Date.now();
        c.run.navigationErrorCode=null;c.run.navigationErrorHost=null;c.run.status='running';
        record(c.run,'正在官方排队',`我的等候顺位 ${message.position.toLocaleString('en-US')}，当前等候人数 ${message.totalWaiting.toLocaleString('en-US')}。请保持当前页面，刷新或重新进入会重置顺位。`);
        await write(s);return true;
      }
      // A generic page inspection cannot finish verification or erase its failure.
      // Payment is still a terminal stop if the user reaches it manually.
      if((c.run.navigationErrorCode || c.run.apiDispatched && !c.run.entrySubmitted && !c.run.queueObserved) && message.status!=='payment') return false;
      if(message.status==='payment') {c.run.status='payment';record(c.run,'已到付款页','扩展已停止，请自行检查并付款');await clearAlarms(c.run);}
      else if(message.status==='manual') {c.run.status='waiting-manual';record(c.run,'需要人工操作',String(message.reason || '页面尚未适配，请人工接管').slice(0,200));}
      else if(c.run.entryClaimed) {c.run.status='running';record(c.run,'等待网站处理',String(message.reason || '').slice(0,200));}
      await write(s); return true;
    case 'HEARTBEAT': c.run.heartbeatAt=Date.now(); await chrome.storage.local.set({[KEY]:s}); return true;
    case 'PAUSE':
      if(!s.run || TERMINAL.has(s.run.status)) return false;
      if(s.run.apiDispatched && !s.run.entrySubmitted && !s.run.queueObserved && !s.run.entryResultCode) s.run.entryResultCode='ENTRY_CANCELLED';
      s.run.status='paused';record(s.run,'已暂停',s.run.navigationErrorCode ? s.run.reason : s.run.apiDispatched && !s.run.entrySubmitted && !s.run.queueObserved ? entryReason(s.run.entryResultCode) : ui?'由你暂停任务':String(message.reason || '页面状态变化，需要检查').slice(0,200));await write(s);void cancelEntry(s.run);return true;
    case 'RESUME': {
      if(!s.run || !['paused','waiting-manual'].includes(s.run.status)) throw new Error('没有可继续的任务');
      if(s.run.navigationErrorCode) throw new Error('官方购票页面连接失败，请检查官网状态，停止后重新启动任务；不会重新提交入场接口。');
      if(s.run.entryClaimed && !s.run.entrySubmitted && !s.run.queueObserved) throw new Error((s.run.entryResultCode ? entryReason(s.run.entryResultCode) : '入场尚未确认成功，请检查官网状态。') + ' 此任务不能恢复入场，请停止后重新启动；不会自动提交。');
      if(!s.run.entryClaimed && Date.parse(s.run.openAt)<=Date.now()) throw new Error('触发时间已过，请停止后使用“立即开始”');
      s.run.status=s.run.entryClaimed?'running':'armed';record(s.run,'继续观察',s.run.entrySubmitted || s.run.queueObserved?'仅继续观察官方购票页面，不会重新验证或再次提交入场接口。':'继续等待开售时间，尚未启动购票入口。');await write(s);return true;
    }
    case 'STOP':
      if(s.run){await clearAlarms(s.run);s.run.status='stopped';record(s.run,'已停止','停止扩展不会取消网站中已有订单或队列');await write(s);void cancelEntry(s.run);}return true;
    case 'DELETE_ALL': await clearAlarms(s.run); void cancelEntry(s.run); await chrome.storage.local.remove(KEY); await chrome.action.setBadgeText({text:''}); if(s.run?.tabId) chrome.tabs.sendMessage(s.run.tabId,{type:'CONTEXT_CHANGED'}).catch(()=>{});return true;
    case 'EXPORT_DIAGNOSTICS': return {version:chrome.runtime.getManifest().version,at:new Date().toISOString(),capabilities,run:H.redactedRun(s.run)};
    case 'OPEN_OPTIONS': await chrome.runtime.openOptionsPage();return true;
    default: throw new Error('未知扩展操作');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  // Network reads and the interactive page verifier do not hold the state lock.
  const work=(async()=>{
    if (['OCR_STATUS','OCR_HEALTH','OCR_RECOGNIZE'].includes(message?.type)) return handleOCR(message,sender);
    if (message?.type==='API_ENTRY') return runEntry(message,sender);
    if (message?.type==='READ_PRODUCT') {if(!trusted(sender)) throw new Error('无权限');return fetchProduct(message.url);}
    if (message?.type==='SAVE_TASK' || message?.type==='ARM') {
      if(!trusted(sender)) throw new Error('此操作只能由扩展设置页执行');
      const input=message.type==='SAVE_TASK'?message.task:(await read()).tasks.find(t=>t.id===message.taskId);
      if(!input) throw new Error('任务不存在');
      const officialProduct=await fetchProduct(input.productUrl);
      return serialize(()=>handle({...message,officialProduct},sender));
    }
    return serialize(()=>handle(message,sender));
  })();
  work.then(data=>respond({ok:true,data}),e=>respond({ok:false,error:e.message || '操作失败'}));return true;
});
async function restart(reason) {
  const s=await read(); if(s.run && !TERMINAL.has(s.run.status)){await clearAlarms(s.run);s.run.status='paused';record(s.run,'需要重新检查',reason);await write(s);void cancelEntry(s.run);}
}
chrome.runtime.onStartup.addListener(()=>serialize(()=>restart('浏览器已重启，请检查并重新启动任务')));
chrome.runtime.onInstalled.addListener(()=>serialize(()=>restart('扩展已加载或更新，请重新启动任务')));
async function refreshOfficialTime(runId) {
  const before=await read(),original=before.run;
  if(!original || original.id!==runId || original.status!=='armed' || original.entryClaimed) return;
  const task=before.tasks.find(t=>t.id===original.taskId);
  let product,error;
  try {product=await fetchProduct(task.productUrl);} catch(e) {error=e;}
  return serialize(async()=>{
    const s=await read(),r=s.run;
    if(!r || r.id!==runId || r.status!=='armed' || r.entryClaimed) return;
    try {
      if(error) throw error;
      const t=H.validateTask(officialTask(s.tasks.find(t=>t.id===r.taskId),product),s.profiles,Date.now(),true);
      if(Date.now()>=Date.parse(t.officialEndAt)) throw new Error('官网公布的开售窗口已结束');
      const changed=t.openAt!==r.officialOpenAt;
      if(changed && Date.parse(t.openAt)<=Date.now()) throw new Error('官网开售时间已变更且已过，请检查后重新启动');
      s.tasks=s.tasks.map(x=>x.id===t.id?t:x);
      r.officialOpenAt=t.openAt;r.officialEndAt=t.officialEndAt;r.officialCheckedAt=t.officialCheckedAt;
      if(changed) {
        r.openAt=t.openAt;record(r,'官网开售时间已更新','倒计时已自动按最新官方时间调整。');
        await chrome.alarms.create(`warm:${r.id}`,{when:Math.max(Date.now()+500,Date.parse(r.openAt)-300000)});
        await chrome.alarms.create(`deadline:${r.id}`,{when:Date.parse(r.openAt)+6000});
      }
      await write(s);
    } catch(e) {
      r.status='paused';record(r,'官网时间需要重新确认',String(e.message || '官网时间读取失败').slice(0,200));await clearAlarms(r);await write(s);
    }
  });
}
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name.startsWith('sale:')) return refreshOfficialTime(alarm.name.slice(5));
  return serialize(async()=>{
  const s=await read(),r=s.run;if(!r || !alarm.name.endsWith(r.id)) return;
  if(alarm.name.startsWith('warm:') && r.status==='armed') {
    try {await chrome.tabs.update(r.tabId,{active:true});record(r,'开票准备','请保持此商品页前台，完成登录和公告处理');await write(s);}catch {r.status='paused';record(r,'商品页已关闭','请停止后重新启动任务');await write(s);}
  }
  if(alarm.name.startsWith('deadline:') && r.status==='armed' && !r.entryClaimed){r.status='missed';record(r,'错过开票触发','扩展不会延迟补点，请重新检查再立即开始');await write(s);}
  });
});
chrome.tabs.onRemoved.addListener(tabId=>serialize(async()=>{const s=await read();if(s.run?.tabId===tabId && !TERMINAL.has(s.run.status)){s.run.status='paused';record(s.run,'购票页已关闭','请停止后重新启动任务');await write(s);}}));
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(!change.url) return;
  serialize(async()=>{
    const s=await read(),r=s.run;if(!r || TERMINAL.has(r.status)) return;
    if(tabId===r.tabId && !allowed(change.url) && r.entryClaimed) {r.status='waiting-manual';record(r,'跳转到未适配页面','当前域名不在扩展适配范围，请人工继续');await write(s);}
    else if(tab.openerTabId===r.tabId && allowed(change.url) && r.entryClaimed && r.status!=='paused') {r.tabId=tabId;record(r,'已跟随官方新窗口','后续操作按已验证页面能力执行');await write(s);}
  });
});
chrome.webNavigation.onErrorOccurred.addListener(details=>serialize(async()=>{
  const s=await read(),r=s.run,failure=H.navigationFailure(details,r);
  if(!failure) return;
  // Compare only in memory: an older navigation can fail after a new one starts.
  // Never put the gate URL, its query or the raw browser error into storage.
  let tab;
  try {tab=await chrome.tabs.get(details.tabId);} catch {return;}
  if(!H.navigationMatchesTab(details,tab)) return;
  r.navigationErrorCode=failure.errorCode;r.navigationErrorHost=failure.host;
  r.status='waiting-manual';record(r,'官方购票页未能加载',failure.reason);
  await clearAlarms(r);await write(s);
}),{url:[...HOSTS].map(hostEquals=>({schemes:['https'],hostEquals}))});
