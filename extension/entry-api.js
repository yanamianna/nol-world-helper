(function (root) {
  'use strict';

  // Both functions are serialized by chrome.scripting.executeScript(world: 'MAIN').
  // They deliberately have no dependency on extension globals or stored credentials.
  async function officialEntry(payload) {
    'use strict';
    const key = '__nolWorldHelperEntryApiV1';
    const result = (code, submitted = false) => ({ submitted, code });
    const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
    const stamp = (value) => typeof value === 'number' ? value : typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
    if (!payload || !/^[A-Za-z0-9_-]{1,80}$/.test(payload.runId || '') || !/^\d{1,20}$/.test(payload.goodsCode || '') || !/^\d{1,20}$/.test(payload.placeCode || '')) return result('ENTRY_INVALID_CONFIG');
    const openAt = stamp(payload.openAt), endAt = stamp(payload.endAt);
    if (!Number.isFinite(openAt) || !Number.isFinite(endAt) || endAt <= openAt) return result('ENTRY_INVALID_CONFIG');

    function checkPage() {
      let url;
      try { url = new URL(window.location.href); } catch (_) { fail('ENTRY_PAGE_MISMATCH'); }
      const route = /^\/(en|zh-CN|zh-TW|ja|ko)\/ticket\/places\/(\d{1,20})\/products\/(\d{1,20})\/?$/.exec(url.pathname);
      if (url.protocol !== 'https:' || url.hostname !== 'world.nol.com' || url.port || url.username || url.password || !route || route[2] !== String(payload.placeCode) || route[3] !== String(payload.goodsCode)) fail('ENTRY_PAGE_MISMATCH');
      if (document.visibilityState !== 'visible') fail('ENTRY_PAGE_NOT_VISIBLE');
      if (Date.now() < openAt) fail('ENTRY_BEFORE_OPEN');
      if (Date.now() >= endAt) fail('ENTRY_SALE_ENDED');
      return route[1];
    }

    const existingRegistry = window[key];
    const existingRun = existingRegistry && existingRegistry.document === document && existingRegistry.runs instanceof Map ? existingRegistry.runs.get(payload.runId) : null;
    if (existingRun) return result(existingRun.postAttempted ? 'ENTRY_ALREADY_ATTEMPTED' : 'ENTRY_ALREADY_STARTED', existingRun.postAttempted);
    let lang;
    try { lang = checkPage(); } catch (error) { return result(error.code); }
    let registry = window[key];
    if (!registry) {
      registry = { document, runs: new Map() };
      Object.defineProperty(window, key, { value: registry, configurable: false, writable: false });
    }
    if (registry.document !== document || !(registry.runs instanceof Map)) return result('ENTRY_CONTEXT_UNAVAILABLE');
    if (Array.from(registry.runs.values()).some((run) => !run.done)) return result('ENTRY_OTHER_RUN_ACTIVE');

    // No token is kept in this registry. An attempted POST is retained until unload.
    const entry = { postAttempted: false, done: false, abort: null, code: 'ENTRY_STARTED' };
    registry.runs.set(payload.runId, entry);
    const controller = new AbortController();
    let abortCode = 'ENTRY_CANCELLED';
    entry.abort = (code = 'ENTRY_CANCELLED') => {
      if (!controller.signal.aborted) { abortCode = code; controller.abort(); }
    };
    const overallTimer = setTimeout(() => entry.abort('ENTRY_TIMEOUT'), 180000);
    const cleanup = [];
    let sdk, widgetId, panel, token = null;
    const assertActive = () => {
      if (controller.signal.aborted) fail(abortCode);
      checkPage();
    };

    // Bound even a stalled response body. No login refresh or submission retry.
    async function request(path, options = {}) {
      assertActive();
      const requestController = new AbortController();
      let timedOut = false;
      const abortRequest = () => requestController.abort();
      controller.signal.addEventListener('abort', abortRequest, { once: true });
      const timer = setTimeout(() => { timedOut = true; requestController.abort(); }, 15000);
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => { const error = new Error('request-aborted'); error.code = controller.signal.aborted ? abortCode : 'ENTRY_REQUEST_TIMEOUT'; reject(error); };
        requestController.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const response = await Promise.race([fetch(new URL(path, 'https://world.nol.com'), { ...options, credentials: 'same-origin', redirect: 'error', signal: requestController.signal }), aborted]);
        let data = null;
        if (response.ok || response.status === 400) data = await Promise.race([response.json(), aborted]);
        return { ok: response.ok, status: response.status, data };
      } catch (_) {
        if (controller.signal.aborted) fail(abortCode);
        fail(timedOut ? 'ENTRY_REQUEST_TIMEOUT' : 'ENTRY_REQUEST_FAILED');
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abortRequest);
        requestController.signal.removeEventListener('abort', onAbort);
      }
    }

    async function loadSDK() {
      return new Promise((resolve, reject) => {
        const existing = Array.from(document.querySelectorAll('script[src]')).find((script) => {
          try { const url = new URL(script.src); return url.origin === 'https://challenges.cloudflare.com' && url.pathname === '/turnstile/v0/api.js'; } catch (_) { return false; }
        });
        const script = existing || (window.turnstile ? null : document.createElement('script'));
        let settled = false, readyStarted = false, pollTimer;
        const finish = (code, api) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(pollTimer);
          script?.removeEventListener('load', onLoad);
          script?.removeEventListener('error', onError);
          controller.signal.removeEventListener('abort', onCancel);
          if (!existing && script) script.remove();
          if (!code && api && typeof api.render === 'function') resolve(api);
          else { const error = new Error(code || 'ENTRY_SDK_UNAVAILABLE'); error.code = code || 'ENTRY_SDK_UNAVAILABLE'; reject(error); }
        };
        const checkSDK = () => {
          if (settled || readyStarted) return;
          clearTimeout(pollTimer);
          if (controller.signal.aborted) { finish(abortCode); return; }
          const api = window.turnstile;
          if (!api || typeof api.render !== 'function') {
            // The website may already have dispatched its script load event.
            // Observe readiness within this attempt; do not reload its script.
            pollTimer = setTimeout(checkSDK, 50);
            return;
          }
          readyStarted = true;
          try {
            if (typeof api.ready === 'function') api.ready(() => finish(null, api));
            else finish(null, api);
          } catch (_) { finish('ENTRY_SDK_UNAVAILABLE'); }
        };
        const onLoad = () => checkSDK();
        const onError = () => finish('ENTRY_SDK_LOAD_FAILED');
        const onCancel = () => finish(abortCode);
        const timer = setTimeout(() => finish(readyStarted ? 'ENTRY_SDK_READY_TIMEOUT' : 'ENTRY_SDK_LOAD_TIMEOUT'), 10000);
        script?.addEventListener('load', onLoad);
        script?.addEventListener('error', onError);
        controller.signal.addEventListener('abort', onCancel, { once: true });
        checkSDK();
        if (!settled && !existing && script) {
          // Official SDK only; do not overwrite NOL's own onload callback.
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
          script.async = true;
          document.head.appendChild(script);
        }
      });
    }

    async function verify() {
      sdk = await loadSDK();
      assertActive();
      panel = document.createElement('section');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'NOL 官方入场验证');
      panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;box-sizing:border-box;width:min(380px,calc(100vw - 40px));padding:20px;border:1px solid #c7d6ee;border-radius:16px;background:#fff;color:#172b4d;box-shadow:0 12px 40px #152b4d33;font:14px/1.6 system-ui,sans-serif';
      const title = document.createElement('strong');
      title.textContent = 'NOL 官方入场验证';
      const description = document.createElement('p');
      description.textContent = '请在下方完成网站验证。通过后将提交一次入场请求，并进入官方购票流程。';
      const container = document.createElement('div');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '取消入场';
      cancel.addEventListener('click', () => entry.abort());
      panel.append(title, description, container, cancel);
      document.body.appendChild(panel);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value, code) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', onCancel);
          if (code) { const error = new Error(code); error.code = code; reject(error); }
          else resolve(value);
        };
        const onCancel = () => finish(null, abortCode);
        controller.signal.addEventListener('abort', onCancel, { once: true });
        cleanup.push(() => controller.signal.removeEventListener('abort', onCancel));
        try {
          // Site key/options observed in NOL's public JS on 2026-10-07.
          // response-field:false is Cloudflare's documented option: keep tokens
          // in the callback closure instead of writing a hidden DOM form field.
          widgetId = sdk.render(container, {
            sitekey: '0x4AAAAAACXBa0-HrwgZXh6u', theme: 'auto', size: 'flexible', appearance: 'interaction-only', 'response-field': false,
            callback: (value) => typeof value === 'string' && value.length > 0 ? finish(value) : finish(null, 'ENTRY_VERIFICATION_FAILED'),
            'error-callback': () => { finish(null, 'ENTRY_VERIFICATION_FAILED'); return true; },
            'expired-callback': () => finish(null, 'ENTRY_VERIFICATION_EXPIRED'),
            'timeout-callback': () => finish(null, 'ENTRY_VERIFICATION_EXPIRED'),
            'unsupported-callback': () => finish(null, 'ENTRY_VERIFICATION_FAILED')
          });
        } catch (_) { finish(null, 'ENTRY_WIDGET_INIT_FAILED'); }
      });
    }

    try {
      const headers = { 'X-Service-Origin': 'global', 'X-Triple-User-Lang': lang };
      const query = new URLSearchParams({ goods_code: String(payload.goodsCode), place_code: String(payload.placeCode) });
      const status = await request(`/api/users/enter?${query}`, { headers });
      if (status.status === 401) return result('ENTRY_LOGIN_REQUIRED');
      if (status.status === 404 || status.status === 400 && status.data && status.data.errorCode === 'ENTER_EMAIL_NOT_FOUND') return result('ENTRY_EMAIL_REQUIRED');
      if (!status.ok || !status.data || typeof status.data.enterHasEmail !== 'boolean') return result('ENTRY_STATUS_UNKNOWN');
      if (!status.data.enterHasEmail) return result('ENTRY_EMAIL_REQUIRED');
      const user = await request('/api/users', { headers });
      if (user.status === 401) return result('ENTRY_LOGIN_REQUIRED');
      if (!user.ok || !user.data || typeof user.data !== 'object') return result('ENTRY_STATUS_UNKNOWN');
      // The official gate supplies uid only when the normal user response has it.
      const uid = typeof user.data.uid === 'string' || typeof user.data.uid === 'number' ? String(user.data.uid) : '';
      token = await verify();
      assertActive();
      entry.postAttempted = true;
      let response;
      try {
        response = await request('/api/users/enter/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goodsCode: String(payload.goodsCode), placeCode: String(payload.placeCode), turnstileToken: token }) });
      } catch (_) {
        return result(controller.signal.aborted ? abortCode : 'ENTRY_RESPONSE_UNKNOWN', true);
      } finally { token = null; }
      if (!response.ok || !response.data || typeof response.data.access_token !== 'string' || !response.data.access_token || typeof response.data.refresh_token !== 'string' || !response.data.refresh_token) return result('ENTRY_RESPONSE_UNKNOWN', true);
      assertActive();
      const gate = new URL('https://tickets.interpark.com/gates/partner');
      gate.searchParams.set('gc', String(payload.goodsCode));
      gate.searchParams.set('pc', String(payload.placeCode));
      gate.searchParams.set('bc', '10965');
      gate.searchParams.set('cc', 'gates_global');
      gate.searchParams.set('lg', lang === 'zh-CN' ? 'zh' : lang);
      gate.searchParams.set('partner_token', response.data.access_token);
      gate.searchParams.set('partner_token_r', response.data.refresh_token);
      if (uid) gate.searchParams.set('user_id', uid);
      // Sensitive gate URL remains in the page world and follows the official path.
      window.location.href = gate.toString();
      response = null;
      entry.code = 'ENTRY_REDIRECTING';
      return result('ENTRY_REDIRECTING', true);
    } catch (error) {
      return result(controller.signal.aborted ? abortCode : typeof error.code === 'string' ? error.code : 'ENTRY_STATUS_UNKNOWN', entry.postAttempted);
    } finally {
      token = null;
      clearTimeout(overallTimer);
      for (const dispose of cleanup) { try { dispose(); } catch (_) {} }
      if (sdk && widgetId !== undefined) { try { sdk.remove(widgetId); } catch (_) {} }
      if (panel) panel.remove();
      entry.done = true;
      entry.abort = null;
    }
  }

  function cancelOfficialEntry(runId) {
    'use strict';
    const registry = window.__nolWorldHelperEntryApiV1;
    const entry = registry && registry.document === document && registry.runs instanceof Map ? registry.runs.get(runId) : null;
    if (!entry || entry.done || typeof entry.abort !== 'function') return { cancelled: false, submitted: !!(entry && entry.postAttempted), code: 'ENTRY_NOT_RUNNING' };
    entry.abort('ENTRY_CANCELLED');
    return { cancelled: true, submitted: entry.postAttempted, code: 'ENTRY_CANCELLED' };
  }

  const H = root.NolHelper = root.NolHelper || {};
  Object.assign(H, { officialEntry, cancelOfficialEntry });
}(globalThis));
