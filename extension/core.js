(function (root) {
  'use strict';
  const H = root.NolHelper = root.NolHelper || {};
  const fail = message => { throw new Error(message); };
  const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);
  const identifier = value => /^[a-zA-Z0-9_-]{1,80}$/.test(String(value || ''));
  const makeId = () => root.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function parseProductUrl(input) {
    let url;
    try { url = new URL(input); } catch { fail('请输入完整的 NOL 商品链接'); }
    if (url.protocol !== 'https:' || url.hostname !== 'world.nol.com' || url.port || url.username || url.password) fail('只接受 https://world.nol.com 商品链接');
    const match = url.pathname.match(/^\/(zh-CN|zh-TW|en|ja|ko)\/ticket\/places\/(\d{1,20})\/products\/(\d{1,20})\/?$/);
    if (!match) fail('链接应包含 /ticket/places/场馆编号/products/商品编号');
    return {url: `https://world.nol.com${url.pathname.replace(/\/$/, '')}`, placeCode: match[2], goodsCode: match[3]};
  }
  function normalizeProfile(input) {
    const p = {id: identifier(input?.id) ? input.id : makeId()};
    for (const key of ['label', 'lastName', 'firstName', 'email', 'phone', 'countryCode']) p[key] = text(input?.[key], key === 'email' ? 254 : 100);
    if (!p.label || !p.lastName || !p.firstName) fail('请填写联系人名称、姓和名');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) fail('请填写有效邮箱');
    p.phone = p.phone.replace(/[\s-]/g, '');
    if (!/^\d{4,20}$/.test(p.phone) || !/^\+\d{1,4}$/.test(p.countryCode)) fail('请填写国家区号（例如 +86）和电话号码（不含区号）');
    return p;
  }
  function selectOfficialOpening(product, stage, preSaleSeq = '') {
    const validWindow = (openAt, endAt) => typeof openAt === 'string' && typeof endAt === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(openAt) && /(Z|[+-]\d{2}:\d{2})$/.test(endAt) && Number.isFinite(Date.parse(openAt)) && Number.isFinite(Date.parse(endAt)) && Date.parse(endAt) > Date.parse(openAt);
    if (stage === 'general') {
      const openAt = product?.opening?.general, endAt = product?.opening?.generalEnd;
      if (!validWindow(openAt, endAt)) fail('官网未公布有效的普通开售时间窗口，请稍后重新读取');
      return {openAt, endAt, preSaleSeq:''};
    }
    if (stage !== 'presale') fail('请选择普通开售或会员预售');
    const choices = (product?.presaleChoices || []).filter(x => x && String(x.seq || '') && validWindow(x.openAt, x.endAt));
    if (!choices.length) fail('官网未公布有效的预售时间窗口，请稍后重新读取');
    const selected = preSaleSeq ? choices.find(x => String(x.seq) === String(preSaleSeq)) : choices.length === 1 ? choices[0] : null;
    if (!selected) fail(preSaleSeq ? '所选预售窗口已变更，请重新读取并选择' : '官网有多个预售窗口，请选择对应的预售类型');
    return {openAt:selected.openAt, endAt:selected.endAt, preSaleSeq:String(selected.seq)};
  }
  function validateTask(input, profiles = [], now = Date.now(), allowImmediate = false) {
    const parsed = parseProductUrl(input?.productUrl);
    if (input.goodsCode && input.goodsCode !== parsed.goodsCode || input.placeCode && input.placeCode !== parsed.placeCode) fail('商品编号与链接不一致');
    if (input.openAtSource === 'manual') fail('已取消手动开售时间，请重新读取官网时间');
    const task = {id: identifier(input.id) ? input.id : makeId(), name: text(input.name), productUrl: parsed.url, goodsCode: parsed.goodsCode, placeCode: parsed.placeCode, productName: text(input.productName), kind: input.kind, stage: input.stage, openAt: input.openAt, openAtSource:'official', officialEndAt:input.officialEndAt, officialCheckedAt:Number(input.officialCheckedAt) || 0, preSaleSeq:input.stage === 'presale' ? text(input.preSaleSeq,40) : '', quantity: Number(input.quantity), maxTotal: null, currency: input.currency || 'KRW', profileId: input.profileId};
    if (!task.name || !['package', 'ticket'].includes(task.kind) || !['general', 'presale'].includes(task.stage)) fail('请填写任务名称、商品类型和开售阶段');
    const stamp = Date.parse(task.openAt);
    if (!Number.isFinite(stamp) || !/(Z|[+-]\d{2}:\d{2})$/.test(task.openAt)) fail('开票时间必须包含时区');
    if (!allowImmediate && stamp <= now) fail('开票时间已过，请使用“立即开始”');
    task.openAt = new Date(stamp).toISOString();
    const endStamp = Date.parse(task.officialEndAt);
    if (!Number.isFinite(endStamp) || !/(Z|[+-]\d{2}:\d{2})$/.test(task.officialEndAt) || endStamp <= stamp) fail('官网开售结束时间缺失或无效，请重新读取');
    task.officialEndAt = new Date(endStamp).toISOString();
    if (!Number.isSafeInteger(task.quantity) || task.quantity < 1 || task.quantity > 20) fail('数量应为 1–20 的整数，并受网站实际限购限制');
    if (task.currency !== 'KRW') fail('仅支持韩元（KRW）订单');
    if (!profiles.some(p => p.id === task.profileId)) fail('请选择已保存的联系人');
    if (!Array.isArray(input.alternatives) || input.alternatives.length < 1 || input.alternatives.length > 20) fail('请设置 1–20 个购票选择，并排好购票优先顺序');
    task.alternatives = input.alternatives.map(a => {
      const alt = {date: text(a.date, 10), time: text(a.time, 5), packageLabel: text(a.packageLabel), seatGrade: text(a.seatGrade, 40), priceGrade: text(a.priceGrade, 40), people: task.kind === 'package' ? Number(a.people) : Number(a.people ?? 1), zones: (Array.isArray(a.zones) ? a.zones : []).map(z => text(z)).filter(Boolean)};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(alt.date) || new Date(`${alt.date}T00:00:00Z`).toISOString().slice(0,10) !== alt.date) fail('请选择有效的演出日期');
      if (alt.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(alt.time)) fail('场次时间应为韩国时间 HH:mm');
      if (task.kind === 'package' && !(alt.packageLabel || alt.seatGrade && alt.priceGrade)) fail('套餐购票选择需要明确酒店房型名称或套餐档位编号');
      if (!Number.isSafeInteger(alt.people) || alt.people < 1 || alt.people > 20) fail('请填写每份套餐包含的人数');
      return alt;
    });
    return task;
  }
  function classifyTrigger({now, openAt, lastTick, visible, entryClaimed}) {
    if (entryClaimed) return 'claimed';
    const target = typeof openAt === 'number' ? openAt : Date.parse(openAt);
    if (!Number.isFinite(target) || !Number.isFinite(now)) return 'missed';
    if (!visible) return 'hidden';
    if (now < target) return 'wait';
    if (now - target > 5000 || Number.isFinite(lastTick) && now - lastTick > 2500) return 'missed';
    return 'fire';
  }
  function matchesAlternative(task, a, actual) {
    if (actual.date !== a.date || a.time && actual.time !== a.time) return false;
    if (task.kind === 'package') {
      if (a.seatGrade && a.priceGrade) return actual.seatGrade === a.seatGrade && actual.priceGrade === a.priceGrade && actual.people === a.people;
      return actual.packageLabel === a.packageLabel && actual.people === a.people;
    }
    return !a.zones.length || a.zones.includes(actual.zone);
  }
  function checkOrder(task, actual) {
    const bad = reason => ({ok: false, reason});
    if (!actual || actual.goodsCode !== task.goodsCode || actual.placeCode !== task.placeCode) return bad('商品或场馆不匹配');
    if (!task.alternatives.some(a => matchesAlternative(task, a, actual))) return bad('场次、酒店人数或座区不符合购票选择');
    if (actual.quantity !== task.quantity) return bad('票数或套餐份数不匹配');
    if (actual.currency !== task.currency) return bad('币种不匹配');
    if (actual.feesKnown !== true || !Number.isSafeInteger(actual.total) || actual.total <= 0) return bad('含必要费用的总金额尚未确认');
    return {ok: true, reason: ''};
  }
  function pickAlternative(task, available) {
    for (const a of task.alternatives) {
      const items = (available || []).filter(item => item.available === true && matchesAlternative(task, a, item) && checkOrder({...task, alternatives:[a]}, item).ok);
      if (task.kind === 'ticket') items.sort((x,y) => (a.zones.length ? a.zones.indexOf(x.zone) - a.zones.indexOf(y.zone) : 0) || x.total - y.total);
      if (items.length) return items[0];
    }
    return null;
  }
  function formatTimes(input) {
    const stamp = new Date(input);
    if (!Number.isFinite(stamp.getTime())) return {beijing:'—', korea:'—'};
    const fmt = timeZone => new Intl.DateTimeFormat('zh-CN', {timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(stamp);
    return {beijing:fmt('Asia/Shanghai'),korea:fmt('Asia/Seoul')};
  }
  function redactedRun(run) {
    if (!run) return null;
    const safe = {};
    for (const key of ['id','taskId','status','step','reason','openAt','entryClaimed','entryAttempted','entrySubmitted','apiDispatched','triggerAt','latencyMs','updatedAt']) safe[key] = run[key];
    safe.events = (run.events || []).map(e=>({at:e.at,step:e.step,reason:e.reason}));
    return safe;
  }
  Object.assign(H, {parseProductUrl, normalizeProfile, selectOfficialOpening, validateTask, classifyTrigger, checkOrder, pickAlternative, formatTimes, redactedRun, makeId});
})(globalThis);
