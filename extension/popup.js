(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const labels = { armed: '等待开售', running: '正在运行', 'waiting-manual': '等待人工接管', paused: '已暂停', missed: '错过触发时间', stopped: '已停止', payment: '已到付款页' };
  const finalStatuses = new Set(['stopped', 'payment', 'missed']);
  let state = { tasks: [], run: null };
  let pending = false;
  let actionPending = false;
  async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(result?.error || '扩展服务暂时不可用。');
    return result.data;
  }
  function notice(text, error = false) { $('popup-message').textContent = text; $('popup-message').className = `notice compact${error ? ' error' : ' success'}`; $('popup-message').hidden = false; }
  function fail(error) { notice(error?.message || String(error), true); }
  function formatTime(iso, zone) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  }
  function selectedTask() { return state.tasks.find((task) => task.id === $('popup-task').value); }
  function resumeState(run) {
    if (!run || !['paused', 'waiting-manual'].includes(run.status)) return { available: false, hint: '' };
    if (run.navigationErrorCode) return { available: false, hint: '官网页面连接失败。请检查官网状态，停止后重新启动任务；不会重新提交入场接口。' };
    if (!run.entrySubmitted && (run.entryClaimed || run.apiDispatched || run.entryAttempted)) return { available: false, hint: '入场尚未确认成功。请检查官网状态，停止后重新启动任务；此处不会重试入场。' };
    if (run.entrySubmitted) return { available: true, label: '继续观察', hint: '只继续观察官方购票页面，不会重新验证或再次提交入场接口。' };
    if (!Number.isFinite(Date.parse(run.openAt)) || Date.parse(run.openAt) <= Date.now()) return { available: false, hint: '触发时间已过或无法确认。请先停止任务，再检查官网并重新启动；扩展不会补发入场请求。' };
    return { available: true, label: '继续值守', hint: '继续等待官网开售时间，尚未启动入场。' };
  }
  function renderTasks() {
    const active = state.run && !finalStatuses.has(state.run.status);
    const selected = active ? state.run.taskId : $('popup-task').value || state.tasks[0]?.id || '';
    $('popup-task').replaceChildren();
    if (!state.tasks.length) $('popup-task').append(new Option('暂无任务，请先打开设置', ''));
    for (const task of state.tasks) $('popup-task').append(new Option(task.name || '未命名任务', task.id));
    $('popup-task').value = state.tasks.some((task) => task.id === selected) ? selected : state.tasks[0]?.id || '';
    $('popup-task').disabled = Boolean(state.run && !finalStatuses.has(state.run.status));
  }
  function render() {
    const run = state.run;
    const task = run && !finalStatuses.has(run.status) ? state.tasks.find((item) => item.id === run.taskId) || run.task : selectedTask();
    const active = Boolean(run && !finalStatuses.has(run.status));
    $('run-detail').hidden = !task;
    const officialTime = task?.openAtSource === 'official' && Number.isFinite(Date.parse(task.openAt)) && Date.parse(task.officialEndAt) > Date.parse(task.openAt);
    const opened = officialTime && new Date(task.openAt).getTime() <= Date.now();
    const resume = resumeState(run);
    $('run-status').textContent = run && (active || run.taskId === task?.id) ? labels[run.status] || '任务状态' : '尚未开始';
    $('run-status').className = `badge${run?.status === 'payment' ? ' success' : run?.status === 'waiting-manual' || run?.status === 'missed' ? ' caution' : ''}`;
    $('run-detail').textContent = active || run?.taskId === task?.id ? [run?.step, run?.reason].filter(Boolean).join(' · ') || '等待任务状态更新。' : '保存任务后，在这里开始值守。';
    if (active && resume.hint) $('run-detail').textContent += ` ${resume.hint}`;
    $('popup-arm').hidden = active || Boolean(opened);
    $('popup-immediate').hidden = active || !opened;
    $('popup-arm').disabled = !officialTime || actionPending;
    $('popup-immediate').disabled = !officialTime || actionPending;
    $('popup-pause').hidden = !active || run.status === 'paused' || run.status === 'waiting-manual';
    $('popup-resume').hidden = !active || !resume.available;
    $('popup-resume').textContent = resume.label || '继续';
    $('popup-stop').hidden = !active;
    for (const id of ['popup-pause', 'popup-resume', 'popup-stop']) $(id).disabled = actionPending;
    if (!task) { $('countdown-label').textContent = '距离开售'; $('countdown').textContent = '—'; $('sale-time').textContent = '先在设置中添加商品和联系人。'; return; }
    const diff = new Date(task.openAt).getTime() - Date.now();
    if (!officialTime || !Number.isFinite(diff)) { $('countdown').textContent = '—'; $('sale-time').textContent = '请在设置中重新读取官网开售时间；官网未公布时无法启动。'; return; }
    const seconds = Math.max(0, Math.ceil(diff / 1000));
    const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
    $('countdown-label').textContent = diff > 0 ? '距离开售' : '已开售';
    $('countdown').textContent = diff > 0 ? `${days ? `${days}天 ` : ''}${[hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':')}` : run?.status === 'payment' ? '停在付款页' : '00:00:00';
    $('sale-time').textContent = `官网时间 · 北京 ${formatTime(task.openAt, 'Asia/Shanghai')} / 韩国 ${formatTime(task.openAt, 'Asia/Seoul')}`;
    if (opened && !active && run?.status !== 'payment') $('run-detail').textContent = '官网显示已开售。启动时会再次核对并请求官方入场接口；选场次、选座和订单由你继续操作。';
  }
  async function refresh() {
    if (pending) return;
    pending = true;
    try { state = { tasks: [], run: null, ...await request('GET_STATE') }; renderTasks(); render(); } finally { pending = false; }
  }
  async function act(type, payload = {}) {
    if (actionPending) return;
    actionPending = true; render();
    try { await request(type, payload); await refresh(); $('popup-message').hidden = true; } catch (error) { fail(error); } finally { actionPending = false; render(); }
  }
  async function diagnostics() {
    const data = await request('EXPORT_DIAGNOSTICS');
    if (!data?.downloaded && !data?.exported && data != null) {
      const payload = data?.diagnostics ?? data?.json ?? data?.text ?? data;
      const href = URL.createObjectURL(new Blob([typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = href; anchor.download = `nol-helper-diagnostics-${Date.now()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    }
    notice('诊断已导出。');
  }
  $('open-options').addEventListener('click', () => request('OPEN_OPTIONS').catch(fail));
  $('popup-task').addEventListener('change', render);
  $('popup-arm').addEventListener('click', () => { const task = selectedTask(); if (task) act('ARM', { taskId: task.id }); });
  $('popup-immediate').addEventListener('click', () => { const task = selectedTask(); if (task) act('ARM', { taskId: task.id, immediate: true }); });
  $('popup-pause').addEventListener('click', () => act('PAUSE'));
  $('popup-resume').addEventListener('click', () => { const resume = resumeState(state.run); if (!resume.available) return fail(new Error(resume.hint || '当前任务不能继续，请检查任务状态。')); act('RESUME'); });
  $('popup-stop').addEventListener('click', () => act('STOP'));
  $('popup-diagnostics').addEventListener('click', () => diagnostics().catch(fail));
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') refresh().catch(fail); });
  setInterval(() => refresh().catch(fail), 1000);
  refresh().catch(fail);
})();
