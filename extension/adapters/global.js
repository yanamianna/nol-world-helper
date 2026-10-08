(function (root) {
  'use strict';

  function supportedURL(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.port && !url.username && !url.password && (url.hostname === 'tickets.interpark.com' || url.hostname === 'ticket.globalinterpark.com') ? url : null;
    } catch (_) {
      return null;
    }
  }

  function normalizedName(value) {
    return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase() : '';
  }

  function one(node, selector) {
    const nodes = node && typeof node.querySelectorAll === 'function' ? node.querySelectorAll(selector) : [];
    return nodes.length === 1 ? nodes[0] : null;
  }

  function waitingCount(node) {
    const raw = typeof node?.textContent === 'string' ? node.textContent.normalize('NFKC').trim() : '';
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(raw)) return null;
    const value = Number(raw.replace(/,/g, ''));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function inspectWaiting(doc, ctx) {
    const unknown = (code, reason) => ({kind:'unknown',verified:false,route:'waiting',code,reason});
    // Exact selectors and Traditional Chinese labels observed on the live desktop
    // /waiting page on 2026-10-08. Changed hashes/markup/locales require review.
    const title = one(doc, 'div.Wait_title__HYBF4');
    const goods = one(title, ':scope > div.Wait_goodsName__Sjp96');
    const expectedName = ctx && ctx.task && ctx.task.productName;
    if (!normalizedName(expectedName)) return unknown('WAITING_TASK_UNKNOWN', '任务缺少官网商品名称，无法确认当前队列，请人工检查。');
    if (!goods || !normalizedName(goods.textContent)) return unknown('WAITING_DOM_UNVERIFIED', '排队页商品信息结构无法识别，请人工检查。');
    if (normalizedName(goods.textContent) !== normalizedName(expectedName)) return unknown('WAITING_PRODUCT_MISMATCH', '当前队列商品与任务不一致，请人工检查。');

    const heading = one(title, ':scope > h2');
    const box = one(doc, 'div.StatusBox_wrap__r_RyI.StatusBox_isDesktop__MyXzq');
    const main = one(box, 'div.StatusBox_mainText__9gJXJ');
    const rankLabel = one(main, ':scope > h3');
    const observedHeadings = ['等候人數過多待機中 請稍候片刻', '您的轮到即将到来，请准备好预订'].map(normalizedName);
    if (!heading || !observedHeadings.includes(normalizedName(heading.textContent)) || !rankLabel || normalizedName(rankLabel.textContent) !== normalizedName('我的等候順位')) return unknown('WAITING_DOM_UNVERIFIED', '排队页状态结构无法识别，请人工检查。');

    const rows = box.querySelectorAll('div.StatusBox_sub__T7h1k > div.StatusBox_row__rN2QG');
    const totals = [];
    for (const row of rows) {
      const left = one(row, ':scope > div.StatusBox_columnLeft__PZwMU');
      const label = one(left, ':scope > h4');
      if (label && normalizedName(label.textContent) === normalizedName('現在等候人數')) totals.push(one(row, ':scope > div.StatusBox_columnRight__1bbL6'));
      // The other observed row is 訂購率; its percentage is never read as stock.
    }
    const position = waitingCount(one(main, ':scope > strong'));
    const totalWaiting = totals.length === 1 ? waitingCount(totals[0]) : null;
    if (position === null || totalWaiting === null || position > totalWaiting) return unknown('WAITING_COUNT_UNKNOWN', '排队人数尚未有效显示，请人工检查，保持页面原状。');
    const productName = expectedName.trim();
    return {
      kind:'waiting',verified:true,route:'waiting',code:'WAITING_QUEUE_VERIFIED',
      productName,position,totalWaiting,
      reason:`官方排队中：${productName}。当前顺位 ${position.toLocaleString('zh-CN')}，当前等待人数 ${totalWaiting.toLocaleString('zh-CN')}。请勿刷新或重新进入，等待网站自动跳转。`
    };
  }

  function visible(node, doc) {
    if (!node || node.hidden === true) return false;
    if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false;
    const view = doc && doc.defaultView;
    for (let current = node; current; current = current.parentElement) {
      if (current.hidden === true) return false;
      if (view && typeof view.getComputedStyle === 'function') {
        const style = view.getComputedStyle(current);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0')) return false;
      }
    }
    return true;
  }

  function inspectSeat(doc, ctx) {
    const unknown = (code, reason) => ({kind:'unknown',verified:false,route:'onestop-seat',code,reason});
    // Only this actual desktop seat-page structure and map were observed.
    // Recognizing the page never enables CAPTCHA, seat or lock operations.
    const observedName = 'JEONGHAN X JOSHUA JOURNEY INTO ［DREAMING］ - INCHEON';
    const observedSchedule = '2026.10.30(周五) 7:00 PM';
    const expectedName = ctx && ctx.task && ctx.task.productName;
    if (!normalizedName(expectedName)) return unknown('SEAT_TASK_UNKNOWN', '任务缺少完整官网商品名称，无法确认选座页，请人工检查。');
    if (String(ctx?.task?.goodsCode || '') !== '26013793' || String(ctx?.task?.placeCode || '') !== '26001167') return unknown('SEAT_TASK_MISMATCH', '当前任务不是已验证的商品与场馆，选座页请人工检查。');
    const title = one(doc, 'h3.SubHeader_headerTitle___LjIv');
    if (!title || !visible(title, doc) || !normalizedName(title.textContent)) return unknown('SEAT_DOM_UNVERIFIED', '选座页商品标题结构无法确认，请人工检查。');
    if (normalizedName(title.textContent) !== normalizedName(expectedName) || normalizedName(title.textContent) !== normalizedName(observedName)) return unknown('SEAT_PRODUCT_MISMATCH', '当前选座页商品与任务或已观察的商品不一致，请人工检查。');
    const schedule = one(doc, 'span.SubHeader_scheduleDate__UaD4B');
    if (!schedule || !visible(schedule, doc) || schedule.textContent.trim() !== observedSchedule || doc.querySelectorAll('iframe, frame').length) return unknown('SEAT_DOM_UNVERIFIED', '选座页场次或页面结构尚未验证，请人工检查。');

    // Expiry can unmount the map while retaining the seat header and CAPTCHA.
    // Inspect this official dialog first; never dismiss it or restart entry.
    const dialogs = [...doc.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(dialog => visible(dialog, doc));
    if (dialogs.length) {
      const dialog = dialogs[0];
      const title = one(dialog, ':scope > div.nds-e-dialog__title');
      const description = one(dialog, ':scope > div.nds-e-dialog__description');
      const confirm = [...dialog.querySelectorAll('button')].filter(button => visible(button, doc) && button.textContent.trim() === '确定');
      if (dialogs.length !== 1 || one(doc, 'div.nds-e-dialog__container[role="dialog"][aria-modal="true"]') !== dialog || !title || !visible(title, doc) || title.textContent.trim() !== '10分钟的座位选择时间已超过' || !description || !visible(description, doc) || description.textContent.trim() !== '请重新开始预订' || confirm.length !== 1) return unknown('SEAT_MODAL_UNVERIFIED', '选座页出现尚未确认的弹窗，请人工检查官网提示。');
      return {kind:'expired',verified:true,route:'onestop-seat',code:'SEAT_SESSION_EXPIRED',productName:expectedName.trim(),scheduleText:observedSchedule,reason:`选座会话已过期：${expectedName.trim()}，场次 ${observedSchedule}。官网提示已超过10分钟选座时间，请人工检查官网页面；扩展不会处理验证码、关闭提示或自动重新入场。`};
    }
    const image = one(doc, 'div.SeatMap_blockImg__QQUF7 img[alt="blockImg"]');
    const src = image && typeof image.getAttribute === 'function' ? image.getAttribute('src') : '';
    if (!image || !visible(image, doc) || image.getAttribute('alt') !== 'blockImg' || typeof src !== 'string' || !/^(?:https:)?\/\/ent-ticketimage\.interparkcdn\.net\/svg\/26001167\/087dd34c78914d7c972c56fc356b0e3b\.svg$/.test(src)) return unknown('SEAT_MAP_UNVERIFIED', '选座页场馆地图与任务不一致或尚未验证，请人工检查。');

    const layers = [...doc.querySelectorAll('div.ModalCaptchaText_layerWrap__jn1bV')].filter(layer => visible(layer, doc));
    if (layers.length > 1) return unknown('SEAT_DOM_UNVERIFIED', '选座页存在多个可见验证层，请人工检查。');
    if (layers.length === 1) {
      const layer = layers[0];
      const heading = one(layer, ':scope > h2.ModalCaptchaText_title__uRyg7');
      const input = one(layer, 'input[placeholder="請輸入畫面的文字 (不區分大小寫)"]');
      // Official 7239 + 9219 components render content and footer as siblings
      // inside this layout; the completion button is outside layerWrap.
      const layout = typeof layer.closest === 'function' ? layer.closest('div.ModalLayout_innerWrap__c8kxP') : null;
      const content = one(layout, ':scope > div.ModalLayout_content__Zm2NK');
      const footer = one(layout, ':scope > footer.ModalLayout_footer__88ZwY');
      const buttons = footer ? [...footer.querySelectorAll('button')].filter(button => visible(button, doc) && button.textContent.trim() === '完成輸入') : [];
      if (!layout || !visible(layout, doc) || !content || !visible(content, doc) || one(content, ':scope > div.ModalCaptchaText_layerWrap__jn1bV') !== layer || !footer || !visible(footer, doc) || !heading || heading.textContent.trim() !== '請輸入畫面的文字' || !visible(heading, doc) || !visible(input, doc) || buttons.length !== 1) return unknown('SEAT_DOM_UNVERIFIED', '选座页验证控件结构尚未确认，请人工检查。');
      return {kind:'captcha',verified:true,route:'onestop-seat',code:'SEAT_CAPTCHA_REQUIRED',productName:expectedName.trim(),scheduleText:observedSchedule,reason:`已确认选座页：${expectedName.trim()}，场次 ${observedSchedule}。请本人完成画面验证码；扩展不会输入或提交验证码，选座与锁座尚未验证。`};
    }
    return {kind:'seat',verified:true,route:'onestop-seat',code:'SEAT_PAGE_MANUAL',productName:expectedName.trim(),scheduleText:observedSchedule,reason:`已确认选座页：${expectedName.trim()}，场次 ${observedSchedule}。选座与锁座尚未验证，请人工继续；扩展不会选择座位、锁票或创建订单。`};
  }

  function inspect(doc, ctx) {
    const url = supportedURL(doc && doc.location && doc.location.href);
    if (!url) return { kind: 'unknown', verified: false, code: 'UNSUPPORTED_GLOBAL_URL', reason: '当前页面不是已支持的 Interpark 网页域名。' };
    // Inspect pathname only. Queue keys and partner tokens stay in the website.
    if (url.hostname === 'tickets.interpark.com' && url.pathname === '/waiting') return inspectWaiting(doc, ctx);
    if (url.hostname === 'tickets.interpark.com' && url.pathname === '/onestop/seat') return inspectSeat(doc, ctx);
    // Public JS confirms these gate routes, but not the post-login booking DOM.
    // Query strings can contain partner tokens and are deliberately not returned.
    const route = url.hostname === 'tickets.interpark.com' && url.pathname === '/gates/partner' ? 'partner-gate' : url.hostname === 'tickets.interpark.com' && /^\/gates\/(?:[^/]+\/)?global\/\d+\/?$/.test(url.pathname) ? 'global-gate' : 'unverified-global-page';
    return {
      kind: 'unknown',
      verified: false,
      route,
      code: 'GLOBAL_DOM_UNVERIFIED',
      reason: '已进入 Interpark。该实际预约页面的控件尚未验证，自动选场次、套餐、座位和订单填写已停止，请人工接管。'
    };
  }

  function enter() {
    const error = new Error('Interpark 预约 DOM 尚未实测验证，不能自动点击。');
    error.code = 'GLOBAL_DOM_UNVERIFIED';
    throw error;
  }

  function step(doc, ctx) {
    const state = inspect(doc, ctx);
    if (state.kind === 'waiting' && state.verified) return {status:'waiting',verified:true,route:state.route,code:state.code,productName:state.productName,position:state.position,totalWaiting:state.totalWaiting,reason:state.reason};
    return { status: 'manual', code: state.code, reason: state.reason };
  }

  const helper = root.NolHelper = root.NolHelper || {};
  helper.adapters = helper.adapters || {};
  helper.adapters.global = Object.freeze({ id: 'global', matches: (url) => !!supportedURL(url), inspect, enter, step });
}(globalThis));
