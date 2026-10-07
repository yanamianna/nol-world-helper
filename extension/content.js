(function () {
  'use strict';
  if (globalThis.__nolHelperLoaded) return;
  globalThis.__nolHelperLoaded=true;
  const H=globalThis.NolHelper;
  let context=null,lastTick=Date.now(),busy=false,claimInFlight=false,closed=false,lastPoll=0,lastInspect=0,lastPageState='',startClock=Date.now(),startMono=performance.now();
  const host=document.createElement('div');host.id='nol-ticket-helper';
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML='<style>:host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483600;font-family:system-ui,"Microsoft YaHei",sans-serif}*{box-sizing:border-box}.box{width:300px;background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 6px 24px #0f172a26;padding:16px;font-size:13px;line-height:1.6}h3{font-size:15px;margin:0 0 6px}p{margin:5px 0;overflow-wrap:anywhere}.timer{font-variant-numeric:tabular-nums;font-size:24px;font-weight:650}button{font:inherit;cursor:pointer;background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:6px;min-height:36px;padding:4px 12px;margin:8px 8px 0 0}button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}.note{color:#64748b;font-size:12px}@media(max-width:400px){:host{right:8px;bottom:8px}.box{width:280px}}</style><div class="box"><h3>NOL 开票助手</h3><div class="timer"></div><p class="step"></p><p class="reason"></p><p class="note">验证由你完成，付款由你操作。</p><button class="pause">暂停</button><button class="settings">设置</button></div>';
  const timer=shadow.querySelector('.timer'),step=shadow.querySelector('.step'),reason=shadow.querySelector('.reason');
  const send=async msg=>{const res=await chrome.runtime.sendMessage(msg);if(!res?.ok) throw new Error(res?.error || '扩展连接失效，请刷新页面');return res.data;};
  // Settings messages from content are intentionally rejected; open the extension's action popup instead.
  shadow.querySelector('.settings').textContent='查看说明';
  shadow.querySelector('.settings').addEventListener('click',()=>{reason.textContent='点击浏览器工具栏中的 NOL 开票助手图标，可打开设置或停止任务。';});
  shadow.querySelector('.pause').addEventListener('click',()=>send({type:'PAUSE',reason:'由你在购票页暂停'}).then(refresh).catch(showError));
  function showError(e){reason.textContent=e.message;}
  function render() {
    if(!context || ['stopped','payment','missed'].includes(context.run.status)){host.remove();return;}
    if(!host.isConnected) document.documentElement.append(host);
    const run=context.run,remain=Math.max(0,Date.parse(run.openAt)-Date.now()),secs=Math.ceil(remain/1000);
    timer.textContent=run.entryClaimed?'入口已启动':`${String(Math.floor(secs/3600)).padStart(2,'0')}:${String(Math.floor(secs%3600/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;
    step.textContent=run.step;reason.textContent=run.reason;
    shadow.querySelector('.pause').disabled=run.status==='paused';
  }
  async function refresh() {
    try {context=await send({type:'GET_CONTEXT'});render();} catch(e) {context=null;host.remove();}
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
      if(state.kind!=='entry') {await pageState({status:'manual',reason:state.reason || '购票按钮尚未准备好，请人工处理'});return;}
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
  setInterval(()=>{if(!busy && !claimInFlight) tick().catch(showError);},100);
})();
