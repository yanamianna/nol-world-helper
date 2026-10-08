"""Targeted popup/MV3 state QA only, with a new temporary browser profile.
Browser plugin not available; Playwright is allowed for own extension fixtures.
No actual website, account, CAPTCHA, entry API, queue, order, or payment.
"""
import argparse
import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright, Error as PlaywrightError

parser = argparse.ArgumentParser()
parser.add_argument('--outdir', default=None)
parser.add_argument('--real-navigation', action='store_true', help='Opt-in experimental real browser navigation timeout check; may expose browser event races')
parser.add_argument('--browser-executable', default=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
parser.add_argument('--extension-root', type=Path, default=Path(__file__).resolve().parents[1])
args = parser.parse_args()
evidence = Path(args.outdir) if args.outdir else Path(tempfile.mkdtemp(prefix='nol-popup-evidence-'))
evidence.mkdir(parents=True, exist_ok=True)
errors, warnings, external_requests, checks = [], [], [], []
aborted_navigations = []
GATE = 'https://tickets.interpark.com/gates/partner'

def call(page, kind):
    return page.evaluate('(type) => chrome.runtime.sendMessage({type})', kind)

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(prefix='nol-popup-state-qa-'), executable_path=args.browser_executable,
        headless=True, args=[f'--disable-extensions-except={args.extension_root.resolve()}', f'--load-extension={args.extension_root.resolve()}'],
        ignore_default_args=['--disable-extensions'], viewport={'width': 360, 'height': 720})
    def route(request):
        if request.request.url.startswith('chrome-extension://'):
            request.continue_()
        elif request.request.url == GATE and request.request.is_navigation_request():
            aborted_navigations.append(request.request.url)
            request.abort('timedout')
        else:
            external_requests.append(request.request.url)
            request.abort()
    context.route('**/*', route)
    context.on('console', lambda m: errors.append(m.text) if m.type == 'error' else warnings.append(m.text) if m.type == 'warning' else None)
    workers = context.service_workers
    worker = workers[0] if workers else context.wait_for_event('serviceworker', timeout=15000)
    runtime = worker.evaluate('({version:chrome.runtime.getManifest().version,navigationListener:chrome.webNavigation.onErrorOccurred.hasListeners()})')
    assert runtime['navigationListener'], runtime
    worker.evaluate('''() => {
        globalThis.__qaFetchCalls=0;
        globalThis.__qaEntryCalls=0;
        globalThis.fetch=async()=>{globalThis.__qaFetchCalls++;throw new Error('QA blocks all network');};
        const execute=chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.scripting.executeScript=(details)=>{
            if(details.func?.name==='officialEntry')globalThis.__qaEntryCalls++;
            return execute(details);
        };
    }''')
    extension_id = worker.url.split('/')[2]
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(f'chrome-extension://{extension_id}/popup.html')
    page.wait_for_selector('#popup-task')
    assert page.title() == 'NOL 公演助手' and page.url.endswith('/popup.html')
    assert page.locator('body').inner_text().strip()
    assert page.locator('nextjs-portal, vite-error-overlay').count() == 0
    page.evaluate('''() => {
        globalThis.__qaMessages=[];
        const send=chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage=(message,...rest)=>{globalThis.__qaMessages.push(message.type);return send(message,...rest);};
    }''')

    def seed(name, *, status='paused', past=False, **fields):
        now = datetime.now(timezone.utc)
        opening = (now + timedelta(minutes=-5 if past else 10)).isoformat()
        end = (now + timedelta(days=1)).isoformat()
        task = {'id':'qa-task', 'name':'QA 官方入场状态', 'openAt':opening, 'officialEndAt':end,
                'openAtSource':'official', 'stage':'general', 'maxTotal':None}
        reason = f'QA {name}：保留后台原始原因。'
        run = {'id':f'qa-{name}', 'taskId':task['id'], 'status':status, 'openAt':opening,
               'step':'测试状态', 'reason':reason, 'entryClaimed':False, 'apiDispatched':False,
               'entryAttempted':False, 'entrySubmitted':False, 'entryResultCode':None, 'events':[]}
        run.update(fields)
        page.evaluate('(fixture) => chrome.storage.local.set({nolHelperState:fixture})', {'tasks':[task], 'profiles':[], 'run':run})
        page.wait_for_function('(reason) => document.querySelector("#run-detail").textContent.includes(reason)', arg=reason)
        assert page.locator('#popup-stop').is_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        return reason

    def blocked(name, *, screenshot=None, backend_rejects=True, **fields):
        reason = seed(name, **fields)
        assert page.locator('#popup-resume').is_hidden(), name
        assert reason in page.locator('#run-detail').inner_text(), name
        assert '停止后重新启动' in page.locator('#run-detail').inner_text() or '先停止任务' in page.locator('#run-detail').inner_text(), name
        assert page.locator('#popup-arm').is_hidden() and page.locator('#popup-immediate').is_hidden(), name
        if screenshot:
            page.screenshot(path=str(evidence/screenshot), full_page=True)
        # A stale/programmatic click also cannot dispatch a resume request.
        page.evaluate('globalThis.__qaMessages=[]')
        page.locator('#popup-resume').evaluate('(node) => node.click()')
        assert 'RESUME' not in page.evaluate('globalThis.__qaMessages'), name
        assert page.locator('#popup-message').is_visible(), name
        if backend_rejects:
            result = call(page, 'RESUME')
            assert not result['ok'], (name, result)
        page.locator('#popup-stop').click()
        page.wait_for_function('() => document.querySelector("#run-status").textContent==="已停止"')
        assert call(page, 'GET_STATE')['data']['run']['status'] == 'stopped'
        checks.append(name)

    seed('before-opening')
    assert page.locator('#popup-resume').is_visible()
    assert page.locator('#popup-resume').inner_text() == '继续值守'
    page.locator('#popup-resume').click()
    page.wait_for_function('() => document.querySelector("#run-status").textContent==="等待开售"')
    assert call(page, 'GET_STATE')['data']['run']['status'] == 'armed'
    checks.append('before-opening-resumes-armed')

    blocked('missed-before-claim', status='waiting-manual', past=True)
    blocked('claimed-unsubmitted', entryClaimed=True)
    blocked('unknown-response', status='waiting-manual', past=True, entryClaimed=True,
            apiDispatched=True, entryAttempted=True, entryResultCode='ENTRY_RESPONSE_UNKNOWN',
            screenshot='unknown-entry-no-resume.png')
    blocked('cancelled-verification', entryClaimed=True, apiDispatched=True, entryResultCode='ENTRY_CANCELLED')
    # Defensive UI coverage for a legacy/inconsistent state. The button guard
    # prevents dispatch; this fixture makes no assertion about backend rejection.
    blocked('dispatched-without-claim', apiDispatched=True, backend_rejects=False)

    reason = seed('confirmed-entry', past=True, entryClaimed=True, apiDispatched=True,
                  entryAttempted=True, entrySubmitted=True, entryResultCode='ENTRY_REDIRECTING')
    assert page.locator('#popup-resume').is_visible()
    assert page.locator('#popup-resume').inner_text() == '继续观察'
    assert reason in page.locator('#run-detail').inner_text()
    assert '不会重新验证或再次提交' in page.locator('#run-detail').inner_text()
    page.screenshot(path=str(evidence/'confirmed-entry-observe.png'), full_page=True)
    page.locator('#popup-resume').click()
    page.wait_for_function('() => document.querySelector("#run-status").textContent==="正在运行"')
    resumed = call(page, 'GET_STATE')['data']['run']
    assert resumed['status'] == 'running' and resumed['entrySubmitted']
    assert '不会重新验证或再次提交' in resumed['reason']
    checks.append('confirmed-entry-observation-only')

    blocked('navigation-failed-after-entry', status='waiting-manual', past=True,
            entryClaimed=True, apiDispatched=True, entryAttempted=True, entrySubmitted=True,
            entryResultCode='ENTRY_REDIRECTING', navigationErrorCode='net::ERR_CONNECTION_CLOSED',
            screenshot='navigation-failed-no-resume.png')
    blocked('navigation-failed-before-entry', navigationErrorCode='net::ERR_CONNECTION_CLOSED')

    events = []
    if args.real_navigation:
        # Exercise the real browser event and background listener, rather than
        # seeding a navigationErrorCode. No credentials/query or network are used.
        # The extension intentionally lacks broad tabs permission, so about:blank
        # URLs cannot be used to identify tabs. Use the ID returned by tabs.create.
        with context.expect_page() as created:
            tab_id = worker.evaluate("async () => (await chrome.tabs.create({url:'about:blank',active:true})).id")
        gate_page = created.value
        worker.evaluate("() => { globalThis.__qaNavigationEvents=[]; chrome.webNavigation.onErrorOccurred.addListener(details=>{if(details.tabId)globalThis.__qaNavigationEvents.push({tabId:details.tabId,frameId:details.frameId,error:details.error});}); }")
        seed('real-navigation-timeout', status='running', past=True, tabId=tab_id,
             entryClaimed=True, apiDispatched=True, entryAttempted=True,
             entrySubmitted=True, entryResultCode='ENTRY_REDIRECTING')
        try:
            gate_page.goto(GATE, wait_until='commit', timeout=5000)
        except PlaywrightError as error:
            assert 'ERR_TIMED_OUT' in str(error), str(error)
        page.wait_for_function("async () => { const s=(await chrome.storage.local.get('nolHelperState')).nolHelperState; return s.run.status==='waiting-manual' && !!s.run.navigationErrorCode; }", timeout=5000)
        navigation_run = call(page, 'GET_STATE')['data']['run']
        assert navigation_run.get('navigationErrorHost')=='tickets.interpark.com', 'Navigation event did not settle into the expected task state'
        assert navigation_run['navigationErrorCode']=='ERR_TIMED_OUT', navigation_run
        events = worker.evaluate('globalThis.__qaNavigationEvents')
        assert any(event['tabId']==tab_id and event['frameId']==0 and event['error']=='net::ERR_TIMED_OUT' for event in events), events
        page.wait_for_function("() => document.querySelector('#run-detail').textContent.includes('官网页面连接失败')")
        assert page.locator('#popup-resume').is_hidden() and page.locator('#popup-stop').is_visible()
        assert '官方购票页未能加载' in page.locator('#run-detail').inner_text()
        page.screenshot(path=str(evidence/'real-navigation-timeout.png'), full_page=True)
        assert len(aborted_navigations)==1, aborted_navigations
        checks.append('real-webNavigation-timeout-event')

    counts = worker.evaluate('({fetch:globalThis.__qaFetchCalls,entry:globalThis.__qaEntryCalls})')
    assert counts == {'fetch':0, 'entry':0}, counts
    assert not external_requests, external_requests
    assert not errors and not warnings, (errors, warnings)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    print(json.dumps({'browser':context.browser.version, 'runtime':runtime, 'checks':checks, 'fetchCalls':counts['fetch'],
                      'entryApiCalls':counts['entry'], 'realNavigationEnabled':args.real_navigation, 'abortedOfficialNavigations':len(aborted_navigations), 'navigationEvents':len(events), 'consoleErrors':errors, 'consoleWarnings':warnings,
                      'externalRequests':external_requests, 'evidence':str(evidence)}, ensure_ascii=True))
    context.close()
