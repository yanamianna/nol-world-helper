(function (root) {
  'use strict';

  const snapshots = new WeakMap();
  const layerSelector = 'div.ModalCaptchaText_layerWrap__jn1bV';
  const inputSelector = 'input[placeholder="請輸入畫面的文字 (不區分大小寫)"]';

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function visible(node, doc) {
    if (!node || node.isConnected === false || typeof node.getClientRects !== 'function' || node.getClientRects().length === 0) return false;
    if (node.ownerDocument && node.ownerDocument !== doc) return false;
    for (let current = node; current; current = current.parentElement) {
      if (current.hidden === true) return false;
      const style = doc.defaultView && typeof doc.defaultView.getComputedStyle === 'function' ? doc.defaultView.getComputedStyle(current) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0')) return false;
    }
    return true;
  }

  function uniqueVisible(container, selector, doc) {
    const nodes = container.querySelectorAll(selector);
    return nodes.length === 1 && visible(nodes[0], doc) ? nodes[0] : null;
  }

  function current(doc, ctx) {
    const adapter = root.NolHelper && root.NolHelper.adapters && root.NolHelper.adapters.global;
    const state = adapter && typeof adapter.inspect === 'function' ? adapter.inspect(doc, ctx) : null;
    if (!state || state.kind !== 'captcha' || state.verified !== true || state.code !== 'SEAT_CAPTCHA_REQUIRED') fail('CAPTCHA_PAGE_UNVERIFIED', '当前页面不是已验证且待本人完成的验证码页面。');
    if (!doc || typeof doc.querySelectorAll !== 'function') fail('CAPTCHA_DOM_UNVERIFIED', '验证码页面结构无法确认。');
    const layers = [...doc.querySelectorAll(layerSelector)].filter(node => visible(node, doc));
    if (layers.length !== 1) fail('CAPTCHA_DOM_UNVERIFIED', '当前可见验证码层不唯一或已关闭。');
    const layer = layers[0];
    // Official component 7239-7759d924aaf45a70.js renders src:c.image,
    // where c.image is response.Img. Never call its image/audio/verify APIs.
    const image = uniqueVisible(layer, 'img[alt="Captcha Image"]', doc);
    const input = uniqueVisible(layer, inputSelector, doc);
    if (!image || !input || typeof image.getAttribute !== 'function') fail('CAPTCHA_DOM_UNVERIFIED', '当前验证码图片或输入控件无法唯一确认。');
    const src = image.getAttribute('src');
    const data = typeof src === 'string' ? /^data:(image\/(?:png|jpeg|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(src) : null;
    if (!data || !data[2] || (typeof image.currentSrc === 'string' && image.currentSrc && image.currentSrc !== src)) fail('CAPTCHA_IMAGE_UNSUPPORTED', '仅支持页面当前已显示的 PNG、JPEG 或 WebP base64 图片；请人工处理其他图片来源。');
    if (image.complete !== true || !(image.naturalWidth > 0) || !(image.naturalHeight > 0)) fail('CAPTCHA_IMAGE_NOT_READY', '验证码图片尚未完成显示，请稍后重新检查。');
    const task = ctx && ctx.task;
    const taskKey = JSON.stringify([task && task.goodsCode, task && task.placeCode, task && task.productName]);
    return {doc,layer,image,input,src,mimeType:data[1],taskKey};
  }

  function capture(doc, ctx) {
    const captured = current(doc, ctx);
    // The public payload and private DOM references remain in this page's memory.
    // Do not put snapshots, image data or candidate text in extension storage/logs.
    const snapshot = Object.freeze({imageDataUrl:captured.src,mimeType:captured.mimeType});
    snapshots.set(snapshot, captured);
    return snapshot;
  }

  function isCurrent(snapshot, doc, ctx) {
    const captured = snapshot && typeof snapshot === 'object' ? snapshots.get(snapshot) : null;
    if (!captured || captured.doc !== doc) return false;
    try {
      const latest = current(doc, ctx);
      return latest.layer === captured.layer && latest.image === captured.image && latest.input === captured.input && latest.src === captured.src && latest.taskKey === captured.taskKey;
    } catch (_) {
      return false;
    }
  }

  function normalizeCandidate(value) {
    if (typeof value !== 'string') return null;
    const candidate = value.trim();
    return /^[A-Za-z]{6}$/.test(candidate) ? candidate.toUpperCase() : null;
  }

  function getCurrentInput(snapshot, doc, ctx) {
    return isCurrent(snapshot, doc, ctx) ? snapshots.get(snapshot).input : null;
  }

  const helper = root.NolHelper = root.NolHelper || {};
  helper.captcha = Object.freeze({capture,isCurrent,normalizeCandidate,getCurrentInput});
}(globalThis));
