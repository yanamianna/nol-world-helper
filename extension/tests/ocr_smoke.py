"""Isolated rendered OCR QA with synthetic images and an in-process fake engine.

Browser plugin not available; Playwright is used only for our own static fixture.
The copied manifest simulates a granted localhost permission. No personal profile,
real CAPTCHA, official ticket API, order, payment, or external network is used.
"""
import argparse
import base64
import importlib.util
import io
import json
import shutil
import tempfile
import threading
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright


URL = 'https://tickets.interpark.com/onestop/seat'
MAP = 'https://ent-ticketimage.interparkcdn.net/svg/26001167/087dd34c78914d7c972c56fc356b0e3b.svg'
PRODUCT = 'JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON'


def synthetic_image(text):
    image = Image.new('RGB', (220, 64), 'white')
    try:
        font = ImageFont.truetype('arial.ttf', 34)
    except OSError:
        font = ImageFont.load_default()
    ImageDraw.Draw(image).text((16, 10), text, fill='#243457', font=font)
    output = io.BytesIO()
    image.save(output, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode('ascii')


def fixture_html(image):
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>隔离选座夹具 · OCR QA</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:15px system-ui,sans-serif;margin:24px;color:#1e293b;background:#f2f5fb}h3{font-size:20px}
.SeatMap_blockImg__QQUF7 img{width:min(100%,600px);height:240px;object-fit:contain}
.ModalLayout_innerWrap__c8kxP{width:min(500px,calc(100% - 32px));background:white;border:1px solid #d5deec;border-radius:12px;padding:20px;box-sizing:border-box;margin:12px 0}
.ModalCaptchaText_layerWrap__jn1bV img{display:block;width:220px;height:64px;margin:14px 0}input,button{font:inherit;padding:9px;max-width:100%;box-sizing:border-box}footer{margin-top:12px}small{color:#64748b}
@media(max-width:500px){body{margin:16px}.ModalLayout_innerWrap__c8kxP{width:100%}h3{font-size:16px}}
</style><h3 class="SubHeader_headerTitle___LjIv">PRODUCT_NAME</h3><span class="SubHeader_scheduleDate__UaD4B">2026.10.30(周五) 7:00 PM</span>
<div class="SeatMap_blockImg__QQUF7"><img alt="blockImg" src="//ent-ticketimage.interparkcdn.net/svg/26001167/087dd34c78914d7c972c56fc356b0e3b.svg"></div>
<div class="ModalLayout_innerWrap__c8kxP"><div class="ModalLayout_content__Zm2NK"><div class="ModalCaptchaText_layerWrap__jn1bV">
<h2 class="ModalCaptchaText_title__uRyg7">請輸入畫面的文字</h2><small>合成图片；无真实验证码、票务、席位或订单</small>
<div class="ModalCaptchaText_captchaImage__Mitgq"><img alt="Captcha Image" src="IMAGE_SOURCE"></div>
<input id="official-input" placeholder="請輸入畫面的文字 (不區分大小寫)"></div></div>
<footer class="ModalLayout_footer__88ZwY"><button id="official-submit">完成輸入</button></footer></div>
<script>window.__fixture={submitted:0,inputEvents:0,changeEvents:0,expiryConfirms:0,fetch:0,xhr:0,scriptedClicks:0,open:0};
document.querySelector('#official-submit').addEventListener('click',e=>{e.preventDefault();__fixture.submitted++});
document.querySelector('#official-input').addEventListener('input',()=>__fixture.inputEvents++);
document.querySelector('#official-input').addEventListener('change',()=>__fixture.changeEvents++);
window.fetch=()=>{__fixture.fetch++;throw Error('No page network in fixture')};
XMLHttpRequest.prototype.open=function(){__fixture.xhr++;throw Error('No XHR in fixture')};
HTMLElement.prototype.click=function(){__fixture.scriptedClicks++;throw Error('No scripted clicks in fixture')};
window.open=()=>{__fixture.open++;return null};</script></html>'''.replace('PRODUCT_NAME', PRODUCT).replace('IMAGE_SOURCE', image)


class ClosedShadow:
    """Read closed shadow DOM through CDP, interact with real mouse/keyboard."""
    def __init__(self, context, page):
        self.page = page
        self.cdp = context.new_cdp_session(page)
        self.cdp.send('DOM.enable')

    def node(self, class_name):
        root = self.cdp.send('DOM.getDocument', {'depth': -1, 'pierce': True})['root']
        def visit(node):
            attrs = node.get('attributes', [])
            attrs = dict(zip(attrs[::2], attrs[1::2]))
            if class_name in attrs.get('class', '').split():
                return node
            for child in node.get('children', []) + node.get('shadowRoots', []):
                found = visit(child)
                if found:
                    return found
            return None
        return visit(root)

    def state(self, class_name):
        node = self.node(class_name)
        if not node:
            return None
        obj = self.cdp.send('DOM.resolveNode', {'backendNodeId': node['backendNodeId']})['object']
        result = self.cdp.send('Runtime.callFunctionOn', {
            'objectId': obj['objectId'], 'returnByValue': True,
            'functionDeclaration': '''function(){const r=this.getBoundingClientRect();return {value:this.value??null,text:this.textContent,disabled:this.disabled===true,visible:this.getClientRects().length>0&&getComputedStyle(this).visibility!=='hidden',rect:{x:r.x,y:r.y,width:r.width,height:r.height},overflow:this.scrollWidth>this.clientWidth};}'''
        })
        return result['result'].get('value')

    def wait(self, class_name, predicate, timeout=10):
        deadline = time.monotonic() + timeout
        state = None
        while time.monotonic() < deadline:
            state = self.state(class_name)
            if predicate(state):
                return state
            self.page.wait_for_timeout(40)
        raise AssertionError(f'{class_name}: expected state not reached: {state}')

    def click(self, class_name):
        state = self.wait(class_name, lambda value: value and value['visible'] and not value['disabled'])
        rect = state['rect']
        self.page.mouse.click(rect['x'] + rect['width']/2, rect['y'] + rect['height']/2)

    def edit(self, value):
        self.click('ocr-value')
        self.page.keyboard.press('Control+A')
        self.page.keyboard.insert_text(value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser-executable', default=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
    parser.add_argument('--extension-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--outdir', type=Path)
    parser.add_argument('--service-unavailable-only', action='store_true', help='Only recheck failure fallback and the hidden preview after the CSS fix.')
    args = parser.parse_args()
    extension = args.extension_root.resolve()
    evidence = args.outdir or Path(tempfile.mkdtemp(prefix='nol-ocr-evidence-'))
    evidence.mkdir(parents=True, exist_ok=True)
    production_manifest = (extension/'manifest.json').read_text(encoding='utf-8')
    module_path = extension.parent/'local-ocr/server.py'
    spec = importlib.util.spec_from_file_location('nol_ocr_qa_server', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    local_requests = []
    class FakeEngine:
        calls = 0
        delay = 0
        started = threading.Event()
        def classification(self, _image, png_fix=True):
            self.calls += 1
            self.started.set()
            time.sleep(self.delay)
            return 'ABCDEF'
    engine = FakeEngine()
    class Handler(module.Handler):
        def reply(self, status, payload):
            local_requests.append({'path': self.path, 'status': status, 'hasExtensionId': bool(self.headers.get('X-NOL-Extension-Id')), 'originPresent': self.headers.get('Origin') is not None})
            super().reply(status, payload)
    server = module.LocalOCRServer((module.HOST, module.PORT), Handler)
    server.recognizer = module.Recognizer(engine)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    server_stopped = False
    errors, warnings, blocked_requests, fixture_loads = [], [], [], []
    first_image, next_image = synthetic_image('ABCDEF'), synthetic_image('UVWXYZ')
    checks = []
    def passed(name):
        checks.append({'case': name, 'passed': True})
    try:
        with tempfile.TemporaryDirectory(prefix='nol-ocr-qa-', ignore_cleanup_errors=True) as temp:
            copied = Path(temp)/'extension'
            shutil.copytree(extension, copied, ignore=shutil.ignore_patterns('tests', '__pycache__'))
            manifest = json.loads(production_manifest)
            manifest['host_permissions'].append('http://127.0.0.1/*')
            (copied/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
            with sync_playwright() as p:
                context = p.chromium.launch_persistent_context(str(Path(temp)/'profile'), executable_path=args.browser_executable, headless=True,
                    args=[f'--disable-extensions-except={copied}', f'--load-extension={copied}', '--disable-background-networking'],
                    ignore_default_args=['--disable-extensions'], viewport={'width': 1180, 'height': 850})
                def route_handler(route):
                    url = route.request.url
                    if url.startswith('chrome-extension://'):
                        route.continue_()
                    elif url in {'http://127.0.0.1:8765/health', 'http://127.0.0.1:8765/recognize'}:
                        route.continue_()
                    elif url == URL and route.request.is_navigation_request():
                        fixture_loads.append('seat-html')
                        route.fulfill(body=fixture_html(first_image), content_type='text/html; charset=utf-8')
                    elif url == MAP:
                        fixture_loads.append('map-svg')
                        route.fulfill(content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="600" height="240" fill="#e5edfb"/><text x="40" y="100" font-size="24">Static map fixture only</text></svg>')
                    else:
                        blocked_requests.append(url)
                        route.abort('blockedbyclient')
                context.route('**/*', route_handler)
                context.on('console', lambda m: errors.append(m.text) if m.type=='error' else warnings.append(m.text) if m.type=='warning' else None)
                context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
                workers = context.service_workers
                worker = workers[0] if workers else context.wait_for_event('serviceworker', timeout=15000)
                worker.evaluate(r'''()=>{globalThis.__qa={localHTTP:0,blockedHTTP:0,entry:0};const original=fetch.bind(globalThis);globalThis.fetch=(input,options)=>{const url=typeof input==='string'?input:input.url;if(!/^http:\/\/127\.0\.0\.1:8765\/(?:health|recognize)$/.test(url)){__qa.blockedHTTP++;throw Error('QA blocks non-loopback network')}__qa.localHTTP++;return original(input,options)};const execute=chrome.scripting.executeScript.bind(chrome.scripting);chrome.scripting.executeScript=details=>{if(details.func?.name==='officialEntry')__qa.entry++;return execute(details)};}''')
                extension_id = worker.url.split('/')[2]
                if args.service_unavailable_only:
                    page = context.new_page()
                    page.goto(URL, wait_until='load')
                    assert page.url == URL and page.title() == '隔离选座夹具 · OCR QA'
                    ui = ClosedShadow(context, page)
                    ui.wait('ocr-recognize', lambda value: value and value['visible'] and not value['disabled'])
                    assert not ui.state('ocr-preview')['visible']
                    server.shutdown()
                    server.server_close()
                    server_thread.join(timeout=5)
                    server_stopped = True
                    ui.click('ocr-recognize')
                    ui.wait('ocr-status', lambda value: value and '无法连接本机识别服务' in value['text'])
                    preview = ui.state('ocr-preview')
                    assert not preview['visible']
                    assert preview['rect']['width'] == preview['rect']['height'] == 0
                    assert ui.state('ocr-fill')['disabled'] and ui.state('ocr-value')['value'] == ''
                    assert page.locator('#official-input').input_value() == ''
                    actions = page.evaluate('window.__fixture')
                    network = worker.evaluate('globalThis.__qa')
                    assert all(value == 0 for value in actions.values()), actions
                    assert network == {'localHTTP':1,'blockedHTTP':0,'entry':0}, network
                    assert not blocked_requests and not warnings
                    unexpected_errors = [message for message in errors if 'ERR_CONNECTION_REFUSED' not in message]
                    assert not unexpected_errors, unexpected_errors
                    assert engine.calls == 0 and local_requests == []
                    assert (extension/'manifest.json').read_text(encoding='utf-8') == production_manifest
                    page.screenshot(path=str(evidence/'service-unavailable-preview-hidden.png'))
                    report = {'browser':context.browser.version,'passed':1,'case':'CSS-fix targeted recheck: unavailable service clears and fully hides preview; manual input remains unchanged',
                        'previewVisible':preview['visible'],'previewRect':preview['rect'],'background':network,'pageActions':actions,'externalNetwork':0,
                        'unexpectedConsoleErrors':unexpected_errors,'warnings':warnings,'productionManifestUnchanged':True,
                        'limitations':['Only this CSS failure-state recheck ran; previous ten interaction cases were not rerun.', 'Localhost permission simulated in isolated manifest copy; no real CAPTCHA, engine accuracy or native permission prompt tested.']}
                    (evidence/'report-preview-hidden.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
                    print(json.dumps(report,ensure_ascii=False))
                    context.close()
                    return
                popup = context.new_page()
                popup.set_viewport_size({'width': 360, 'height': 1020})
                popup.goto(f'chrome-extension://{extension_id}/popup.html')
                popup.wait_for_function("()=>document.querySelector('#ocr-summary').textContent.includes('已允许')")
                assert popup.title() == 'NOL 公演助手'
                assert popup.locator('body').inner_text().strip()
                assert popup.locator('nextjs-portal, vite-error-overlay').count() == 0
                assert popup.evaluate('document.documentElement.scrollWidth <= innerWidth')
                popup.locator('#ocr-health').click()
                popup.wait_for_function("()=>document.querySelector('#ocr-summary').textContent.includes('已就绪')")
                popup.screenshot(path=str(evidence/'popup-360-ocr-card.png'), full_page=True)
                passed('360px popup identity, OCR card, real background health HTTP, no overflow')

                page = context.new_page()
                page.goto(URL, wait_until='load')
                assert page.url == URL and page.title() == '隔离选座夹具 · OCR QA'
                assert page.locator('h3.SubHeader_headerTitle___LjIv').inner_text() == PRODUCT
                assert page.locator('nextjs-portal, vite-error-overlay').count() == 0
                ui = ClosedShadow(context, page)
                ui.wait('ocr-recognize', lambda value: value and value['visible'] and not value['disabled'])
                assert ui.state('ocr-fill')['disabled']
                assert page.locator('#official-input').input_value() == ''
                assert engine.calls == 0
                assert popup.evaluate("async()=> (await chrome.runtime.sendMessage({type:'GET_STATE'})).data.run") is None
                passed('manual browsing without an active run shows helper and performs no recognition')

                ui.click('ocr-recognize')
                ui.wait('ocr-value', lambda value: value and value['value'] == 'ABCDEF')
                assert engine.calls == 1
                assert page.locator('#official-input').input_value() == ''
                page.screenshot(path=str(evidence/'desktop-candidate-review.png'))
                passed('trusted recognize click returns synthetic ABCDEF candidate through real background HTTP')
                ui.edit('ABCDXY')
                assert ui.state('ocr-value')['value'] == 'ABCDXY'
                ui.click('ocr-fill')
                assert page.locator('#official-input').input_value() == 'ABCDXY'
                actions = page.evaluate('window.__fixture')
                assert actions['inputEvents'] == 1 and actions['changeEvents'] == 1
                assert actions['submitted'] == 0
                fill_actions = actions
                ui.wait('ocr-main', lambda value: value and not value['visible'])
                passed('user edits then confirms fill; input/change events update official field without submission')
                ui.click('ocr-toggle')
                ui.wait('ocr-main', lambda value: value and value['visible'])
                ui.click('ocr-toggle')
                ui.wait('ocr-main', lambda value: value and not value['visible'])
                ui.click('ocr-toggle')
                ui.wait('ocr-main', lambda value: value and value['visible'])
                passed('helper collapses after fill and supports manual collapse/reopen')
                page.set_viewport_size({'width': 390, 'height': 844})
                box = ui.state('box')
                assert box['rect']['x'] >= 0 and box['rect']['x']+box['rect']['width'] <= 390
                assert not ui.state('ocr-value')['overflow']
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.screenshot(path=str(evidence/'mobile-390-candidate-review.png'))
                passed('390px mobile helper remains within viewport without horizontal overflow')

                page.set_viewport_size({'width': 1180, 'height': 850})
                page.evaluate('''()=>{const old=document.createElement('div');old.hidden=true;old.className='ModalCaptchaText_layerWrap__jn1bV';old.innerHTML='<input id="old-hidden-input" placeholder="請輸入畫面的文字 (不區分大小寫)">';document.body.insertBefore(old,document.querySelector('.ModalLayout_innerWrap__c8kxP'));document.querySelector('#official-input').value='';}''')
                ui.click('ocr-fill')
                assert page.locator('#official-input').input_value() == 'ABCDXY'
                assert page.locator('#old-hidden-input').input_value() == ''
                ui.wait('ocr-main', lambda value: value and not value['visible'])
                ui.click('ocr-toggle')
                ui.wait('ocr-main', lambda value: value and value['visible'])
                passed('hidden older challenge is never filled; snapshot keeps the verified visible input node')
                page.evaluate("document.querySelector('#official-input').value=''")
                engine.delay = 1.2
                engine.started.clear()
                ui.click('ocr-recognize')
                started_deadline = time.monotonic()+5
                while not engine.started.is_set() and time.monotonic()<started_deadline:
                    page.wait_for_timeout(40)
                assert engine.started.is_set()
                page.evaluate('(src)=>document.querySelector(\'img[alt="Captcha Image"]\').src=src', next_image)
                ui.wait('ocr-recognize', lambda value: value and not value['disabled'])
                ui.wait('ocr-value', lambda value: value and value['value'] == '')
                assert ui.state('ocr-fill')['disabled']
                assert page.locator('#official-input').input_value() == ''
                passed('image refresh while recognition is pending invalidates the old candidate')

                engine.delay = 0
                page.evaluate('(src)=>document.querySelector(\'img[alt="Captcha Image"]\').src=src', first_image)
                page.wait_for_function('document.querySelector(\'img[alt="Captcha Image"]\').complete')
                ui.click('ocr-recognize')
                ui.wait('ocr-value', lambda value: value and value['value'] == 'ABCDEF')
                fill = ui.state('ocr-fill')['rect']
                page.evaluate('''()=>{const dialog=document.createElement('div');dialog.className='nds-e-dialog__container';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.innerHTML='<div class="nds-e-dialog__title">10分钟的座位选择时间已超过</div><div class="nds-e-dialog__description">请重新开始预订</div><button>确定</button>';dialog.querySelector('button').addEventListener('click',()=>__fixture.expiryConfirms++);document.body.append(dialog);}''')
                page.mouse.click(fill['x']+fill['width']/2, fill['y']+fill['height']/2)
                assert page.locator('#official-input').input_value() == ''
                ui.wait('ocr-main', lambda value: value is None or not value['visible'])
                assert page.evaluate('__fixture.expiryConfirms') == 0
                before_reload_actions = page.evaluate('window.__fixture')
                passed('official expiry before confirm rejects fill and never dismisses/re-enters')

                page.reload(wait_until='load')
                ui = ClosedShadow(context, page)
                ui.wait('ocr-recognize', lambda value: value and value['visible'] and not value['disabled'])
                server.shutdown()
                server.server_close()
                server_thread.join(timeout=5)
                server_stopped = True
                ui.click('ocr-recognize')
                ui.wait('ocr-status', lambda value: value and '无法连接本机识别服务' in value['text'])
                assert ui.state('ocr-fill')['disabled']
                assert ui.state('ocr-value')['value'] == ''
                assert page.locator('#official-input').input_value() == ''
                page.screenshot(path=str(evidence/'service-unavailable-manual-safe.png'))
                passed('unavailable local service leaves the official field unchanged and manual flow usable')

                actions = page.evaluate('window.__fixture')
                network = worker.evaluate('globalThis.__qa')
                assert actions['submitted'] == actions['expiryConfirms'] == actions['fetch'] == actions['xhr'] == actions['scriptedClicks'] == actions['open'] == 0
                assert network['entry'] == network['blockedHTTP'] == 0
                assert not blocked_requests, blocked_requests
                unexpected_errors = [message for message in errors if 'ERR_CONNECTION_REFUSED' not in message]
                assert not unexpected_errors, unexpected_errors
                assert not warnings, warnings
                assert (extension/'manifest.json').read_text(encoding='utf-8') == production_manifest
                report = {'browser': context.browser.version, 'passed': len(checks), 'checks': checks, 'fixtureLoads': fixture_loads,
                    'localRequests': local_requests, 'fakeEngineCalls': engine.calls, 'background': network, 'confirmedFillActions': fill_actions, 'beforeReloadActions': before_reload_actions, 'finalPageActions': actions,
                    'externalNetwork': 0, 'unexpectedConsoleErrors': unexpected_errors, 'expectedServiceUnavailableConsoleErrors': [message for message in errors if 'ERR_CONNECTION_REFUSED' in message],
                    'warnings': warnings, 'productionManifestUnchanged': True, 'permission': 'Simulated only in an isolated manifest copy; native optional permission prompt not tested.',
                    'limitations': ['Fake recognizer always returns ABCDEF; no live OCR accuracy measured.', 'Static synthetic DOM only; no real CAPTCHA or ticket API.', 'Closed shadow inspected read-only by CDP; actual user clicks and keyboard events remained trusted.']}
                (evidence/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps(report, ensure_ascii=False))
                context.close()
    finally:
        if not server_stopped:
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=5)


if __name__ == '__main__':
    main()
