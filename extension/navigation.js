(function (root) {
  'use strict';
  const H = root.NolHelper = root.NolHelper || {};
  const hosts = new Set(['world.nol.com', 'tickets.interpark.com', 'ticket.globalinterpark.com']);
  const activeStatuses = new Set(['running', 'waiting-manual']);
  const errorCodes = new Set([
    'ERR_FAILED', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT',
    'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_ABORTED', 'ERR_CONNECTION_FAILED', 'ERR_NAME_NOT_RESOLVED',
    'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_ADDRESS_UNREACHABLE',
    'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
    'ERR_SSL_PROTOCOL_ERROR', 'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_ADMINISTRATOR'
  ]);

  function navigationMatchesTab(details, tab) {
    if (!tab || tab.id !== details?.tabId || typeof details.url !== 'string' || !details.url) return false;
    // A newer pending navigation takes priority over the last committed page.
    const currentUrl = tab.pendingUrl || tab.url;
    return typeof currentUrl === 'string' && currentUrl === details.url;
  }

  // The caller must also match the event URL against the current tab in memory.
  // Only these safe fields may be persisted; details.url can contain entry tokens.
  function navigationFailure(details, run) {
    if (!run || !activeStatuses.has(run.status) || run.entryClaimed !== true ||
        !Number.isInteger(run.tabId) || run.tabId < 0 ||
        details?.tabId !== run.tabId || details.frameId !== 0) return null;
    let url;
    try { url = new URL(details.url); } catch { return null; }
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) return null;

    const rawCode = typeof details.error === 'string' ? details.error.replace(/^net::/, '') : '';
    if (rawCode === 'ERR_ABORTED') return null;
    const errorCode = errorCodes.has(rawCode) ? rawCode : 'NAVIGATION_FAILED';
    const diagnosis = errorCode === 'ERR_CONNECTION_TIMED_OUT' || errorCode === 'ERR_TIMED_OUT' ? '连接超时' : '加载失败';
    return {
      host: url.hostname,
      errorCode,
      reason: `官方购票页 ${url.hostname} ${diagnosis}（${errorCode}），请检查网络并人工接管。扩展不会自动重试入场。`
    };
  }

  H.navigationMatchesTab = navigationMatchesTab;
  H.navigationFailure = navigationFailure;
})(globalThis);
