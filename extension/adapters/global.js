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

  function inspect(doc) {
    const url = supportedURL(doc && doc.location && doc.location.href);
    if (!url) return { kind: 'unknown', verified: false, code: 'UNSUPPORTED_GLOBAL_URL', reason: '当前页面不是已支持的 Interpark 网页域名。' };
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

  function step(doc) {
    const state = inspect(doc);
    return { status: 'manual', code: state.code, reason: state.reason };
  }

  const helper = root.NolHelper = root.NolHelper || {};
  helper.adapters = helper.adapters || {};
  helper.adapters.global = Object.freeze({ id: 'global', matches: (url) => !!supportedURL(url), inspect, enter, step });
}(globalThis));
