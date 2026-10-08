"""Offline, isolated MV3 waiting-page observation QA.
Browser plugin not available; Playwright is permitted for our own static fixture.
No actual queue URL/query, user profile, login, entry API, seat, order or payment.
"""
import argparse
import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--outdir', default=None)
parser.add_argument('--browser-executable', default=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
parser.add_argument('--extension-root', type=Path, default=Path(__file__).resolve().parents[1])
args = parser.parse_args()
extension = args.extension_root.resolve()
fixture = (extension / 'tests/fixtures/waiting-desktop.html').read_text(encoding='utf-8')
evidence = Path(args.outdir) if args.outdir else Path(tempfile.mkdtemp(prefix='nol-waiting-evidence-'))
evidence.mkdir(parents=True, exist_ok=True)
URL = 'https://tickets.interpark.com/waiting'
PRODUCT = 'JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON'
errors, warnings, blocked_requests, fixture_loads = [], [], [], []

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(prefix='nol-waiting-qa-'), executable_path=args.browser_executable,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'],
        ignore_default_args=['--disable-extensions'], viewport={'width':1100, 'height':800})
    def route(request):
        if request.request.url.startswith('chrome-extension://'):
            request.continue_()
        elif request.request.url == URL and request.request.is_navigation_request():
            fixture_loads.append(URL)
            request.fulfill(body=fixture, content_type='text/html; charset=utf-8')
        else:
            blocked_requests.append(request.request.url)
            request.abort()
    context.route('**/*', route)
    context.on('console', lambda m: errors.append(m.text) if m.type=='error' else warnings.append(m.text) if m.type=='warning' else None)
    context.on('page', lambda page: page.on('pageerror', lambda e: errors.append(str(e))))
    workers = context.service_workers
    worker = workers[0] if workers else context.wait_for_event('serviceworker', timeout=15000)
    worker.evaluate('''() => {
        globalThis.__qaFetchCalls=0;
        globalThis.__qaEntryCalls=0;
        globalThis.__qaPageStates=[];
        globalThis.fetch=async()=>{globalThis.__qaFetchCalls++;throw new Error('QA blocks all network');};
        const execute=chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.scripting.executeScript=(details)=>{
            if(details.func?.name==='officialEntry')globalThis.__qaEntryCalls++;
            return execute(details);
        };
        chrome.runtime.onMessage.addListener(message=>{
            if(message.type==='PAGE_STATE')globalThis.__qaPageStates.push({status:message.status,position:message.position,totalWaiting:message.totalWaiting});
            return false;
        });
    }''')
    extension_id = worker.url.split('/')[2]
    popup = context.new_page()
    popup.goto(f'chrome-extension://{extension_id}/popup.html')
    popup.wait_for_selector('#popup-task')
    assert popup.title()=='NOL 公演助手' and popup.locator('body').inner_text().strip()
    assert popup.locator('nextjs-portal, vite-error-overlay').count()==0
    with context.expect_page() as created:
        tab_id = worker.evaluate("async () => (await chrome.tabs.create({url:'about:blank',active:true})).id")
    queue = created.value
    queue.add_init_script('''
        globalThis.__qaPageActions={fetch:0,xhr:0,click:0,open:0};
        window.fetch=async()=>{globalThis.__qaPageActions.fetch++;throw new Error('QA blocks page fetch');};
        XMLHttpRequest.prototype.open=function(){globalThis.__qaPageActions.xhr++;throw new Error('QA blocks XHR');};
        HTMLElement.prototype.click=function(){globalThis.__qaPageActions.click++;throw new Error('QA blocks clicks');};
        window.open=function(){globalThis.__qaPageActions.open++;return null;};
    ''')
    now = datetime.now(timezone.utc)
    opening, end = (now-timedelta(minutes=5)).isoformat(), (now+timedelta(days=1)).isoformat()
    state = {'tasks':[{'id':'qa-waiting-task','name':'QA 官方队列只读观察','productName':PRODUCT,
                       'openAt':opening,'officialEndAt':end,'openAtSource':'official','stage':'general'}],
             'profiles':[], 'run':{'id':'qa-waiting-run','taskId':'qa-waiting-task','tabId':tab_id,
                                   'status':'waiting-manual','openAt':opening,'entryClaimed':True,'apiDispatched':True,
                                   'entryAttempted':True,'entrySubmitted':False,'entryResultCode':'ENTRY_RESULT_UNKNOWN',
                                   'step':'需要人工检查','reason':'QA API 回执不明确，观察本地实际队列结构。','events':[]}}
    popup.evaluate('(fixture) => chrome.storage.local.set({nolHelperState:fixture})', state)
    queue.goto(URL)
    assert queue.url == URL and '?' not in queue.url
    queue.wait_for_selector('.StatusBox_mainText__9gJXJ strong')
    queue.add_script_tag(path=str(extension/'adapters/global.js'))
    observed = queue.evaluate('''productName => {
        const adapter=NolHelper.adapters.global;
        const before=document.documentElement.outerHTML;
        const inspected=adapter.inspect(document,{task:{productName}});
        const step=adapter.step(document,{task:{productName}});
        const mismatch=adapter.step(document,{task:{productName:'A different official product'}});
        let refusesEntry=false;
        try{adapter.enter(document,{task:{productName}});}catch(error){refusesEntry=error.code==='GLOBAL_DOM_UNVERIFIED';}
        return {inspected,step,mismatch,refusesEntry,unchanged:before===document.documentElement.outerHTML};
    }''', PRODUCT)
    assert observed['inspected']['kind']=='waiting' and observed['inspected']['verified']
    assert observed['inspected']['position']==42446 and observed['inspected']['totalWaiting']==48869
    assert observed['step']['status']=='waiting' and observed['step']['position']==42446
    assert observed['mismatch']['status']=='manual' and observed['mismatch']['code']=='WAITING_PRODUCT_MISMATCH'
    assert observed['refusesEntry'] and observed['unchanged']
    popup.wait_for_function('''() => {
        const text=document.querySelector('#run-detail').textContent;
        return text.includes('排队') && text.includes('42,446') && text.includes('48,869');
    }''', timeout=6000)
    assert popup.locator('#popup-resume').is_hidden() and popup.locator('#popup-stop').is_visible()
    assert '刷新' in popup.locator('#run-detail').inner_text()
    popup.set_viewport_size({'width':360,'height':720})
    assert popup.evaluate('document.documentElement.scrollWidth <= innerWidth')
    popup.screenshot(path=str(evidence/'waiting-popup-initial.png'), full_page=True)

    observed_run = popup.evaluate("async () => (await chrome.runtime.sendMessage({type:'GET_STATE'})).data.run")
    assert observed_run['queueObserved'] and not observed_run['entrySubmitted'], observed_run
    assert observed_run['queuePosition']==42446 and observed_run['queueTotal']==48869
    popup.locator('#popup-pause').click()
    popup.wait_for_function("() => document.querySelector('#run-status').textContent==='已暂停'")
    assert popup.locator('#popup-resume').is_visible() and popup.locator('#popup-resume').inner_text()=='继续观察'
    popup.screenshot(path=str(evidence/'waiting-popup-resume-observation.png'), full_page=True)
    popup.locator('#popup-resume').click()
    popup.wait_for_function("() => document.querySelector('#run-status').textContent==='正在运行'")
    resumed_run = popup.evaluate("async () => (await chrome.runtime.sendMessage({type:'GET_STATE'})).data.run")
    assert resumed_run['queueObserved'] and not resumed_run['entrySubmitted']
    assert '不会重新验证或再次提交' in resumed_run['reason']

    # The fixture DOM changes locally; the content script must observe the new
    # numbers without refreshing the page, clicking, or fetching anything.
    queue.evaluate('''() => {
        document.querySelector('.StatusBox_mainText__9gJXJ strong').textContent='8,123';
        document.querySelector('.StatusBox_columnRight__1bbL6').textContent='15,000';
    }''')
    updated = queue.evaluate('(productName) => NolHelper.adapters.global.step(document,{task:{productName}})', PRODUCT)
    assert updated['status']=='waiting' and updated['position']==8123 and updated['totalWaiting']==15000
    popup.wait_for_function('''() => {
        const text=document.querySelector('#run-detail').textContent;
        return text.includes('排队') && text.includes('8,123') && text.includes('15,000');
    }''', timeout=6000)
    popup.screenshot(path=str(evidence/'waiting-popup-updated.png'), full_page=True)
    stored = popup.evaluate("async () => (await chrome.runtime.sendMessage({type:'GET_STATE'})).data.run")
    assert stored['status']=='running' and '排队' in stored['step'], stored
    assert stored['queueObserved'] and not stored['entrySubmitted'], stored
    assert '8,123' in stored['reason'] and '15,000' in stored['reason']
    actions = queue.evaluate('globalThis.__qaPageActions')
    counts = worker.evaluate('({fetch:globalThis.__qaFetchCalls,entry:globalThis.__qaEntryCalls,states:globalThis.__qaPageStates})')
    assert actions=={'fetch':0,'xhr':0,'click':0,'open':0}, actions
    assert counts['fetch']==0 and counts['entry']==0, counts
    assert any(s['status']=='waiting' and s['position']==42446 and s['totalWaiting']==48869 for s in counts['states'])
    assert any(s['status']=='waiting' and s['position']==8123 and s['totalWaiting']==15000 for s in counts['states'])
    assert len(fixture_loads)==1 and not blocked_requests, (fixture_loads,blocked_requests)
    assert not errors and not warnings, (errors,warnings)
    print(json.dumps({'browser':context.browser.version,'version':worker.evaluate('chrome.runtime.getManifest().version'),
                      'checks':['observed-DOM-rank-and-total','wrong-product-manual','read-only-adapter-refuses-entry','content-PAGE_STATE-popup','queue-observed-with-unknown-entry-resumes-observation','local-DOM-update-without-reload'],
                      'pageActions':actions,'workerFetchCalls':counts['fetch'],'entryApiCalls':counts['entry'],
                      'pageStateCalls':len(counts['states']),'fixtureNavigations':len(fixture_loads),
                      'externalRequests':blocked_requests,'consoleErrors':errors,'consoleWarnings':warnings,'evidence':str(evidence)}, ensure_ascii=True))
    context.close()
