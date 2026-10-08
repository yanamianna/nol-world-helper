/* Options UI: only the extension service worker performs website actions. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DEFAULT_PRODUCT = 'https://world.nol.com/zh-CN/ticket/places/26001167/products/26013793';
  const statusLabels = { armed: '等待开售', running: '正在运行', 'waiting-manual': '等待人工接管', paused: '已暂停', missed: '错过触发时间', stopped: '已停止', payment: '已到付款页' };
  let state = { tasks: [], profiles: [], run: null, capabilities: [] };
  let taskId = null;
  let unsupportedTask = false;
  let profileId = null;
  let metadata = null;
  let busySaving = false;
  let refreshPending = null;
  let productReadTimer = null;
  let productReadSequence = 0;
  let openingStatus = 'idle';
  let selectedPreSaleSeq = '';

  async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(result?.error || '扩展服务暂时不可用，请稍后重试。');
    return result.data;
  }
  function notice(text, kind = 'success') {
    const node = $('message');
    node.textContent = text;
    node.className = `notice ${kind}`;
    node.hidden = false;
  }
  function fail(error) { notice(error?.message || String(error), 'error'); }
  function textNode(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function localTime(iso, zone = 'Asia/Shanghai') {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
  }
  function presaleChoices() {
    return (Array.isArray(metadata?.presaleChoices) ? metadata.presaleChoices : []).filter((choice) =>
      String(choice.seq ?? '') && Number.isFinite(Date.parse(choice.openAt)) && Date.parse(choice.endAt) > Date.parse(choice.openAt));
  }
  function openingIso() {
    if (openingStatus !== 'official') return '';
    const choice = $('task-stage').value === 'presale' ? presaleChoices().find((item) => String(item.seq) === selectedPreSaleSeq) : null;
    const value = $('task-stage').value === 'presale' ? choice?.openAt : metadata?.opening?.general;
    const end = $('task-stage').value === 'presale' ? choice?.endAt : metadata?.opening?.generalEnd;
    return Number.isFinite(Date.parse(value)) && Date.parse(end) > Date.parse(value) ? new Date(value).toISOString() : '';
  }
  function applyOfficialOpening() {
    const choices = presaleChoices();
    const select = $('presale-choice');
    select.replaceChildren(new Option('请选择官网公布的预售窗口', ''));
    for (const choice of choices) select.append(new Option(`${choice.label || '会员 / 先行开售'} · 北京 ${localTime(choice.openAt)}`, String(choice.seq)));
    if (!choices.some((choice) => String(choice.seq) === selectedPreSaleSeq)) selectedPreSaleSeq = choices.length === 1 ? String(choices[0].seq) : '';
    select.value = selectedPreSaleSeq;
    const presale = $('task-stage').value === 'presale';
    $('presale-choice-field').hidden = !presale;
    select.required = presale && choices.length > 0;
    select.disabled = !presale || !choices.length;
    const choice = choices.find((item) => String(item.seq) === selectedPreSaleSeq);
    const value = presale ? choice?.openAt : metadata?.opening?.general;
    const end = presale ? choice?.endAt : metadata?.opening?.generalEnd;
    if (!['reading', 'error', 'idle'].includes(openingStatus)) openingStatus = Number.isFinite(Date.parse(value)) && Date.parse(end) > Date.parse(value) ? 'official' : presale && choices.length > 1 ? 'selection-required' : 'unavailable';
    $('open-at').value = openingIso() ? localTime(openingIso()) : '';
    updateStartButtons();
  }
  function money(value) { return Number(value).toLocaleString('zh-CN'); }
  function taskFromFields() {
    if (unsupportedTask) throw new Error('此旧任务不是普通票任务，无法保存或启动。请新建普通票任务。');
    if (!openingIso()) throw new Error(openingStatus === 'selection-required' ? '请先选择与你的购票资格对应的官网预售窗口。' : '没有可用的官网开售时间，暂时无法保存或启动任务。请稍后重新读取。');
    if (!$('task-form').reportValidity()) return null;
    const url = new URL($('product-url').value.trim());
    const path = url.pathname.match(/\/ticket\/places\/(\d+)\/products\/(\d+)(?:\/)?$/);
    if (url.protocol !== 'https:' || url.hostname !== 'world.nol.com' || !path) throw new Error('请填写 world.nol.com 的公演商品详情链接。');
    const alternatives = getAlternatives();
    if (!alternatives.length) throw new Error('请至少添加一个购票选择。');
    const task = {
      id: taskId || crypto.randomUUID(), name: $('task-name').value.trim(), productUrl: url.toString(),
      goodsCode: path[2], placeCode: path[1], productName: metadata?.goodsName || state.tasks.find((item) => item.id === taskId && item.productUrl === url.toString())?.productName || '',
      kind: 'ticket', stage: $('task-stage').value, openAt: openingIso(),
      preSaleSeq: $('task-stage').value === 'presale' ? selectedPreSaleSeq : '', openAtSource: 'official',
      quantity: Number($('quantity').value), maxTotal: null, currency: 'KRW',
      profileId: $('task-profile').value, alternatives
    };
    if (!task.name) throw new Error('任务名称不能为空。');
    if (!Number.isInteger(task.quantity) || task.quantity < 1) throw new Error('购票数量须为正整数。');
    if (!state.profiles.some((profile) => profile.id === task.profileId)) throw new Error('请先保存联系人，再为任务选择联系人。');
    return task;
  }
  function listItem(title, subtitle, selected, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `list-item${selected ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(selected));
    button.append(textNode('strong', title), textNode('span', subtitle));
    button.addEventListener('click', onClick);
    return button;
  }
  function renderLists() {
    const tasks = $('task-list');
    tasks.replaceChildren();
    for (const task of state.tasks) tasks.append(listItem(task.name || '未命名任务', `${task.kind === 'ticket' ? (task.stage === 'presale' ? '先行开售' : '常规开售') : '不支持的旧任务'} · ${localTime(task.openAt) || '未设置时间'}`, task.id === taskId, () => editTask(task)));
    if (!state.tasks.length) tasks.append(textNode('p', '还没有任务。填写右侧表单后保存。', 'empty-state'));
    const profiles = $('profile-list');
    profiles.replaceChildren();
    for (const profile of state.profiles) profiles.append(listItem(profile.label || '未命名联系人', profile.email || '本机联系人', profile.id === profileId, () => editProfile(profile)));
    if (!state.profiles.length) profiles.append(textNode('p', '添加联系人后，可在任务中选择。', 'empty-state'));
    const selection = $('task-profile').value;
    $('task-profile').replaceChildren(new Option('请选择已保存的联系人', ''));
    for (const profile of state.profiles) $('task-profile').append(new Option(profile.label || `${profile.lastName} ${profile.firstName}`, profile.id));
    $('task-profile').value = selection;
  }
  function renderStatus() {
    $('capabilities').replaceChildren();
    for (const capability of state.capabilities || []) {
      const label = typeof capability === 'string' ? capability : capability.label || capability.id || '页面适配';
      const node = textNode('span', `${label}${typeof capability === 'object' ? ` · ${capability.status === 'verified' ? '已核对' : '人工接管'}` : ''}`, 'capability-label');
      if (capability.detail) node.title = capability.detail;
      $('capabilities').append(node);
    }
    const run = state.run;
    $('run-summary').hidden = !run;
    if (run) $('run-summary').textContent = `${statusLabels[run.status] || '任务状态'} · ${run.step || ''}${run.reason ? ` · ${run.reason}` : ''}`;
  }
  function refresh(force = false) {
    if (refreshPending) return force ? refreshPending.then(() => refresh()) : refreshPending;
    refreshPending = request('GET_STATE').then((data) => {
      state = { tasks: [], profiles: [], capabilities: [], ...data };
      renderLists(); renderStatus(); updateStartButtons();
    }).finally(() => { refreshPending = null; });
    return refreshPending;
  }
  function setView(view) {
    const tasks = view === 'tasks';
    $('tasks-view').hidden = !tasks;
    $('profiles-view').hidden = tasks;
    $('tasks-tab').classList.toggle('active', tasks);
    $('profiles-tab').classList.toggle('active', !tasks);
    $('tasks-tab').setAttribute('aria-pressed', String(tasks));
    $('profiles-tab').setAttribute('aria-pressed', String(!tasks));
  }
  function renderProductSummary() {
    const node = $('product-summary');
    node.replaceChildren();
    node.hidden = !metadata;
    if (!metadata) return;
    node.append(textNode('strong', metadata.goodsName || metadata.productName || '已读取商品'));
    node.append(textNode('p', `商品 ${metadata.goodsCode} · 场馆 ${metadata.placeCode}${metadata.placeName ? ` · ${metadata.placeName}` : ''}`));
    if (metadata.playStartDate || metadata.playEndDate) node.append(textNode('p', `演出期间（韩国时间）：${metadata.playStartDate || '—'} 至 ${metadata.playEndDate || '—'}`));
  }
  function editTask(task, { read = true } = {}) {
    resetProductRead();
    taskId = task?.id || null;
    unsupportedTask = Boolean(task && task.kind !== 'ticket');
    $('unsupported-task').hidden = !unsupportedTask;
    metadata = task ? { goodsCode: task.goodsCode, placeCode: task.placeCode, goodsName: task.productName || task.name, prices: [] } : null;
    $('task-form').reset();
    $('task-name').value = task?.name || '';
    $('product-url').value = task?.productUrl || DEFAULT_PRODUCT;
    $('task-stage').value = task?.stage || 'general';
    selectedPreSaleSeq = String(task?.preSaleSeq || '');
    $('open-at').value = '';
    applyOfficialOpening();
    $('quantity').value = task?.quantity || 1;
    $('task-profile').value = task?.profileId || '';
    $('task-editor-title').textContent = task ? '编辑购票任务' : '新建购票任务';
    $('task-saved').textContent = task ? '已保存' : '尚未保存';
    $('delete-task').hidden = !task;
    renderAlternatives(task?.alternatives?.length ? task.alternatives : [{}]);
    renderProductSummary(); renderLists(); updateStartButtons();
    $('task-profile').value = task?.profileId || '';
    if (read && !unsupportedTask) scheduleProductRead(0);
  }
  function makeField(labelText, input, full = false) {
    const label = document.createElement('label');
    label.className = `field${full ? ' full' : ''}`;
    label.append(textNode('span', labelText), input);
    return label;
  }
  function input(type, value = '', className = '') {
    const node = document.createElement('input');
    node.type = type; node.value = value; node.className = className;
    return node;
  }
  function renderAlternatives(alternatives) {
    const container = $('alternatives');
    container.replaceChildren();
    alternatives.forEach((alternative, index) => {
      const card = document.createElement('section');
      card.className = 'alternative-card';
      card.dataset.seatGrade = alternative.seatGrade || '';
      card.dataset.priceGrade = alternative.priceGrade || '';
      const heading = document.createElement('div'); heading.className = 'alternative-heading';
      const choiceName = index === 0 ? '第一选择' : `第 ${index + 1} 选择`;
      heading.append(textNode('strong', choiceName));
      const controls = document.createElement('div'); controls.className = 'alternative-controls';
      [['上移', -1], ['下移', 1], ['删除', 0]].forEach(([label, direction]) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.setAttribute('aria-label', `${label}${choiceName}`);
        button.disabled = direction === -1 && index === 0 || direction === 1 && index === alternatives.length - 1 || direction === 0 && alternatives.length === 1;
        button.addEventListener('click', () => {
          const items = getAlternatives();
          if (direction === 0) items.splice(index, 1);
          else [items[index], items[index + direction]] = [items[index + direction], items[index]];
          renderAlternatives(items); markDirty();
        });
        controls.append(button);
      });
      heading.append(controls); card.append(heading);
      const grid = document.createElement('div'); grid.className = 'form-grid';
      const date = input('date', alternative.date || '', 'alt-date'); date.required = true;
      if (metadata?.playStartDate) date.min = metadata.playStartDate;
      if (metadata?.playEndDate) date.max = metadata.playEndDate;
      const time = input('time', alternative.time || '', 'alt-time');
      grid.append(makeField('演出日期（韩国时间）', date), makeField('演出时间（可留空）', time));
      const gradeSelect = document.createElement('select'); gradeSelect.className = 'alt-grade-select';
      gradeSelect.append(new Option('读取商品后选择档位，也可手动填写', ''));
      (metadata?.prices || []).forEach((price, priceIndex) => {
        const label = price.label || [price.seatGradeName, price.priceGradeName].filter(Boolean).join(' · ');
        const value = price.price ?? price.salesPrice;
        gradeSelect.append(new Option(`${label}${value != null ? ` · ${money(value)} KRW` : ''}`, String(priceIndex)));
        if (String(price.seatGrade) === String(alternative.seatGrade) && String(price.priceGrade) === String(alternative.priceGrade)) gradeSelect.value = String(priceIndex);
      });
      const gradeLabel = input('text', alternative.gradeLabel ?? alternative.packageLabel ?? '', 'alt-grade-label'); gradeLabel.placeholder = '例如：指定席'; gradeLabel.maxLength = 250;
      gradeSelect.addEventListener('change', () => {
        const price = gradeSelect.value === '' ? null : metadata?.prices?.[Number(gradeSelect.value)];
        card.dataset.seatGrade = price?.seatGrade || ''; card.dataset.priceGrade = price?.priceGrade || '';
        if (price) {
          gradeLabel.value = price.label || [price.seatGradeName, price.priceGradeName].filter(Boolean).join(' · ');
        }
        markDirty();
      });
      grid.append(makeField('商品公开票档', gradeSelect, true), makeField('票档名称', gradeLabel, true));
      const zones = document.createElement('textarea'); zones.className = 'alt-zones'; zones.rows = 2; zones.value = (alternative.zones || []).join('，'); zones.placeholder = '按优先顺序，用逗号分隔；无偏好可留空';
      grid.append(makeField('座区优先顺序', zones, true));
      card.append(grid); container.append(card);
    });
    $('add-alternative').disabled = alternatives.length >= 20;
  }
  function getAlternatives() {
    return [...$('alternatives').querySelectorAll('.alternative-card')].map((card) => ({
      date: card.querySelector('.alt-date').value, time: card.querySelector('.alt-time').value,
      gradeLabel: card.querySelector('.alt-grade-label').value.trim(), seatGrade: card.dataset.seatGrade || '', priceGrade: card.dataset.priceGrade || '',
      zones: card.querySelector('.alt-zones').value.split(/[,，\n]+/).map((zone) => zone.trim()).filter(Boolean)
    }));
  }
  function markDirty() { $('task-saved').textContent = '有未保存更改'; updateStartButtons(); }
  function updateStartButtons() {
    let time = NaN;
    try { time = new Date(openingIso()).getTime(); } catch { /* Invalid form values remain editable. */ }
    const past = Number.isFinite(time) && time <= Date.now();
    $('arm-task').hidden = past;
    $('start-now').hidden = !past;
    const available = Number.isFinite(time) && openingStatus === 'official';
    for (const id of ['save-task', 'arm-task', 'start-now']) $(id).disabled = !available || busySaving || unsupportedTask;
    const source = openingStatus === 'reading' ? '正在从官网读取开售时间。' : openingStatus === 'selection-required' ? '官网公布了多个预售窗口，请先选择对应的窗口。' : openingStatus === 'error' ? '读取失败，请重新读取官网信息。' : '官网尚未公布所选阶段的有效开售时间。';
    $('open-at-hint').textContent = available ? `官网时间：北京 ${localTime(new Date(time).toISOString())} / 韩国 ${localTime(new Date(time).toISOString(), 'Asia/Seoul')}。保存和启动时会再次核对。` : `${source}没有官网时间时无法保存或启动。`;
    $('start-hint').textContent = past ? '官网显示已开售。点击「立即开始」请求官方入场接口；网站验证与排队仍须按官方流程继续，选场次、选座和下单由你接管。' : '到官网开售时间后请求官方入场接口。请提前完成登录及身份验证；选场次、选座和下单由你接管。';
  }
  function resetProductRead() {
    clearTimeout(productReadTimer);
    productReadSequence += 1;
    openingStatus = 'idle';
    selectedPreSaleSeq = '';
    $('read-product').disabled = false;
    $('read-product').textContent = '重新读取';
    $('product-read-status').textContent = '粘贴商品链接后，自动读取开售时间和公开票档。';
  }
  function scheduleProductRead(delay = 600) {
    clearTimeout(productReadTimer);
    if (unsupportedTask) return;
    try { NolHelper.parseProductUrl($('product-url').value.trim()); } catch { return; }
    productReadTimer = setTimeout(() => readProduct({ automatic: true }), delay);
  }
  async function readProduct({ automatic = false } = {}) {
    if (unsupportedTask) return fail(new Error('此旧任务不是普通票任务，请新建普通票任务。'));
    clearTimeout(productReadTimer);
    const url = $('product-url').value.trim();
    try { NolHelper.parseProductUrl(url); } catch (error) { if (!automatic) fail(error); return; }
    const sequence = ++productReadSequence;
    openingStatus = 'reading';
    $('open-at').value = '';
    $('product-read-status').textContent = '正在读取官网开售时间和公开票档…';
    const button = $('read-product'); button.disabled = true; button.textContent = '读取中…';
    updateStartButtons();
    try {
      const data = await request('READ_PRODUCT', { url });
      if (sequence !== productReadSequence || $('product-url').value.trim() !== url) return;
      metadata = data?.metadata || data;
      if (!metadata?.goodsCode || !metadata.placeCode) throw new Error('没有读取到完整的商品编号与场馆编号。');
      if (!$('task-name').value.trim()) $('task-name').value = metadata.goodsName || metadata.productName || '公演购票任务';
      openingStatus = 'unavailable';
      applyOfficialOpening();
      const opening = openingIso();
      $('product-read-status').textContent = opening ? '已自动读取官网开售时间和公开票档。切换开售阶段会自动更新时间。' : openingStatus === 'selection-required' ? '已读取商品；请选择对应的官网预售窗口。' : '已读取商品；官网尚未公布所选阶段的有效开售时间。';
      renderProductSummary(); renderAlternatives(getAlternatives()); markDirty();
      if (!automatic) notice(opening ? '已读取商品和官网开售时间。请核对购票选择和联系人。' : openingStatus === 'selection-required' ? '请选择与你的购票资格对应的预售窗口。' : '该阶段没有可用的官网开售时间，暂时无法保存或启动。', opening ? 'success' : 'neutral');
    } catch (error) {
      if (sequence !== productReadSequence) return;
      openingStatus = 'error';
      $('open-at').value = '';
      $('product-read-status').textContent = `自动读取未成功：${error.message || '网站暂时无法读取'}。请点击「重新读取」；读取成功前无法保存或启动。`;
      if (!automatic) fail(error);
    } finally {
      if (sequence === productReadSequence) { button.disabled = false; button.textContent = '重新读取'; updateStartButtons(); }
    }
  }
  async function saveTask(arm = false, immediate = false) {
    if (busySaving) return;
    busySaving = true;
    try {
      const task = taskFromFields(); if (!task) return;
      updateStartButtons();
      const saved = await request('SAVE_TASK', { task });
      taskId = saved.id;
      await refresh(true);
      const currentMetadata = metadata;
      const currentOpeningStatus = openingStatus;
      editTask(saved, { read: false }); metadata = currentMetadata; openingStatus = currentOpeningStatus;
      if (saved.stage === 'general' && metadata?.opening) { metadata.opening.general = saved.openAt; metadata.opening.generalEnd = saved.officialEndAt; }
      if (saved.stage === 'presale') { const choice = metadata?.presaleChoices?.find((item) => String(item.seq) === String(saved.preSaleSeq)); if (choice) { choice.openAt = saved.openAt; choice.endAt = saved.officialEndAt; } }
      applyOfficialOpening(); renderProductSummary(); renderAlternatives(saved.alternatives); updateStartButtons();
      if (arm) { await request('ARM', { taskId: saved.id, ...(immediate ? { immediate: true } : {}) }); await refresh(true); }
      notice(arm ? immediate ? '已请求立即开始。请保持浏览器前台，并留意人工接管提示。' : '已保存并开始值守。请保持浏览器前台。' : '任务已保存。');
    } catch (error) { fail(error); } finally { busySaving = false; updateStartButtons(); }
  }
  function editProfile(profile) {
    profileId = profile?.id || null;
    $('profile-form').reset();
    const fields = { label: 'profile-label', lastName: 'profile-last-name', firstName: 'profile-first-name', email: 'profile-email', phone: 'profile-phone', countryCode: 'profile-country-code' };
    for (const [key, id] of Object.entries(fields)) $(id).value = profile?.[key] || '';
    $('profile-editor-title').textContent = profile ? '编辑联系人' : '添加联系人';
    $('delete-profile').hidden = !profile;
    renderLists();
  }
  async function saveProfile(event) {
    event.preventDefault();
    if (!$('profile-form').reportValidity()) return;
    const profile = { id: profileId || crypto.randomUUID(), label: $('profile-label').value.trim(), lastName: $('profile-last-name').value.trim(), firstName: $('profile-first-name').value.trim(), email: $('profile-email').value.trim(), phone: $('profile-phone').value.trim(), countryCode: $('profile-country-code').value.trim() };
    if (Object.values(profile).some((value) => !value)) return fail(new Error('请完整填写联系人信息。'));
    try { await request('SAVE_PROFILE', { profile }); profileId = profile.id; await refresh(true); editProfile(profile); notice('联系人已保存在本机。'); } catch (error) { fail(error); }
  }
  async function exportDiagnostics() {
    const data = await request('EXPORT_DIAGNOSTICS');
    if (data?.downloaded || data?.exported) return notice('诊断已导出。');
    const payload = data?.diagnostics ?? data?.json ?? data?.text ?? data;
    if (payload == null) return notice('诊断导出请求已提交。');
    const blob = new Blob([typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = href; anchor.download = `nol-helper-diagnostics-${Date.now()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    notice('诊断已导出。');
  }
  $('tasks-tab').addEventListener('click', () => setView('tasks'));
  $('profiles-tab').addEventListener('click', () => setView('profiles'));
  $('new-task').addEventListener('click', () => editTask(null));
  $('new-profile').addEventListener('click', () => editProfile(null));
  $('read-product').addEventListener('click', () => readProduct());
  $('task-form').addEventListener('submit', (event) => { event.preventDefault(); saveTask(); });
  $('task-form').addEventListener('input', markDirty);
  $('task-form').addEventListener('change', markDirty);
  $('product-url').addEventListener('input', () => {
    resetProductRead();
    const alternatives = getAlternatives().map((alternative) => ({ ...alternative, seatGrade: '', priceGrade: '' }));
    metadata = null; renderProductSummary(); renderAlternatives(alternatives);
    $('open-at').value = '';
    updateStartButtons();
    scheduleProductRead();
  });
  $('task-stage').addEventListener('change', () => {
    if (metadata?.opening) applyOfficialOpening();
    else if (openingStatus !== 'reading') scheduleProductRead(0);
    updateStartButtons();
  });
  $('presale-choice').addEventListener('change', () => { selectedPreSaleSeq = $('presale-choice').value; applyOfficialOpening(); markDirty(); });
  $('add-alternative').addEventListener('click', () => { renderAlternatives([...getAlternatives(), {}]); markDirty(); });
  $('arm-task').addEventListener('click', () => saveTask(true));
  $('start-now').addEventListener('click', () => saveTask(true, true));
  $('delete-task').addEventListener('click', async () => { if (!taskId || !confirm('删除这个购票任务？')) return; try { await request('DELETE_TASK', { id: taskId }); await refresh(true); editTask(null); notice('任务已删除。'); } catch (error) { fail(error); } });
  $('profile-form').addEventListener('submit', saveProfile);
  $('delete-profile').addEventListener('click', async () => { if (!profileId || !confirm('删除这个联系人？使用它的任务需要重新选择联系人。')) return; try { await request('DELETE_PROFILE', { id: profileId }); await refresh(true); editProfile(null); notice('联系人已删除。'); } catch (error) { fail(error); } });
  $('delete-all').addEventListener('click', async () => { if (!confirm('删除所有本机任务、联系人与运行记录？此操作无法撤销。')) return; try { await request('DELETE_ALL'); await refresh(true); editTask(null); editProfile(null); notice('全部本机数据已删除。'); } catch (error) { fail(error); } });
  $('export-diagnostics').addEventListener('click', () => exportDiagnostics().catch(fail));
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') refresh(true).catch(fail); });
  setInterval(updateStartButtons, 1000);
  refresh().then(() => { editTask(state.tasks[0] || null); editProfile(state.profiles[0] || null); }).catch(fail);
})();
