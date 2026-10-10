const DEFAULT_ENDPOINT = 'http://127.0.0.1:43127';
const isExtension = typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
const isDemo = new URLSearchParams(location.search).has('demo');

const elements = {
  dashboardPanel: document.querySelector('#dashboard-panel'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  settingsToggle: document.querySelector('#settings-toggle'),
  settingsPanel: document.querySelector('#settings-panel'),
  endpointInput: document.querySelector('#endpoint-input'),
  tokenInput: document.querySelector('#token-input'),
  headlessControl: document.querySelector('#headless-control'),
  headlessToggle: document.querySelector('#headless-toggle'),
  saveSettings: document.querySelector('#save-settings'),
  pluginsToggle: document.querySelector('#plugins-toggle'),
  pluginsPanel: document.querySelector('#plugins-panel'),
  installedRefresh: document.querySelector('#installed-refresh'),
  serviceReload: document.querySelector('#service-reload'),
  installedStatus: document.querySelector('#installed-status'),
  installedPlugins: document.querySelector('#installed-plugins'),
  repositoryForm: document.querySelector('#repository-form'),
  repositoryInput: document.querySelector('#repository-input'),
  repositoryRef: document.querySelector('#repository-ref'),
  repositoryRead: document.querySelector('#repository-read'),
  repositoryStatus: document.querySelector('#repository-status'),
  repositoryPlugins: document.querySelector('#repository-plugins'),
  pluginEnable: document.querySelector('#plugin-enable'),
  pluginsRestartHint: document.querySelector('#plugins-restart-hint'),
  currentUrl: document.querySelector('#current-url'),
  siteBadge: document.querySelector('#site-badge'),
  enqueueCurrent: document.querySelector('#enqueue-current'),
  pluginActions: document.querySelector('#plugin-actions'),
  pluginLoginPanel: document.querySelector('#plugin-login-panel'),
  pluginLogin: document.querySelector('#plugin-login'),
  pluginLoginHint: document.querySelector('#plugin-login-hint'),
  queueSummary: document.querySelector('#queue-summary'),
  pauseToggle: document.querySelector('#pause-toggle'),
  retryAll: document.querySelector('#retry-all'),
  taskList: document.querySelector('#task-list'),
  emptyState: document.querySelector('#empty-state'),
  notice: document.querySelector('#notice'),
  confirmDialog: document.querySelector('#confirm-dialog'),
  confirmTitle: document.querySelector('#confirm-title'),
  confirmMessage: document.querySelector('#confirm-message'),
  confirmCancel: document.querySelector('#confirm-cancel'),
  confirmAction: document.querySelector('#confirm-action')
};

const statusLabels = {
  pending: '等待',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  'action-required': '需处理',
  cancelled: '已取消'
};

const stageLabels = {
  queued: '等待处理',
  'sync-queued': '等待增量同步',
  recovered: '已恢复',
  inspecting: '检查帖子',
  replying: '提交回复',
  'reply-completed': '回复完成',
  extracting: '解析资源',
  downloading: '正在下载',
  finalizing: '写入清单',
  completed: '归档完成',
  failed: '处理失败',
  'action-required': '需要人工处理',
  'reply-status-unknown': '回复状态待确认',
  'retry-queued': '等待重试',
  cancelling: '正在取消',
  cancelled: '已取消'
};

const stageProgress = {
  queued: 5,
  'sync-queued': 5,
  recovered: 5,
  inspecting: 14,
  replying: 28,
  'reply-completed': 38,
  extracting: 48,
  downloading: 72,
  finalizing: 92,
  completed: 100,
  failed: 100,
  'action-required': 100,
  cancelling: 100,
  cancelled: 100
};

let settings = { endpoint: DEFAULT_ENDPOINT, token: '' };
let state = {
  paused: false,
  running: false,
  browser: { headless: false },
  forums: [],
  tasks: []
};
let activeFilter = 'active';
let eventAbortController;
let noticeTimer;
let pendingConfirmAction;
let repositoryCatalog;
let repositoryBusy = false;
let installingPlugin = false;
let repositoryRevision = 0;
let repositoryTimer;
let installedRevision = 0;
let pluginSettingsBusy = false;

function storageGet() {
  if (isExtension) return chrome.storage.local.get(['endpoint', 'token']);
  return Promise.resolve({
    endpoint: localStorage.getItem('endpoint'),
    token: localStorage.getItem('token')
  });
}

function storageSet(values) {
  if (isExtension) return chrome.storage.local.set(values);
  Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value));
  return Promise.resolve();
}

async function fetchWithServiceWake(path, options = {}) {
  const request = () => fetch(`${settings.endpoint}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${settings.token}`,
      ...(options.headers || {})
    }
  });
  try {
    return await request();
  } catch (error) {
    if (!isExtension || error.name === 'AbortError') throw error;
    const wakeResult = await chrome.runtime.sendMessage({ type: 'ensure-local-service' });
    if (!wakeResult?.ok) throw new Error(wakeResult?.error || '无法唤醒本地服务');
    return request();
  }
}

async function api(path, options = {}) {
  if (isDemo) return {};
  const response = await fetchWithServiceWake(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `服务返回 ${response.status}`);
  return payload;
}

function showNotice(message) {
  clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  noticeTimer = setTimeout(() => { elements.notice.hidden = true; }, 3200);
}

function requestConfirmation({ title, message, label, action }) {
  pendingConfirmAction = action;
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmAction.textContent = label;
  elements.confirmDialog.showModal();
}

function setConnection(mode, label) {
  elements.connectionDot.className = `status-dot ${mode}`;
  elements.connectionLabel.textContent = label;
}

function hostMatches(hostname, pattern) {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2).toLowerCase();
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === pattern.toLowerCase();
}

function supportedForum(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    const hostname = url.hostname.toLowerCase();
    const forums = state.forums || [];
    return forums.find((forum) =>
      forum.hosts.some((pattern) => hostMatches(hostname, pattern))) || null;
  } catch {
    return null;
  }
}

function updateCurrentUrl(value) {
  elements.currentUrl.value = value || '';
  const forum = supportedForum(value);
  elements.siteBadge.textContent = forum?.name || '不支持';
  elements.siteBadge.classList.toggle('unsupported', !forum);
  elements.enqueueCurrent.disabled = !forum || !settings.token;
  elements.pluginActions.replaceChildren();
  for (const action of forum?.actions || []) {
    if (!new RegExp(action.pathPattern).test(new URL(value).pathname)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-button';
    button.textContent = action.label;
    button.disabled = !settings.token;
    button.addEventListener('click', () => perform(async () => {
      const url = new URL(elements.currentUrl.value);
      Object.entries(action.query).forEach(([key, item]) => url.searchParams.set(key, item));
      const result = await api('/api/tasks', {
        method: 'POST', body: JSON.stringify({ urls: [url.toString()] })
      });
      showNotice(result.added.length ? '任务已加入队列'
        : result.refreshed?.length ? '合集或专辑已加入增量同步' : '该资源已在队列中');
    }));
    elements.pluginActions.append(button);
  }
  const loginStatus = state.browser?.loginStatus;
  elements.pluginLoginPanel.hidden = !forum?.loginUrl && !loginStatus;
  elements.pluginLogin.textContent = loginStatus === 'open' ? '完成登录'
    : loginStatus === 'opening' ? '正在打开登录窗口…'
      : loginStatus === 'closing' ? '正在关闭登录窗口…' : `登录 ${forum?.name || ''}`;
  elements.pluginLogin.disabled = isDemo || !settings.token || state.running || Boolean(state.pluginOperation)
    || Boolean(loginStatus && loginStatus !== 'open');
  elements.pluginLogin.title = state.running ? '任务运行中，请等待完成后再登录' : '';
  elements.pluginLoginHint.textContent = loginStatus
    ? '请在弹出窗口登录。完成后点击“完成登录”，队列将继续处理。'
    : '在弹出窗口登录，完成后点击“完成登录”。';
}

async function readCurrentTab() {
  if (!isExtension) {
    elements.currentUrl.readOnly = false;
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  updateCurrentUrl(tab?.url || '');
}

function taskFilter(task) {
  if (activeFilter === 'completed') return task.status === 'completed';
  if (activeFilter === 'issues') {
    return task.status === 'failed' || task.status === 'action-required' || task.status === 'cancelled';
  }
  return task.status === 'pending' || task.status === 'running';
}

function taskTitle(task) {
  const forum = supportedForum(task.url);
  const url = new URL(task.url);
  const action = forum?.actions?.find((item) => item.taskLabel
    && new RegExp(item.pathPattern).test(url.pathname)
    && Object.entries(item.query).every(([key, value]) => url.searchParams.get(key) === value));
  if (action) {
    return `${task.summary?.threadTitle || url.pathname.split('/').filter(Boolean).pop()} · ${action.taskLabel}`;
  }
  if (task.summary?.threadTitle) return task.summary.threadTitle;
  return task.summary?.threadId && forum ? `${forum.name} #${task.summary.threadId}` : task.url;
}

function icon(name) {
  const element = document.createElement('i');
  element.dataset.lucide = name;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function createIconButton(iconName, title, action, taskId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.append(icon(iconName));
  button.title = title;
  button.setAttribute('aria-label', title);
  button.dataset.action = action;
  button.dataset.taskId = taskId;
  return button;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function createTaskRow(task) {
  const row = document.createElement('article');
  row.className = 'task-row';

  const top = document.createElement('div');
  top.className = 'task-topline';
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = taskTitle(task);
  title.title = title.textContent;
  const status = document.createElement('span');
  status.className = `status-label status-${task.status}`;
  status.textContent = statusLabels[task.status] || task.status;
  top.append(title, status);

  const url = document.createElement('div');
  url.className = 'task-url';
  url.textContent = task.url;
  url.title = task.url;

  row.append(top, url);
  if (task.lastError) {
    const error = document.createElement('div');
    error.className = 'task-error';
    error.textContent = task.lastError;
    error.title = task.lastError;
    row.append(error);
  }

  const progress = document.createElement('div');
  progress.className = 'progress-track';
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const transfer = task.progress?.transfer;
  const streamFraction = transfer?.streamName === '合并中' ? 1
    : transfer?.totalBytes > 0 ? Math.min(1, transfer.bytes / transfer.totalBytes) : 0;
  const resourceFraction = transfer?.streamCount
    ? ((transfer.stream || 1) - 1 + streamFraction) / transfer.streamCount : 0;
  bar.style.width = `${task.stage === 'downloading' && task.progress?.total
    ? 48 + 44 * ((task.progress.current || 1) - 1 + resourceFraction) / task.progress.total
    : stageProgress[task.stage] ?? 8}%`;
  progress.append(bar);
  row.append(progress);

  const footer = document.createElement('div');
  footer.className = 'task-footer';
  const meta = document.createElement('span');
  meta.className = 'task-meta';
  const progressText = task.progress?.total
    ? ` ${task.progress.current || 0}/${task.progress.total}`
    : '';
  const transferText = transfer ? ` · ${transfer.streamName || ''}${transfer.totalBytes > 0
    ? ` ${formatBytes(transfer.bytes)}/${formatBytes(transfer.totalBytes)} · ${formatBytes(transfer.speed)}/s` : ''}` : '';
  meta.textContent = `${stageLabels[task.stage] || task.stage}${progressText}${transferText} · 尝试 ${task.attempts || 0}`;
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const isActive = task.id === state.activeTaskId || (!state.activeTaskId && task.status === 'running');
  if (isActive && (task.status === 'pending' || task.status === 'running') && task.stage !== 'cancelling') {
    actions.append(createIconButton('circle-x', '取消任务', 'cancel', task.id));
  }
  if (task.status === 'failed' || task.status === 'action-required' || task.status === 'cancelled') {
    actions.append(createIconButton('refresh-cw', '重试任务', 'retry', task.id));
  }
  if (task.summary?.directory) {
    actions.append(createIconButton('folder-open', '打开归档目录', 'open', task.id));
  }
  if (task.status !== 'running') {
    actions.append(createIconButton('trash-2', '删除任务', 'delete', task.id));
  }
  footer.append(meta, actions);
  row.append(footer);
  return row;
}

function render(nextState = state) {
  state = nextState;
  updateCurrentUrl(elements.currentUrl.value);
  elements.headlessToggle.checked = Boolean(state.browser?.headless);
  elements.headlessToggle.disabled = isDemo || state.running || Boolean(state.browser?.loginStatus) || Boolean(state.pluginOperation) || !settings.token;
  elements.headlessControl.title = state.running || state.browser?.loginStatus || state.pluginOperation
    ? '任务运行、登录或插件管理期间，暂时不能切换'
    : '隐藏自动化浏览器窗口';
  const activeCount = state.tasks.filter((task) => task.status === 'pending' || task.status === 'running').length;
  elements.queueSummary.textContent = `${state.tasks.length} 个任务 · ${activeCount} 个进行中`;
  elements.pauseToggle.replaceChildren(icon(state.paused ? 'play' : 'pause'));
  elements.pauseToggle.title = state.paused ? '继续队列' : '暂停队列';
  elements.pauseToggle.setAttribute('aria-label', elements.pauseToggle.title);
  elements.retryAll.disabled = !state.tasks.some((task) => task.status === 'failed' || task.status === 'action-required');
  setConnection(state.running || state.browser?.loginStatus || state.pluginOperation ? 'busy' : 'online',
    state.pluginOperation || (state.browser?.loginStatus ? '等待完成登录' : state.running ? '正在处理' : state.paused ? '已暂停' : '服务在线'));

  const tasks = state.tasks.filter(taskFilter).reverse();
  elements.taskList.replaceChildren(...tasks.map(createTaskRow));
  elements.emptyState.hidden = tasks.length > 0;
  lucide.createIcons();
  renderRepositoryPlugins();
}

function pluginCategory(plugin) {
  return plugin.type === 'provider' ? '网盘插件' : '网站插件';
}

function groupPluginRows(plugins, createRow) {
  return ['网站插件', '网盘插件'].map((category) => {
    const items = plugins.filter((plugin) => pluginCategory(plugin) === category);
    const group = document.createElement('section');
    group.className = 'plugin-group';
    group.setAttribute('aria-label', category);
    const title = document.createElement('h4');
    title.textContent = `${category}（${items.length}）`;
    const rows = document.createElement('div');
    rows.className = 'repository-plugins';
    if (items.length) rows.append(...items.map(createRow));
    else {
      const empty = document.createElement('p');
      empty.className = 'repository-status';
      empty.textContent = '暂无此类插件。';
      rows.append(empty);
    }
    group.append(title, rows);
    return group;
  });
}

async function refreshInstalledPlugins() {
  const revision = ++installedRevision;
  elements.installedPlugins.replaceChildren();
  elements.installedStatus.classList.remove('error');
  if (isDemo || !settings.token) {
    elements.installedStatus.textContent = isDemo ? '演示模式不读取本地插件。' : '请先连接本地服务。';
    elements.installedRefresh.disabled = false;
    return;
  }
  elements.installedRefresh.disabled = true;
  elements.installedStatus.textContent = '正在读取已安装插件…';
  try {
    const { plugins } = await api('/api/plugins/installed');
    if (revision !== installedRevision) return;
    elements.installedPlugins.replaceChildren(...groupPluginRows(plugins, (plugin) => {
      const row = document.createElement('div');
      row.className = 'repository-plugin';
      const title = document.createElement('strong');
      title.textContent = plugin.name || plugin.id;
      const details = document.createElement('p');
      details.textContent = `${plugin.id} · ${plugin.enabled ? '已配置启用' : '未配置启用'}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary-button';
      button.dataset.enabledPluginId = plugin.id;
      button.dataset.enabled = String(!plugin.enabled);
      button.textContent = plugin.enabled ? '禁用' : '启用';
      button.setAttribute('aria-label', `${plugin.name || plugin.id}：${button.textContent}`);
      button.disabled = repositoryBusy || repositoryUnavailable();
      const uninstall = document.createElement('button');
      uninstall.type = 'button';
      uninstall.className = 'secondary-button';
      uninstall.dataset.uninstallPluginId = plugin.id;
      uninstall.dataset.pluginName = plugin.name || plugin.id;
      uninstall.textContent = '卸载';
      uninstall.setAttribute('aria-label', `${plugin.name || plugin.id}：卸载`);
      uninstall.disabled = button.disabled;
      row.append(title, details, button, uninstall);
      return row;
    }));
    elements.installedStatus.textContent = plugins.length ? `${plugins.length} 个已安装插件；更改后需重新加载服务。` : '尚未安装插件。';
  } catch (error) {
    if (revision !== installedRevision) return;
    elements.installedStatus.textContent = error.message;
    elements.installedStatus.classList.add('error');
  } finally {
    if (revision === installedRevision) elements.installedRefresh.disabled = false;
  }
}

function repositoryUnavailable() {
  return isDemo || !settings.token || pluginSettingsBusy || state.running || Boolean(state.browser?.loginStatus) || Boolean(state.pluginOperation);
}

function setRepositoryStatus(message, error = false) {
  elements.repositoryStatus.textContent = message;
  elements.repositoryStatus.classList.toggle('error', error);
}

function renderRepositoryPlugins() {
  elements.pluginsRestartHint.hidden = !state.pluginsRestartRequired;
  elements.serviceReload.disabled = repositoryBusy || repositoryUnavailable();
  elements.installedPlugins.querySelectorAll('[data-enabled-plugin-id], [data-uninstall-plugin-id]').forEach((button) => {
    button.disabled = repositoryBusy || repositoryUnavailable();
  });
  elements.repositoryRead.disabled = repositoryBusy || repositoryUnavailable();
  elements.repositoryInput.disabled = installingPlugin || pluginSettingsBusy;
  elements.repositoryRef.disabled = installingPlugin || pluginSettingsBusy;
  elements.pluginEnable.disabled = installingPlugin || pluginSettingsBusy;
  if (!repositoryCatalog) { elements.repositoryPlugins.replaceChildren(); return; }
  const rows = groupPluginRows(repositoryCatalog.plugins, (plugin) => {
    const row = document.createElement('div');
    row.className = 'repository-plugin';
    const title = document.createElement('strong');
    title.textContent = plugin.name || plugin.id;
    const description = document.createElement('p');
    description.textContent = plugin.description;
    const details = document.createElement('p');
    details.textContent = `${plugin.id} · API ${plugin.apiVersion} · ${plugin.hosts.join('、')}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-button';
    button.dataset.pluginId = plugin.id;
    button.textContent = !plugin.compatible ? 'API 版本不兼容'
      : plugin.installed ? plugin.enabled ? '已安装 · 已配置启用' : '已安装' : '安装';
    button.setAttribute('aria-label', `${plugin.name || plugin.id}：${button.textContent}`);
    button.disabled = !plugin.compatible || plugin.installed || repositoryBusy || repositoryUnavailable();
    row.append(title, description, details, button);
    return row;
  });
  elements.repositoryPlugins.replaceChildren(...rows);
}

async function readRepository() {
  clearTimeout(repositoryTimer);
  const repository = elements.repositoryInput.value.trim();
  if (!repository || repositoryBusy) return;
  if (repositoryUnavailable()) {
    setRepositoryStatus('请连接本地服务，并在下载或登录完成后读取仓库。');
    return;
  }
  const revision = repositoryRevision;
  repositoryBusy = true;
  repositoryCatalog = undefined;
  setRepositoryStatus('正在读取插件列表…');
  renderRepositoryPlugins();
  try {
    const catalog = await api('/api/plugins/repository', { method: 'POST',
      body: JSON.stringify({ repository, ref: elements.repositoryRef.value.trim() || undefined }) });
    if (revision !== repositoryRevision) return;
    repositoryCatalog = catalog;
    setRepositoryStatus(`${catalog.name} · ${catalog.plugins.length} 个插件 · 版本 ${catalog.ref} (${catalog.commit.slice(0, 7)})`);
  } catch (error) {
    if (revision === repositoryRevision) setRepositoryStatus(error.message, true);
  } finally {
    repositoryBusy = false;
    await refresh();
    renderRepositoryPlugins();
    if (revision !== repositoryRevision) repositoryTimer = setTimeout(readRepository, 800);
  }
}

function repositoryChanged() {
  repositoryRevision += 1;
  repositoryCatalog = undefined;
  clearTimeout(repositoryTimer);
  renderRepositoryPlugins();
  setRepositoryStatus(elements.repositoryInput.value.trim() ? '等待读取插件列表…' : '填写仓库地址后自动读取插件列表。');
  if (elements.repositoryInput.value.trim()) repositoryTimer = setTimeout(readRepository, 800);
}

function showView(view) {
  elements.dashboardPanel.hidden = view !== 'dashboard';
  elements.pluginsPanel.hidden = view !== 'plugins';
  elements.settingsPanel.hidden = view !== 'settings';
  elements.pluginsToggle.setAttribute('aria-pressed', String(view === 'plugins'));
  elements.settingsToggle.setAttribute('aria-pressed', String(view === 'settings'));
  window.scrollTo(0, 0);
  if (view === 'dashboard') document.querySelector('#capture-title').focus({ preventScroll: true });
  else document.querySelector(`#${view}-title`).focus({ preventScroll: true });
  if (view === 'plugins') {
    renderRepositoryPlugins();
    refreshInstalledPlugins();
  }
}

elements.pluginsToggle.addEventListener('click', () => showView(elements.pluginsPanel.hidden ? 'plugins' : 'dashboard'));
document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.view));
});
elements.installedRefresh.addEventListener('click', refreshInstalledPlugins);
elements.installedPlugins.addEventListener('click', (event) => {
  const button = event.target.closest('[data-uninstall-plugin-id]');
  if (!button || button.disabled || repositoryBusy || repositoryUnavailable()) return;
  requestConfirmation({ title: `卸载 ${button.dataset.pluginName}`, label: '卸载',
    message: '将删除插件、附带工具和更新备份。已下载文件和系统安装的工具会保留。',
    action: async () => {
      if (repositoryBusy || repositoryUnavailable()) return;
      pluginSettingsBusy = true;
      renderRepositoryPlugins();
      try {
        const result = await api('/api/plugins/uninstall', { method: 'POST',
          body: JSON.stringify({ id: button.dataset.uninstallPluginId }) });
        render(result.state);
        repositoryCatalog = undefined;
        setRepositoryStatus('插件及附带工具已卸载，服务已重新加载。');
        showNotice('插件及附带工具已卸载');
      } catch (error) {
        repositoryCatalog = undefined;
        setRepositoryStatus(error.message, true);
        showNotice(error.message);
      } finally {
        pluginSettingsBusy = false;
        await refresh();
        await refreshInstalledPlugins();
      }
    } });
});
elements.installedPlugins.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-enabled-plugin-id]');
  if (!button || button.disabled || repositoryBusy || repositoryUnavailable()) return;
  pluginSettingsBusy = true;
  renderRepositoryPlugins();
  try {
    const result = await api('/api/plugins/enabled', { method: 'POST', body: JSON.stringify({
      id: button.dataset.enabledPluginId, enabled: button.dataset.enabled === 'true'
    }) });
    const plugin = repositoryCatalog?.plugins.find((item) => item.id === result.id);
    if (plugin) plugin.enabled = result.enabled;
    const message = `已保存${result.enabled ? '启用' : '禁用'}配置，点击“重新加载服务”后生效`;
    setRepositoryStatus(message);
    showNotice(message);
  } catch (error) {
    showNotice(error.message);
  } finally {
    pluginSettingsBusy = false;
    await refresh();
    await refreshInstalledPlugins();
  }
});
elements.serviceReload.addEventListener('click', async () => {
  if (repositoryBusy || repositoryUnavailable()) return;
  pluginSettingsBusy = true;
  elements.serviceReload.textContent = '正在重新加载…';
  renderRepositoryPlugins();
  try {
    const result = await api('/api/service/reload', { method: 'POST' });
    render(result.state);
    repositoryCatalog = undefined;
    setRepositoryStatus('服务已重新加载，插件配置已生效。');
    showNotice('服务已重新加载，插件配置已生效');
  } catch (error) {
    const message = `重新加载失败：${error.message}`;
    setRepositoryStatus(message, true);
    showNotice(message);
  } finally {
    pluginSettingsBusy = false;
    elements.serviceReload.textContent = '重新加载服务';
    renderRepositoryPlugins();
    await refreshInstalledPlugins();
  }
});
elements.repositoryInput.addEventListener('input', repositoryChanged);
elements.repositoryRef.addEventListener('input', repositoryChanged);
elements.repositoryForm.addEventListener('submit', (event) => { event.preventDefault(); readRepository(); });
elements.repositoryPlugins.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-plugin-id]');
  if (!button || button.disabled || !repositoryCatalog) return;
  const plugin = repositoryCatalog.plugins.find((item) => item.id === button.dataset.pluginId);
  repositoryBusy = true;
  installingPlugin = true;
  setRepositoryStatus(`正在安装 ${plugin.name || plugin.id}…`);
  renderRepositoryPlugins();
  try {
    const result = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({
      catalogId: repositoryCatalog.catalogId, id: plugin.id, enable: elements.pluginEnable.checked
    }) });
    plugin.installed = true;
    plugin.enabled = result.enabled;
    setRepositoryStatus(result.warning || `${plugin.name || plugin.id} 已安装${result.enabled ? '并配置启用' : ''}；重新加载服务后生效。`, Boolean(result.warning));
    await refreshInstalledPlugins();
  } catch (error) {
    setRepositoryStatus(error.message, true);
  } finally {
    repositoryBusy = false;
    installingPlugin = false;
    await refresh();
    renderRepositoryPlugins();
  }
});

async function connectEvents() {
  eventAbortController?.abort();
  if (!settings.token || isDemo) return;
  eventAbortController = new AbortController();
  try {
    const response = await fetchWithServiceWake('/api/events', {
      signal: eventAbortController.signal
    });
    if (!response.ok || !response.body) throw new Error(`连接失败 ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('服务连接已关闭');
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const event of events) {
        const data = event.split('\n').find((line) => line.startsWith('data: '));
        if (data) render(JSON.parse(data.slice(6)));
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    setConnection('offline', '服务离线');
    setTimeout(connectEvents, 2000);
  }
}

async function refresh() {
  if (isDemo) return;
  try {
    render(await api('/api/state'));
  } catch (error) {
    setConnection('offline', '服务离线');
    showNotice(error.message);
  }
}

async function perform(action) {
  try {
    await action();
    await refresh();
  } catch (error) {
    showNotice(error.message);
  }
}

elements.settingsToggle.addEventListener('click', () => {
  showView(elements.settingsPanel.hidden ? 'settings' : 'dashboard');
});

elements.saveSettings.addEventListener('click', async () => {
  settings = {
    endpoint: elements.endpointInput.value.replace(/\/$/, '') || DEFAULT_ENDPOINT,
    token: elements.tokenInput.value.trim()
  };
  await storageSet(settings);
  showView('dashboard');
  updateCurrentUrl(elements.currentUrl.value);
  await refresh();
  connectEvents();
});

elements.headlessToggle.addEventListener('change', async () => {
  const headless = elements.headlessToggle.checked;
  elements.headlessToggle.disabled = true;
  try {
    const result = await api('/api/settings/browser', {
      method: 'POST',
      body: JSON.stringify({ headless })
    });
    render(result.state);
    showNotice(headless ? '已启用后台静默运行' : '已显示自动化浏览器');
  } catch (error) {
    render(state);
    showNotice(error.message);
  }
});

elements.currentUrl.addEventListener('input', () => updateCurrentUrl(elements.currentUrl.value));

elements.pluginLogin.addEventListener('click', () => perform(async () => {
  const finishing = state.browser?.loginStatus === 'open';
  const pluginId = finishing ? state.browser.loginPluginId : supportedForum(elements.currentUrl.value)?.id;
  if (!pluginId) throw new Error('插件未提供登录入口');
  elements.pluginLogin.disabled = true;
  try {
    const result = await api(`/api/plugins/${encodeURIComponent(pluginId)}/login${finishing ? '/finish' : ''}`, { method: 'POST' });
    render(result.state);
    showNotice(finishing ? '登录窗口已关闭，后续下载将复用保存的会话' : '请在弹出的窗口中完成登录');
  } finally {
    updateCurrentUrl(elements.currentUrl.value);
  }
}));

elements.enqueueCurrent.addEventListener('click', () => perform(async () => {
  const result = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ urls: [elements.currentUrl.value] })
  });
  showNotice(
    result.added.length
      ? '任务已加入队列'
      : result.refreshed?.length
        ? '合集或专辑已加入增量同步'
        : '该资源已在队列中'
  );
}));

elements.pauseToggle.addEventListener('click', () => perform(() => api(
  state.paused ? '/api/queue/resume' : '/api/queue/pause',
  { method: 'POST' }
)));

elements.retryAll.addEventListener('click', () => perform(() => api('/api/retry-failed', { method: 'POST' })));

document.querySelector('.segmented-control').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  activeFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((item) => {
    const selected = item === button;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
  });
  render();
});

elements.taskList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'delete') {
    requestConfirmation({
      title: '删除任务',
      message: '仅删除任务记录，不会删除已下载文件。',
      label: '删除',
      action: async () => {
        await api(`/api/tasks/${encodeURIComponent(button.dataset.taskId)}`, { method: 'DELETE' });
        showNotice('任务已删除');
      }
    });
    return;
  }
  if (button.dataset.action === 'cancel') {
    requestConfirmation({
      title: '取消任务',
      message: '将停止当前自动化流程。已经交给网盘客户端的下载可能继续。',
      label: '取消任务',
      action: async () => {
        await api(`/api/tasks/${encodeURIComponent(button.dataset.taskId)}/cancel`, { method: 'POST' });
        showNotice('正在取消任务');
      }
    });
    return;
  }
  const path = button.dataset.action === 'retry'
    ? `/api/tasks/${encodeURIComponent(button.dataset.taskId)}/retry`
    : '/api/open-directory';
  perform(() => api(path, {
    method: 'POST',
    body: button.dataset.action === 'open'
      ? JSON.stringify({ taskId: button.dataset.taskId })
      : undefined
  }));
});

elements.confirmCancel.addEventListener('click', () => elements.confirmDialog.close());
elements.confirmDialog.addEventListener('close', () => { pendingConfirmAction = undefined; });
elements.confirmAction.addEventListener('click', () => {
  const action = pendingConfirmAction;
  elements.confirmDialog.close();
  if (action) perform(action);
});

if (isExtension) {
  chrome.tabs.onActivated.addListener(readCurrentTab);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.active) updateCurrentUrl(changeInfo.url);
  });
}

async function initialize() {
  lucide.createIcons();
  const stored = await storageGet();
  settings = {
    endpoint: stored.endpoint || DEFAULT_ENDPOINT,
    token: stored.token || ''
  };
  elements.endpointInput.value = settings.endpoint;
  elements.tokenInput.value = settings.token;
  await readCurrentTab();

  if (isDemo) {
    settings.token = 'demo';
    updateCurrentUrl('https://www.hifiti.com/thread-154961.htm');
    render({
      paused: false,
      running: true,
      browser: { headless: true },
      forums: [{ id: 'demo-forum', name: 'HiFiTi', hosts: ['hifiti.com', '*.hifiti.com'] }],
      activeTaskId: '1',
      tasks: [
        { id: '1', url: 'https://www.hifiti.com/thread-154961.htm', status: 'running', stage: 'downloading', attempts: 1, progress: { current: 1, total: 1 }, summary: { threadId: '154961' } },
        { id: '2', url: 'https://www.hifiti.com/thread-1228.htm', status: 'pending', stage: 'queued', attempts: 0 },
        { id: '3', url: 'https://www.hifiti.com/thread-900.htm', status: 'action-required', stage: 'action-required', attempts: 1, lastError: '百度网盘需要重新登录' },
        { id: '4', url: 'https://www.hifiti.com/thread-811.htm', status: 'completed', stage: 'completed', attempts: 1, summary: { threadId: '811', directory: '/tmp/archive' } }
      ]
    });
    return;
  }

  if (!settings.token) {
    showView('settings');
    setConnection('offline', '需要令牌');
    return;
  }
  await refresh();
  connectEvents();
}

initialize();
