(function (root) {
  'use strict';

  // Observed in research/tickets/product/page.html (2026-10-07).
  // The disabled:cursor_not-allowed utility is present even on enabled buttons.
  const ENTRY_SELECTOR = '.grid-area_purchase-button > button.nds-e-rectangle-button--variant_filled_primary';
  const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';
  const attemptedRuns = new Set();

  function productIdentity(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'world.nol.com' || url.port || url.username || url.password) return null;
      const match = /^\/(?:en|zh-CN|zh-TW|ja|ko)\/ticket\/places\/(\d+)\/products\/(\d+)\/?$/.exec(url.pathname);
      if (!match) return null;
      return { goodsCode: match[2], placeCode: match[1] };
    } catch (_) {
      return null;
    }
  }

  // Read a JSON array/object without evaluating JavaScript or Flight references.
  function balancedJSON(text, start) {
    const opening = text[start];
    if (opening !== '[' && opening !== '{') return null;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '[' || character === '{') stack.push(character);
      else if (character === ']' || character === '}') {
        if (stack.pop() !== (character === ']' ? '[' : '{')) return null;
        if (stack.length === 0) {
          try {
            return { value: JSON.parse(text.slice(start, index + 1)), end: index + 1 };
          } catch (_) {
            return null;
          }
        }
      }
    }
    return null;
  }

  function readTicketDetail(html) {
    if (typeof html !== 'string') return null;
    const pieces = [];
    const scripts = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
    let script;
    while ((script = scripts.exec(html))) {
      const calls = /self\.__next_f\.push\(\s*/g;
      let call;
      while ((call = calls.exec(script[1]))) {
        const parsed = balancedJSON(script[1], calls.lastIndex);
        if (!parsed) continue;
        calls.lastIndex = parsed.end;
        if (Array.isArray(parsed.value) && parsed.value[0] === 1 && typeof parsed.value[1] === 'string') pieces.push(parsed.value[1]);
      }
    }
    const flight = pieces.join('');
    const properties = /"ticketDetail"\s*:\s*/g;
    let property;
    while ((property = properties.exec(flight))) {
      const parsed = balancedJSON(flight, properties.lastIndex);
      if (parsed && parsed.value && !Array.isArray(parsed.value) && typeof parsed.value === 'object') return parsed.value;
    }
    return null;
  }

  function metadata(detail, identity) {
    if (!detail || String(detail.goodsCode) !== identity.goodsCode || String(detail.placeCode) !== identity.placeCode) return null;
    const text = (value) => typeof value === 'string' ? value : '';
    return {
      goodsCode: identity.goodsCode,
      placeCode: identity.placeCode,
      goodsName: text(detail.goodsName),
      placeName: text(detail.placeName),
      playStartDate: text(detail.playStartDate),
      playEndDate: text(detail.playEndDate),
      bookingOpenTime: text(detail.bookingOpenTime),
      bookingEndTime: text(detail.bookingEndTime),
      prices: (Array.isArray(detail.price) ? detail.price : []).map((price) => ({
        seatGrade: text(price.seatGrade),
        priceGrade: text(price.priceGrade),
        seatGradeName: text(price.seatGradeName),
        priceGradeName: text(price.priceGradeName),
        salesPrice: typeof price.salesPrice === 'number' && Number.isFinite(price.salesPrice) ? price.salesPrice : null
      })),
      opening: { bookingOpenTime: text(detail.bookingOpenTime), bookingEndTime: text(detail.bookingEndTime) },
      source: 'nol-public-rsc'
    };
  }

  function extractProduct(html, url) {
    const identity = productIdentity(url);
    return identity ? metadata(readTicketDetail(html), identity) : null;
  }

  function visible(element, doc) {
    if (!element || element.isConnected === false || element.hidden) return false;
    if (typeof element.closest === 'function' && element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (typeof element.getClientRects !== 'function' || element.getClientRects().length === 0) return false;
    const view = doc.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.pointerEvents === 'none') return false;
    }
    return true;
  }

  function enabled(button) {
    return !button.disabled && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true' && button.getAttribute('aria-busy') !== 'true' && !(typeof button.matches === 'function' && button.matches(':disabled'));
  }

  function inspect(doc, ctx) {
    const identity = productIdentity(doc && doc.location && doc.location.href);
    if (!identity) return { kind: 'unknown', code: 'UNSUPPORTED_PRODUCT_URL', reason: '当前页面不是已支持的 NOL 公演商品页。' };
    const task = ctx && ctx.task;
    if (task) {
      const requested = productIdentity(task.productUrl);
      if (!requested || requested.goodsCode !== identity.goodsCode || requested.placeCode !== identity.placeCode || String(task.goodsCode) !== identity.goodsCode || String(task.placeCode) !== identity.placeCode) {
        return { kind: 'unknown', code: 'PRODUCT_MISMATCH', reason: '当前商品或场馆与任务配置不一致，已停止。' };
      }
    }
    const detail = readTicketDetail(doc.documentElement ? doc.documentElement.outerHTML : '');
    const product = detail ? metadata(detail, identity) : { goodsCode: identity.goodsCode, placeCode: identity.placeCode, source: 'url' };
    if (detail && !product) return { kind: 'unknown', code: 'PRODUCT_METADATA_MISMATCH', reason: '页面元数据与当前商品地址不一致，已停止。' };
    if (Array.from(doc.querySelectorAll(MODAL_SELECTOR)).some((modal) => visible(modal, doc))) {
      return { kind: 'unknown', code: 'MODAL_REQUIRES_MANUAL', product, reason: '页面有公告或其他对话框，请先手动阅读并处理。' };
    }
    const buttons = Array.from(doc.querySelectorAll(ENTRY_SELECTOR)).filter((button) => visible(button, doc));
    if (buttons.length !== 1) {
      return { kind: 'unknown', code: buttons.length ? 'ENTRY_AMBIGUOUS' : 'ENTRY_NOT_VISIBLE', product, reason: buttons.length ? '发现多个可见预约入口，无法安全确定目标。' : '未找到已验证且可见的预约入口，请检查页面或手动接管。' };
    }
    const entryButton = buttons[0];
    const canEnter = enabled(entryButton);
    return { kind: 'entry', product, entryButton, canEnter, code: canEnter ? 'ENTRY_READY' : 'ENTRY_DISABLED', reason: canEnter ? '普通预约入口已找到；登录和验证由网站正常处理。' : '预约按钮尚不可用，等待网站开放。' };
  }

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function enter(doc, ctx) {
    const task = ctx && ctx.task;
    const run = ctx && ctx.run;
    if (!task || !run || !run.id || run.entryClaimed !== true) fail('ENTRY_NOT_CLAIMED', '本次执行尚未取得已保存的入口执行权。');
    if (run.entryClicked || attemptedRuns.has(run.id)) fail('ENTRY_ALREADY_ATTEMPTED', '本次任务已经尝试预约入口，不能重复点击。');
    const openAt = typeof task.openAt === 'number' ? task.openAt : Date.parse(task.openAt);
    const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
    if (!Number.isFinite(openAt) || !Number.isFinite(now) || now < openAt) fail('BEFORE_OPEN_TIME', '尚未到配置的开售时间。');
    const state = inspect(doc, ctx);
    if (state.kind !== 'entry' || !state.canEnter) fail(state.code, state.reason);
    attemptedRuns.add(run.id);
    // A normal DOM click only. No token requests, queue calls or trusted-event spoofing.
    state.entryButton.click();
    return { clicked: true };
  }

  function step(doc, ctx) {
    const state = inspect(doc, ctx);
    if (state.kind !== 'entry') return { status: 'manual', code: state.code, reason: state.reason };
    if (ctx && ctx.run && ctx.run.entryClicked) return { status: 'waiting', reason: '已尝试普通预约入口，等待网站跳转。登录、邮箱和人机验证需在网站上完成。' };
    return { status: 'waiting', code: state.code, reason: state.reason };
  }

  const helper = root.NolHelper = root.NolHelper || {};
  helper.adapters = helper.adapters || {};
  helper.adapters.nol = Object.freeze({ id: 'nol', matches: (url) => !!productIdentity(url), inspect, enter, step, extractProduct, entrySelector: ENTRY_SELECTOR });
}(globalThis));
