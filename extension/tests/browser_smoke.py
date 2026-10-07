"""Isolated Chromium MV3 integration test. No real login, queue, order or payment.
Browser plugin not available; Playwright exercises our own extension and local fixtures.
Screenshots and browser profiles stay outside source.
Flow: product URL -> automatic public metadata -> ordered choices -> saved foreground run.
"""
import json
import os
import re
import sys
import tempfile
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
args = argparse.ArgumentParser()
args.add_argument('evidence', nargs='?', default=None)
args.add_argument('--browser-executable', default=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
ARGS = args.parse_args()
EVIDENCE = Path(ARGS.evidence) if ARGS.evidence else Path(tempfile.mkdtemp(prefix='nol-qa-'))
EVIDENCE.mkdir(parents=True, exist_ok=True)
EXECUTABLE = ARGS.browser_executable
URL = 'https://world.nol.com/zh-CN/ticket/places/26001167/products/26013792'
RAW = (FIXTURES / 'product.html').read_text(encoding='utf-8')
RUNTIME = json.loads((FIXTURES / 'product-runtime.json').read_text(encoding='utf-8'))
SALES = next(r['json'] for r in RUNTIME['responses'] if 'salesinfo?' in r['url'])
# Preserve captured Flight as inert data, strip all external JS/network references.
scripts = re.findall(r'<script\b[^>]*>([\s\S]*?)</script\s*>', RAW, re.I)
flight = ''.join('<script type="application/json">'+s+'</script>' for s in scripts if 'self.__next_f.push' in s)
# Button structure comes from the captured real page. State changes are fixture-only.
FIXTURE = '''<!doctype html><html><head><meta charset="utf-8"><title>NOL 捕获结构计时测试</title></head><body>
<h1>NOL 本地入口测试</h1><p>真实按钮结构，离线场景，无订单。</p>
<div class="grid-area_purchase-button"><button class="nds-e-rectangle-button--variant_filled_primary" onclick="window.entryClicks=(window.entryClicks||0)+1">预约</button></div>
'''+flight+'</body></html>'

def call(page, kind, **kwargs):
    result = page.evaluate('(m) => chrome.runtime.sendMessage(m)', {'type': kind, **kwargs})
    assert result['ok'], result
    return result.get('data')

def run():
    errors = []
    warnings = []
    with sync_playwright() as p:
        profile = tempfile.mkdtemp(prefix='nol-browser-qa-')
        context = p.chromium.launch_persistent_context(profile, executable_path=EXECUTABLE, headless=True,
            args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'],
            ignore_default_args=['--disable-extensions'], viewport={'width':1280,'height':980})
        def route(req):
            if req.request.url.startswith('chrome-extension://'):
                req.continue_()
            elif '/api/ent-channel-out/v1/goods/salesinfo?' in req.request.url:
                req.fulfill(json=SALES)
            elif req.request.url == URL:
                req.fulfill(body=FIXTURE, content_type='text/html; charset=utf-8')
            else:
                req.abort()
        context.route('**/*', route)
        def observe(page):
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('console',lambda m:errors.append(m.text) if m.type=='error' else warnings.append(m.text) if m.type=='warning' else None)
        context.on('page',observe)
        workers = context.service_workers
        worker = workers[0] if workers else context.wait_for_event('serviceworker',timeout=15000)
        worker.evaluate('''fixtures => {
            globalThis.__fixtureSales=fixtures.sales;
            globalThis.__fixtureReads=0;
            globalThis.fetch=async (input) => {
                const sales=String(input).includes("salesinfo?");
                if(!sales) globalThis.__fixtureReads++;
                return new Response(sales ? JSON.stringify(globalThis.__fixtureSales) : fixtures.html,
                    {status:200,headers:{"Content-Type":sales ? "application/json" : "text/html"}});
            };
        }''', {'html':RAW,'sales':SALES})
        # Extension-created Chrome tabs can navigate before Playwright attaches.
        # Keep the real tabs API/IDs, but attach before navigating the offline fixture.
        worker.evaluate('() => { const create=chrome.tabs.create.bind(chrome.tabs);chrome.tabs.create=(properties)=>create({...properties,url:"about:blank"}); }')
        extension_id = worker.url.split('/')[2]
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options.html')
        page.wait_for_selector('#task-name')
        assert page.url.endswith('/options.html') and '任务设置' in page.title()
        assert page.locator('body').inner_text().strip()
        assert page.locator('nextjs-portal, vite-error-overlay').count()==0
        assert '售票后段未实测' in page.locator('body').inner_text()
        assert page.locator('#max-total').count()==0, 'Price ceiling input must be removed'
        assert '购票优先顺序' in page.locator('body').inner_text()
        # Form persistence through the real extension service worker.
        page.locator('#profiles-tab').click()
        values={'profile-label':'QA 本机联系人','profile-last-name':'TEST','profile-first-name':'USER','profile-email':'fixture@example.com','profile-phone':'13800000000','profile-country-code':'+86'}
        for key,value in values.items(): page.locator('#'+key).fill(value)
        page.locator('#profile-form button[type="submit"]').click()
        page.wait_for_function('() => document.querySelector("#profile-list").textContent.includes("QA 本机联系人")')
        state=call(page,'GET_STATE'); assert len(state['profiles'])==1
        page.locator('#tasks-tab').click()
        # Pasting a valid URL must read automatically; no button click starts this read.
        reads=worker.evaluate('globalThis.__fixtureReads')
        page.locator('#product-url').fill('')
        page.locator('#product-url').fill(URL)
        page.wait_for_function('() => document.querySelector("#product-summary").textContent.includes("26013792") && document.querySelector("#open-at").value==="2026-10-12T19:00"')
        assert worker.evaluate('globalThis.__fixtureReads')>reads
        assert page.locator('.alt-package-select option').count()==25
        assert '2026-10-12T19:00'==page.locator('#open-at').input_value()
        assert '20:00' in page.locator('#open-at-hint').inner_text()
        page.locator('#task-stage').select_option('presale')
        assert '2026-10-08T19:00'==page.locator('#open-at').input_value()
        # Missing public stage time is the case that allows a manual fallback.
        worker.evaluate('() => { globalThis.__fixtureSales.data.preSalesInfo=[]; }')
        page.locator('#read-product').click()
        page.wait_for_function('() => document.querySelector("#open-at").value==="" && !document.querySelector("#open-at").readOnly')
        assert page.locator('#open-at').is_editable()
        page.locator('#open-at').fill('2026-10-09T19:00')
        page.locator('#task-stage').select_option('general')
        worker.evaluate('sales => { globalThis.__fixtureSales=sales; }', SALES)
        page.locator('#read-product').click()
        page.wait_for_function('() => document.querySelector("#open-at").value==="2026-10-12T19:00"')
        page.locator('#task-stage').select_option('presale')
        page.wait_for_function('() => document.querySelector("#open-at").value==="2026-10-08T19:00"')
        page.locator('#task-stage').select_option('general')
        assert '2026-10-12T19:00'==page.locator('#open-at').input_value()
        cards=page.locator('.alternative-card')
        cards.nth(0).locator('.alt-date').fill('2026-10-30')
        cards.nth(0).locator('.alt-time').fill('19:00')
        cards.nth(0).locator('.alt-package-select').select_option('0')
        assert cards.nth(0).locator('.alt-people').input_value()=='2'
        page.locator('#add-alternative').click()
        assert cards.count()==2
        assert '第一选择' in cards.nth(0).locator('.alternative-heading strong').inner_text()
        assert '第2选择' in re.sub(r'\s+', '', cards.nth(1).locator('.alternative-heading strong').inner_text())
        cards.nth(1).locator('.alt-date').fill('2026-10-31')
        cards.nth(1).locator('.alt-time').fill('18:00')
        cards.nth(1).locator('.alt-package-select').select_option('1')
        cards.nth(1).locator('.alt-zones').fill('A区，B区')
        cards.nth(0).locator('.alternative-controls button').filter(has_text='下移').click()
        assert cards.nth(0).locator('.alt-date').input_value()=='2026-10-31'
        assert cards.nth(1).locator('.alt-date').input_value()=='2026-10-30'
        cards.nth(1).locator('.alternative-controls button').filter(has_text='上移').click()
        assert cards.nth(0).locator('.alt-date').input_value()=='2026-10-30'
        assert cards.nth(1).locator('.alt-date').input_value()=='2026-10-31'
        page.locator('#task-profile').select_option(state['profiles'][0]['id'])
        page.locator('#task-form button[type="submit"]').click()
        page.wait_for_function('() => document.querySelector("#task-list").textContent.includes("JEONGHAN")')
        state=call(page,'GET_STATE')
        assert len(state['tasks'])==1 and state['tasks'][0]['alternatives'][0]['people']==2
        assert state['tasks'][0].get('maxTotal') is None
        assert [choice['date'] for choice in state['tasks'][0]['alternatives']]==['2026-10-30','2026-10-31']
        assert state['tasks'][0]['alternatives'][1]['zones']==['A区','B区']
        # Reopening a stored task must automatically refresh public stage metadata.
        reads=worker.evaluate('globalThis.__fixtureReads')
        page.reload()
        page.wait_for_function('() => document.querySelector("#open-at").value==="2026-10-12T19:00" && document.querySelectorAll(".alt-package-select option").length===50')
        assert worker.evaluate('globalThis.__fixtureReads')>reads
        page.locator('#task-stage').select_option('presale')
        assert '2026-10-08T19:00'==page.locator('#open-at').input_value()
        page.locator('#task-stage').select_option('general')
        # A user-entered countdown test time survives automatic metadata refresh.
        page.locator('#open-at').fill('2099-10-12T19:00')
        page.locator('#task-form button[type="submit"]').click()
        page.wait_for_function('() => document.querySelector("#task-list").textContent.includes("2099-10-12")')
        page.reload()
        page.wait_for_function('() => document.querySelector("#open-at").value==="2099-10-12T19:00" && document.querySelectorAll(".alt-package-select option").length===50')
        page.locator('#task-stage').select_option('presale')
        assert '2026-10-08T19:00'==page.locator('#open-at').input_value()
        page.locator('#task-stage').select_option('general')
        # The UI's save-and-arm button accepts a task without any price ceiling.
        with context.expect_page() as waiting:
            page.locator('#arm-task').click()
        waiting.value.wait_for_url('about:blank')
        state=call(page,'GET_STATE')
        assert state['run']['status']=='armed' and state['run']['task'].get('maxTotal') is None
        assert state['run']['task']['openAt']=='2026-10-12T11:00:00.000Z'
        page.wait_for_function('() => document.querySelector("#open-at").value==="2026-10-12T19:00"',timeout=3000)
        call(page,'STOP')
        waiting.value.close()
        page.evaluate('() => window.scrollTo(0,0)')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(EVIDENCE/'options-first-viewport.png'))
        page.screenshot(path=str(EVIDENCE/'options-desktop.png'), full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(EVIDENCE/'options-mobile.png'),full_page=True)
        page.set_viewport_size({'width':1280,'height':980})
        # Deterministic front-tab entry using real SW/claim/content script, fixture DOM only.
        task=state['tasks'][0]
        task['openAt']=(datetime.now(timezone.utc)+timedelta(seconds=6)).isoformat()
        call(page,'SAVE_TASK',task=task)
        with context.expect_page() as created:
            call(page,'ARM',taskId=task['id'])
        product=created.value
        product.goto(URL)
        product.wait_for_url(URL)
        product.bring_to_front()
        product.wait_for_function('() => (window.entryClicks || 0)===1',timeout=12000)
        product.wait_for_timeout(1200)
        assert product.evaluate('window.entryClicks')==1
        state=call(page,'GET_STATE'); assert state['run']['entryClaimed'] and state['run']['entryClicked']
        assert state['run']['task'].get('maxTotal') is None
        assert 0 <= state['run']['latencyMs'] < 1500, state['run']
        product.reload();product.wait_for_timeout(1200)
        assert product.evaluate('window.entryClicks || 0')==0, 'Reload must never repeat the official entry'
        call(page,'PAUSE');assert call(page,'GET_STATE')['run']['status']=='paused'
        call(page,'STOP');assert call(page,'GET_STATE')['run']['status']=='stopped'
        popup=context.new_page();popup.goto(f'chrome-extension://{extension_id}/popup.html')
        popup.wait_for_selector('#popup-task option[value="'+task['id']+'"]',state='attached')
        popup.set_viewport_size({'width':360,'height':640})
        assert popup.evaluate('document.documentElement.scrollWidth <= innerWidth')
        popup.screenshot(path=str(EVIDENCE/'popup.png'),full_page=True)
        diagnostics=call(page,'EXPORT_DIAGNOSTICS')
        assert 'fixture@example.com' not in json.dumps(diagnostics) and '13800000000' not in json.dumps(diagnostics)
        assert not errors, errors
        print(json.dumps({'browser':'Edge' if 'msedge' in EXECUTABLE.lower() else 'Chrome for Testing','extensionId':extension_id,'screens':['1280x980','390x844','popup360'],'latencyMs':state['run']['latencyMs'],'consoleErrors':errors,'consoleWarnings':warnings,'tests':['MV3 loads','profile CRUD','automatic URL metadata read24prices','missing stage time manual fallback','general/presale timezone','no price ceiling save/arm','purchase priority reorder/persistence','saved task automatic refresh','manual countdown time retained','one foreground entry','no reload repeat','pause/stop','popup','no overflow','diagnostics redaction'],'evidence':str(EVIDENCE)},ensure_ascii=True))
        context.close()

if __name__=='__main__': run()
