(function () {
  'use strict';
  if (globalThis.__nolHelperLoaded) return;
  globalThis.__nolHelperLoaded=true;
  const H=globalThis.NolHelper;
  const observedCaptchaTask={goodsCode:'26013793',placeCode:'26001167',productName:'JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON'};
  let ocrVisible=false,ocrEnabled=false,ocrBusy=false,ocrSnapshot=null,ocrEpoch=0,ocrCollapsed=false,lastOCRStatus=0;
  let context=null,lastTick=Date.now(),busy=false,tickInFlight=false,claimInFlight=false,continuing=false,closed=false,lastPoll=0,lastInspect=0,lastPageState='',startClock=Date.now(),startMono=performance.now();
  const host=document.createElement('div');host.id='nol-ticket-helper';
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML='<style>:host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483600;font-family:system-ui,"Microsoft YaHei",sans-serif}*{box-sizing:border-box}.box{width:300px;background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 6px 24px #0f172a26;padding:16px;font-size:13px;line-height:1.6}h3{font-size:15px;margin:0 0 6px}p{margin:5px 0;overflow-wrap:anywhere}.timer{font-variant-numeric:tabular-nums;font-size:24px;font-weight:650}button{font:inherit;cursor:pointer;background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:6px;min-height:36px;padding:4px 12px;margin:8px 8px 0 0}button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}.note{color:#64748b;font-size:12px}@media(max-width:400px){:host{right:8px;bottom:8px}.box{width:280px}}</style><div class="box"><h3>NOL 开票助手</h3><div class="timer"></div><p class="step"></p><p class="reason"></p><p class="note">验证由你完成，付款由你操作。</p><button class="pause">暂停</button><button class="settings">设置</button></div>';
  const timer=shadow.querySelector('.timer'),step=shadow.querySelector('.step'),reason=shadow.querySelector('.reason');
  const box=shadow.querySelector('.box');
  const continueButton=document.createElement('button');
  continueButton.type='button';continueButton.className='continue-entry';continueButton.textContent='已处理提示，继续';continueButton.hidden=true;box.append(continueButton);
  const runNodes=[...box.children];
  const ocr=document.createElement('section');
  ocr.hidden=true;
  ocr.innerHTML='<style>.ocr-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.ocr-head h3{margin:0}.ocr-head button{margin:0;padding:2px 8px;min-height:30px}.ocr-preview{display:block;max-width:100%;max-height:90px;margin:10px 0}.ocr-preview[hidden]{display:none}.ocr-value{width:100%;font:650 24px ui-monospace,monospace;letter-spacing:4px;padding:6px;border:1px solid #94a3b8;border-radius:6px;text-transform:uppercase}.ocr-status{font-size:12px}.ocr-collapsed{width:200px!important;padding:10px!important}.ocr-collapsed .ocr-main{display:none}@media(max-width:700px){:host([data-captcha-visible]){top:8px;bottom:auto;right:8px}}</style><div class="ocr-head"><h3>验证码辅助</h3><button type="button" class="ocr-toggle">收起</button></div><div class="ocr-main"><p class="ocr-note">本机识别，核对后填入；官网提交由你操作。</p><img class="ocr-preview" alt="当前验证码图片预览" hidden><label>识别候选<input class="ocr-value" aria-label="识别候选" maxlength="6" autocomplete="off" spellcheck="false"></label><p class="ocr-status" role="status" aria-live="polite">从扩展弹窗启用本机识别。</p><button type="button" class="ocr-recognize">识别当前图片</button><button type="button" class="ocr-fill" disabled>核对并填入</button></div>';
  box.append(ocr);
  const ocrStatus=ocr.querySelector('.ocr-status'),ocrInput=ocr.querySelector('.ocr-value'),ocrPreview=ocr.querySelector('.ocr-preview'),ocrRecognize=ocr.querySelector('.ocr-recognize'),ocrFill=ocr.querySelector('.ocr-fill');
  const send=async msg=>{const res=await chrome.runtime.sendMessage(msg);if(!res?.ok) throw new Error(res?.error || '扩展连接失效，请刷新页面');return res.data;};
  // Settings messages from content are intentionally rejected; open the extension's action popup instead.
  shadow.querySelector('.settings').textContent='查看说明';
  shadow.querySelector('.settings').addEventListener('click',()=>{reason.textContent='点击浏览器工具栏中的 NOL 开票助手图标，可打开设置或停止任务。';});
  shadow.querySelector('.pause').addEventListener('click',()=>send({type:'PAUSE',reason:'由你在购票页暂停'}).then(refresh).catch(showError));
  continueButton.addEventListener('click',async event=>{
    if(!event.isTrusted || continuing || !canContinue())return;
    continuing=true;render();
    try {
      const state=adapter()?.inspect(document,context);
      if(state?.kind!=='entry')throw new Error(state?.reason || '购票入口尚未准备好，请先处理官网提示。');
      await send({type:'CONTINUE_ENTRY',runId:context.run.id,visible:document.visibilityState==='visible'});
      lastPageState='';lastTick=Date.now();startClock=Date.now();startMono=performance.now();
      await refresh();
    }catch(error){showError(error);}finally{continuing=false;continueButton.disabled=false;}
  });
  function canContinue(){
    const r=context?.run;let product;try {product=H.parseProductUrl(location.href);}catch {return false;}
    return product.goodsCode===context?.task.goodsCode && product.placeCode===context?.task.placeCode && r?.status==='waiting-manual' && r.manualBlockCode==='MODAL_REQUIRES_MANUAL' && !r.entryClaimed && !r.apiDispatched && !r.entryAttempted && !r.entrySubmitted && !r.entryResultCode && !r.navigationErrorCode && !r.queueObserved;
  }
  function showError(e){reason.textContent=e.message;}
  function captchaContext(){return {task:context?.task || observedCaptchaTask};}
  function clearCandidate(message='') {
    ocrEpoch++;ocrSnapshot=null;ocrInput.value='';ocrPreview.removeAttribute('src');ocrPreview.hidden=true;ocrFill.disabled=true;
    if(message) ocrStatus.textContent=message;
  }
  function renderOCR() {
    ocr.hidden=!ocrVisible;
    host.toggleAttribute('data-captcha-visible',ocrVisible);
    box.classList.toggle('ocr-collapsed',ocrVisible && ocrCollapsed);
    ocr.querySelector('.ocr-toggle').textContent=ocrCollapsed?'展开':'收起';
    ocrRecognize.disabled=ocrBusy||!ocrEnabled;
    ocrFill.disabled=ocrBusy||!ocrEnabled||!ocrSnapshot||!H.captcha.normalizeCandidate(ocrInput.value);
  }
  async function inspectCaptcha() {
    try {ocrVisible=H.adapters.global.inspect(document,captchaContext()).code==='SEAT_CAPTCHA_REQUIRED';}catch {ocrVisible=false;}
    if(ocrSnapshot && (!ocrVisible || !H.captcha.isCurrent(ocrSnapshot,document,captchaContext()))) clearCandidate('图片或页面已变化，请重新识别。');
    if(ocrVisible && Date.now()-lastOCRStatus>3000) {
      lastOCRStatus=Date.now();
      try {ocrEnabled=(await send({type:'OCR_STATUS'}))?.enabled===true;}catch {ocrEnabled=false;}
      if(!ocrEnabled){clearCandidate();ocrStatus.textContent='先运行 local-ocr 启动脚本，再从扩展弹窗启用本机识别。';}
    }
  }
  ocr.querySelector('.ocr-toggle').addEventListener('click',event=>{if(!event.isTrusted)return;ocrCollapsed=!ocrCollapsed;renderOCR();});
  ocrInput.addEventListener('input',()=>renderOCR());
  ocrRecognize.addEventListener('click',async event=>{
    if(!event.isTrusted||ocrBusy||!ocrEnabled)return;
    let epoch;
    try {
      clearCandidate();ocrSnapshot=H.captcha.capture(document,captchaContext());epoch=ocrEpoch;
      ocrPreview.src=ocrSnapshot.imageDataUrl;ocrPreview.hidden=false;ocrBusy=true;ocrStatus.textContent='正在本机识别…';renderOCR();
      const result=await send({type:'OCR_RECOGNIZE',imageDataUrl:ocrSnapshot.imageDataUrl});
      if(epoch!==ocrEpoch)return;
      if(!H.captcha.isCurrent(ocrSnapshot,document,captchaContext())){clearCandidate('图片已更新或会话已结束，请重新检查。');return;}
      const candidate=H.captcha.normalizeCandidate(result?.candidate);
      ocrInput.value=candidate||'';ocrStatus.textContent=candidate?'请对照图片核对候选；你可以修正字母，再点击“核对并填入”。':'未识别出有效的6位字母，请手动输入或更换图片。';
    }catch(error){if(epoch===undefined||epoch===ocrEpoch){clearCandidate();ocrStatus.textContent=error.message||'识别失败，请手动输入。';}}
    finally{ocrBusy=false;renderOCR();}
  });
  ocrFill.addEventListener('click',event=>{
    if(!event.isTrusted||ocrBusy||!ocrEnabled)return;
    const candidate=H.captcha.normalizeCandidate(ocrInput.value);
    if(!candidate||!H.captcha.isCurrent(ocrSnapshot,document,captchaContext())){clearCandidate('图片已更新或页面已变化，请重新识别。');renderOCR();return;}
    const input=H.captcha.getCurrentInput(ocrSnapshot,document,captchaContext());
    if(!input){clearCandidate('官网输入框已变化，请手动输入。');renderOCR();return;}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,candidate);
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.focus();
    ocrStatus.textContent='已填入。请在官网核对后点击“完成输入”；尚未提交或通过验证。';ocrCollapsed=true;renderOCR();
  });
  function render() {
    const showRun=!!context && !['stopped','payment','missed'].includes(context.run.status);
    for(const node of runNodes) node.hidden=!showRun||ocrVisible;
    continueButton.hidden=!showRun || ocrVisible || !canContinue();continueButton.disabled=continuing;
    renderOCR();
    if(!showRun && !ocrVisible){host.remove();return;}
    if(!host.isConnected) document.documentElement.append(host);
    if(!showRun)return;
    const run=context.run,remain=Math.max(0,Date.parse(run.openAt)-Date.now()),secs=Math.ceil(remain/1000);
    timer.textContent=run.entryClaimed?'入口已启动':`${String(Math.floor(secs/3600)).padStart(2,'0')}:${String(Math.floor(secs%3600/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;
    step.textContent=run.step;reason.textContent=run.reason;
    shadow.querySelector('.pause').disabled=run.status==='paused';
  }
  async function refresh() {
    try {context=await send({type:'GET_CONTEXT'});} catch(e) {context=null;}
    await inspectCaptcha();render();
  }
  async function pause(reasonText) {
    if(!context || context.run.status==='paused') return;
    context.run.status='paused';render();
    try {await send({type:'PAUSE',reason:reasonText});await refresh();}catch(e){showError(e);}
  }
  function adapter() {return Object.values(H.adapters || {}).find(a=>a.matches(location.href));}
  async function pageState(value) {
    const key=`${context?.run.id}:${value.status}:${value.reason || ''}`;
    if(key===lastPageState) return;lastPageState=key;
    try {await send({type:'PAGE_STATE',runId:context.run.id,...value});await refresh();}catch(e){lastPageState='';showError(e);}
  }
  async function tick() {
    if(closed) return;
    const now=Date.now(),previous=lastTick;lastTick=now;
    if(now-lastPoll>1000 && !busy){busy=true;lastPoll=now;await refresh();busy=false;}
    if(!context) return;
    render();
    const r=context.run;
    if(r.status==='paused' || claimInFlight) return;
    if(Math.abs((Date.now()-startClock)-(performance.now()-startMono))>2000 && !r.entryClaimed){await pause('系统时间发生变化，请检查时间并重新启动任务');return;}
    const a=adapter();
    if(!a){await pageState({status:'manual',reason:'当前页面尚未适配，请人工接管'});return;}
    if(!r.entryClaimed) {
      if(r.status!=='armed') return;
      const decision=H.classifyTrigger({now,openAt:r.openAt,lastTick:previous,visible:document.visibilityState==='visible',entryClaimed:false});
      if(decision==='missed'){await pause('页面计时中断或错过开票时间，请停止后重新启动');return;}
      if(decision==='hidden' && now>=Date.parse(r.openAt)){await pause('开票时商品页不在前台，请停止后重新启动');return;}
      if(decision!=='fire') return;
      const state=a.inspect(document,context);
      if(state.kind==='entry' && state.canEnter===false && a.entryMode!=='api'){reason.textContent=state.reason;return;}
      if(state.kind!=='entry') {await pageState({status:'manual',code:state.code,reason:state.reason || '购票按钮尚未准备好，请人工处理'});return;}
      claimInFlight=true;
      try {
        const claim=await send({type:'CLAIM_ENTRY',runId:r.id,visible:true,lastTick:previous});
        // Claim is durable before the official API flow starts.
        context.run.entryClaimed=claim.claimed;
        const result=await a.enter(document,{...context,requestEntry:()=>send({type:'API_ENTRY',runId:r.id})});
        if(result?.code!=='ENTRY_REDIRECTING') {
          await refresh();
          return;
        }
        await refresh();
      }catch(e){await pause(e.message);}finally {claimInFlight=false;}
    } else {
      if(now-lastInspect<1000) return;
      lastInspect=now;
      const value=await a.step(document,context);
      await pageState(value);
    }
  }
  chrome.runtime.onMessage.addListener(message=>{if(message.type==='CONTEXT_CHANGED') refresh();});
  document.addEventListener('visibilitychange',()=>{lastTick=Date.now();render();});
  addEventListener('pagehide',()=>{closed=true;});
  refresh();
  setInterval(()=>{if(!busy && !tickInFlight && !claimInFlight && !continuing){tickInFlight=true;tick().catch(showError).finally(()=>{tickInFlight=false;});}},100);
})();
