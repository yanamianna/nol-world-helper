"""Isolated MV3 announcement recovery QA with ordinary-ticket fixtures.

Browser plugin not available; Playwright controls only fresh QA profiles and local
responses. The modal, time window, account and verifier responses are synthetic.
No personal browser, real CAPTCHA, official queue, inventory, order or payment.
CDP only reads our fixture's closed shadow DOM so trusted mouse clicks can target
extension controls; no production shadow mode or page function is replaced.
"""
import argparse
import json
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright
from ocr_smoke import ClosedShadow

URL = 'https://world.nol.com/zh-CN/ticket/places/26001167/products/26013793'
PRODUCT = 'JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON'


def korean_time(value):
    return (value + timedelta(hours=9)).strftime('%Y-%m-%d %H:%M:%S')


def call(page, kind, **fields):
    response = page.evaluate('(m)=>chrome.runtime.sendMessage(m)', {'type': kind, **fields})
    assert response['ok'], response
    return response.get('data')


def fixture_html(raw):
    scripts = re.findall(r'<script\b[^>]*>([\s\S]*?)</script\s*>', raw, re.I)
    flight = ''.join('<script type="application/json">'+script+'</script>' for script in scripts if 'self.__next_f.push' in script)
    return '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>普通票公告恢复 · 离线 QA</title>
<style>body{font:15px system-ui,sans-serif;margin:24px;color:#1e293b;background:#f5f8fd}h1{font-size:22px}p{max-width:650px}button{font:inherit;padding:10px 14px;border:1px solid #b7c7e0;border-radius:8px;background:white;color:#1e293b;cursor:pointer}.announcement{max-width:520px;background:#fff;border:1px solid #bfd0ec;border-radius:12px;padding:24px;margin:24px 0;box-sizing:border-box;box-shadow:0 6px 24px #1e293b12}[hidden]{display:none!important}@media(max-width:640px){body{margin:16px}.announcement{padding:16px}}</style></head><body>
<h1>普通票公告恢复测试</h1><p>离线合成公告。只有你点击扩展“已处理提示，继续”，才重新检查并尝试一次入场。</p>
<div class="grid-area_purchase-button"><button class="nds-e-rectangle-button--variant_filled_primary" onclick="window.entryClicks=(window.entryClicks||0)+1">预约</button></div>
<section class="announcement" role="dialog" aria-modal="true" aria-label="离线购票公告"><h2>购票前公告</h2><p>这里是测试用提示内容，不是真实购票公告。请人工关闭，再检查扩展恢复操作。</p><button id="close-announcement" onclick="document.querySelector('.announcement').hidden=true">我已阅读，关闭公告</button></section>
<button id="reopen-announcement" onclick="document.querySelector('.announcement').hidden=false">重新显示测试公告</button>
<script>window.turnstile={render:(_container,options)=>{setTimeout(()=>options.callback('fixture-turnstile'),0);return 'fixture-widget';},remove:()=>{}};</script>
'''+flight+'</body></html>'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser-executable', default=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
    parser.add_argument('--extension-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--outdir', type=Path)
    args = parser.parse_args()
    extension = args.extension_root.resolve()
    evidence = args.outdir or Path(tempfile.mkdtemp(prefix='nol-modal-evidence-'))
    evidence.mkdir(parents=True, exist_ok=True)
    raw = (extension/'tests/fixtures/product.html').read_text(encoding='utf-8')
    runtime = json.loads((extension/'tests/fixtures/product-runtime.json').read_text(encoding='utf-8'))
    sales = next(item['json'] for item in runtime['responses'] if 'salesinfo?' in item['url'])
    now = datetime.now(timezone.utc)
    sales['data']['salesInfo']['bookingOpenTime'] = korean_time(now-timedelta(minutes=5))
    sales['data']['salesInfo']['bookingEndTime'] = korean_time(now+timedelta(days=1))
    errors, warnings, external_requests, entry_posts, checks = [], [], [], [], []
    html = fixture_html(raw)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix='nol-modal-profile-'), executable_path=args.browser_executable,
            headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
            ignore_default_args=['--disable-extensions'], viewport={'width':1280,'height':980})
        def route(request):
            url = request.request.url
            if url.startswith('chrome-extension://'):
                request.continue_()
            elif url == URL:
                request.fulfill(body=html, content_type='text/html; charset=utf-8')
            elif '/api/ent-channel-out/v1/goods/salesinfo?' in url:
                request.fulfill(json=sales)
            elif url.startswith('https://world.nol.com/api/users/enter?'):
                request.fulfill(json={'enterHasEmail':True})
            elif url == 'https://world.nol.com/api/users':
                request.fulfill(json={'uid':'fixture-uid'})
            elif url == 'https://world.nol.com/api/users/enter/token':
                assert request.request.method == 'POST'
                payload = request.request.post_data_json
                assert payload == {'goodsCode':'26013793','placeCode':'26001167','turnstileToken':'fixture-turnstile'}
                entry_posts.append('synthetic-entry-post')
                request.fulfill(json={'access_token':'fixture-access','refresh_token':'fixture-refresh'})
            elif url.startswith('https://tickets.interpark.com/gates/partner?'):
                request.fulfill(body='<!doctype html><html><head><title>离线官方入口响应</title></head><body><h1>已收到一次合成入场请求</h1><p>这里不是真实队列。</p></body></html>', content_type='text/html; charset=utf-8')
            else:
                external_requests.append(url)
                request.abort('blockedbyclient')
        context.route('**/*', route)
        context.on('console', lambda message: errors.append(message.text) if message.type=='error' else warnings.append(message.text) if message.type=='warning' else None)
        context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
        workers = context.service_workers
        worker = workers[0] if workers else context.wait_for_event('serviceworker', timeout=15000)
        worker.evaluate('''fixtures=>{
            globalThis.__qa={productReads:0,salesReads:0,entryCalls:0,continueMessages:0,createTabs:0,unexpectedFetch:0};globalThis.__qaMessages=[];
            globalThis.fetch=async input=>{
                const url=String(input);
                if(url===fixtures.url){__qa.productReads++;return new Response(fixtures.html,{status:200,headers:{'Content-Type':'text/html'}});}
                if(url.startsWith('https://world.nol.com/api/ent-channel-out/v1/goods/salesinfo?')){__qa.salesReads++;return new Response(JSON.stringify(fixtures.sales),{status:200,headers:{'Content-Type':'application/json'}});}
                __qa.unexpectedFetch++;throw Error('QA blocks unexpected worker network');
            };
            const execute=chrome.scripting.executeScript.bind(chrome.scripting);
            chrome.scripting.executeScript=details=>{if(details.func?.name==='officialEntry')__qa.entryCalls++;return execute(details);};
            const create=chrome.tabs.create.bind(chrome.tabs);
            chrome.tabs.create=properties=>{__qa.createTabs++;return create(properties);};
            chrome.runtime.onMessage.addListener(message=>{if(message.type==='CONTINUE_ENTRY')__qa.continueMessages++;if(['PAGE_STATE','CLAIM_ENTRY','CONTINUE_ENTRY','API_ENTRY'].includes(message.type))__qaMessages.push({type:message.type,runId:message.runId,status:message.status,code:message.code});return false;});
        }''', {'url':URL,'html':raw,'sales':sales})
        extension_id = worker.url.split('/')[2]
        control = context.new_page()
        control.goto(f'chrome-extension://{extension_id}/popup.html')
        control.wait_for_selector('#popup-task')
        with context.expect_page() as created:
            tab_id = worker.evaluate("async()=> (await chrome.tabs.create({url:'about:blank',active:true})).id")
        page = created.value
        ui = ClosedShadow(context, page)

        def current_run():
            return call(control, 'GET_STATE')['run']

        def wait_run(fields, timeout=10000):
            deadline = time.monotonic()+timeout/1000
            state = None
            while time.monotonic()<deadline:
                state = current_run()
                if state and all(state.get(key)==value for key,value in fields.items()):
                    return state
                page.wait_for_timeout(40)
            raise AssertionError(f'Expected run state {fields}, actual {state}')

        def seed(name, *, status='armed', **fields):
            stamp = datetime.now(timezone.utc)
            opening = (stamp-timedelta(minutes=5)).isoformat()
            end = (stamp+timedelta(days=1)).isoformat()
            task = {'id':'modal-ticket-task','name':'QA 普通票公告恢复','kind':'ticket','productUrl':URL,'goodsCode':'26013793','placeCode':'26001167','productName':PRODUCT,
                'openAt':opening,'officialEndAt':end,'openAtSource':'official','stage':'general','preSaleSeq':'','quantity':1,'maxTotal':None,'currency':'KRW','profileId':'qa-contact',
                'alternatives':[{'date':'2026-10-30','time':'19:00','gradeLabel':'测试指定席','seatGrade':'SYNTHETIC_A','priceGrade':'SYNTHETIC_P1','zones':[]}]}
            profile = {'id':'qa-contact','label':'离线联系人','lastName':'TEST','firstName':'USER','email':'fixture@example.test','phone':'123456789','countryCode':'+86'}
            run = {'id':'modal-'+name,'taskId':task['id'],'tabId':tab_id,'status':status,'openAt':(stamp+timedelta(seconds=1.5)).isoformat(),'officialOpenAt':opening,'officialEndAt':end,
                'entryClaimed':False,'apiDispatched':False,'entryAttempted':False,'entrySubmitted':False,'entryResultCode':None,'events':[],'step':'等待官网开售','reason':'QA 等待测试公告处理。'}
            run.update(fields)
            control.evaluate('fixture=>chrome.storage.local.set({nolHelperState:fixture})', {'tasks':[task],'profiles':[profile],'run':run})
            page.goto(URL)
            page.bring_to_front()
            assert page.url == URL and page.title() == '普通票公告恢复 · 离线 QA'
            assert page.locator('body').inner_text().strip() and page.locator('nextjs-portal,vite-error-overlay').count()==0
            return run['id']

        first_id = seed('first')
        blocked = wait_run({'id':first_id,'status':'waiting-manual','manualBlockCode':'MODAL_REQUIRES_MANUAL'})
        assert not blocked['entryClaimed'] and not blocked['apiDispatched'] and len(entry_posts)==0
        ui.wait('continue-entry', lambda value: value and value['visible'] and not value['disabled'])
        assert ui.state('continue-entry')['text'] == '已处理提示，继续'
        page.screenshot(path=str(evidence/'modal-blocked-desktop.png'))
        page.screenshot(path=str(evidence/'helper-panel.png'),clip=ui.state('box')['rect'])
        checks.append('visible-announcement-blocks-zero-post')
        before = worker.evaluate('globalThis.__qa.continueMessages')
        ui.click('continue-entry')
        page.wait_for_timeout(250)
        assert worker.evaluate('globalThis.__qa.continueMessages')==before
        assert current_run()['status']=='waiting-manual' and len(entry_posts)==0
        checks.append('continue-while-modal-visible-rejected-before-message')
        page.locator('#close-announcement').click()
        page.wait_for_timeout(1300)
        assert current_run()['status']=='waiting-manual' and len(entry_posts)==0
        checks.append('manual-modal-close-does-not-auto-enter')
        rect = ui.state('continue-entry')['rect']
        page.mouse.dblclick(rect['x']+rect['width']/2,rect['y']+rect['height']/2,delay=40)
        page.wait_for_url('https://tickets.interpark.com/gates/partner?**',timeout=15000)
        wait_run({'entryClaimed':True,'entrySubmitted':True})
        assert len(entry_posts)==1 and current_run()['id']==first_id
        assert worker.evaluate('globalThis.__qa.createTabs')==1
        assert worker.evaluate('globalThis.__qa.entryCalls')==1
        checks.append('trusted-double-click-continues-same-run-tab-one-post')
        page.goto(URL)
        page.wait_for_timeout(1400)
        assert len(entry_posts)==1 and page.evaluate('window.entryClicks||0')==0
        assert not ui.state('continue-entry')['visible']
        checks.append('already-submitted-reload-cannot-repeat')

        # Reopening the same modal must not be swallowed by a prior PAGE_STATE key.
        # Stop the prior fixture run and unload its content script before seeding
        # a new independent case; otherwise an in-flight old PAGE_STATE can race
        # a direct test-only storage write.
        call(control, 'STOP')
        page.goto('about:blank')
        second_id = seed('reopened')
        blocked = wait_run({'id':second_id,'status':'waiting-manual','manualBlockCode':'MODAL_REQUIRES_MANUAL'})
        assert blocked['id']==second_id and not blocked['entryClaimed']
        # Close immediately after persistence, without waiting for the helper's
        # render: this also covers tick/PAGE_STATE refresh serialization.
        page.locator('#close-announcement').click()
        try:
            ui.click('continue-entry')
        except Exception:
            failed = current_run()
            print(json.dumps({'failure':'rapid-close-before-helper-render','run':{key:failed.get(key) for key in ['id','status','manualBlockCode','entryClaimed','apiDispatched','entryAttempted','entrySubmitted','entryResultCode','reason']},'helper':ui.state('step'),'entryPosts':len(entry_posts),'background':worker.evaluate('globalThis.__qa'),'messages':worker.evaluate('globalThis.__qaMessages')},ensure_ascii=True))
            page.screenshot(path=str(evidence/'rapid-close-failure.png'))
            raise
        wait_run({'status':'armed','entryClaimed':False})
        page.locator('#reopen-announcement').click()
        wait_run({'status':'waiting-manual','manualBlockCode':'MODAL_REQUIRES_MANUAL'})
        assert len(entry_posts)==1 and current_run()['id']==second_id
        checks.append('reopened-modal-blocks-again-without-dispatch')
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(evidence/'modal-blocked-mobile.png'))
        page.locator('#close-announcement').click()
        ui.click('continue-entry')
        page.wait_for_url('https://tickets.interpark.com/gates/partner?**',timeout=15000)
        wait_run({'entryClaimed':True,'entrySubmitted':True})
        assert len(entry_posts)==2 and worker.evaluate('globalThis.__qa.entryCalls')==2
        assert worker.evaluate('globalThis.__qa.createTabs')==1
        checks.append('reopened-modal-manual-continue-mobile-one-post')

        # Even inconsistent stale modal codes cannot expose a second-entry action.
        for name, fields in [
            ('dispatched',{'apiDispatched':True}),
            ('claimed',{'entryClaimed':True}),
            ('unknown-result',{'entryClaimed':True,'apiDispatched':True,'entryAttempted':True,'entryResultCode':'ENTRY_RESPONSE_UNKNOWN'}),
        ]:
            call(control, 'STOP')
            page.goto('about:blank')
            seed(name,status='waiting-manual',manualBlockCode='MODAL_REQUIRES_MANUAL',**fields)
            page.wait_for_timeout(1200)
            assert not ui.state('continue-entry')['visible'], name
            assert len(entry_posts)==2 and worker.evaluate('globalThis.__qa.entryCalls')==2
            checks.append(name+'-recovery-button-hidden')
        assert not errors and not warnings, (errors,warnings)
        assert not external_requests, external_requests
        counts = worker.evaluate('globalThis.__qa')
        assert counts['unexpectedFetch']==0 and counts['createTabs']==1
        report = {'at':datetime.now(timezone.utc).isoformat(),'browser':context.browser.version,'version':worker.evaluate('chrome.runtime.getManifest().version'),'passed':len(checks),'checks':checks,
            'entryPosts':len(entry_posts),'sameTabContinuations':True,'background':counts,'consoleErrors':errors,'consoleWarnings':warnings,'externalRequests':external_requests,
            'evidence':str(evidence),'limitations':['Synthetic ordinary-ticket fixture and verifier only. No real account, CAPTCHA, queue, inventory, seat lock, order or payment was used.']}
        (evidence/'report.json').write_bytes(json.dumps(report,ensure_ascii=False,indent=2).encode('utf-8'))
        print(json.dumps(report,ensure_ascii=True))
        context.close()


if __name__=='__main__':
    main()
