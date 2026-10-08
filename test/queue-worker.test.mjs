import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { TaskQueue } from '../src/core/task-queue.mjs';
import { QueueWorker } from '../src/core/queue-worker.mjs';
import { EventEmitter } from 'node:events';
const testPlugins = { manifests: [{ id: 'example-login', type: 'forum', hosts: ['example.com'],
  loginUrl: 'https://example.com/login' }] };

test('QueueWorker runs pending tasks sequentially and closes its browser', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'queue-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await new TaskQueue(path.join(root, 'tasks.json')).open();
  t.after(() => queue.close());
  await queue.enqueue(['https://example.com/one', 'https://example.com/two']);

  const calls = [];
  const plugins = {
    forums: [{ id: 'custom-forum' }],
    manifests: [{
      id: 'custom-forum',
      name: 'Custom Forum',
      type: 'forum',
      hosts: ['forum.example.com']
    }]
  };
  let receivedPlugins;
  let browserClosed = false;
  const worker = new QueueWorker({
    queue,
    config: {},
    plugins,
    log: () => {},
    browserLauncher: async () => ({ close: async () => { browserClosed = true; } }),
    workflowFactory: (_config, loadedPlugins) => {
      receivedPlugins = loadedPlugins;
      return {
        run: async (_context, url, { onProgress }) => {
          calls.push(url);
          await onProgress('inspecting');
          return { source: {}, results: [] };
        }
      };
    }
  });

  await worker.kick();

  assert.deepEqual(calls, ['https://example.com/one', 'https://example.com/two']);
  assert.equal(receivedPlugins, plugins);
  assert.deepEqual(worker.state().forums[0], {
    id: 'custom-forum',
    name: 'Custom Forum',
    hosts: ['forum.example.com']
  });
  assert.deepEqual(queue.tasks().map((task) => task.status), ['completed', 'completed']);
  await worker.close();
  assert.equal(browserClosed, true);
});

test('QueueWorker cancels the active workflow and closes its browser context', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'queue-worker-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await new TaskQueue(path.join(root, 'tasks.json')).open();
  t.after(() => queue.close());
  const { added: [task] } = await queue.enqueue(['https://example.com/one']);

  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let browserClosed = false;
  const worker = new QueueWorker({
    queue,
    config: {},
    log: () => {},
    browserLauncher: async () => ({ close: async () => { browserClosed = true; } }),
    workflowFactory: () => ({
      run: async (_context, _url, { onProgress, signal }) => {
        await onProgress('downloading');
        startedResolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    })
  });

  const runPromise = worker.kick();
  await started;
  const activeController = worker.currentAbortController;
  const originalSave = queue.save.bind(queue);
  let releaseCancelSave;
  const cancelSaveStarted = new Promise((resolve) => {
    queue.save = async () => {
      queue.save = originalSave;
      resolve();
      await new Promise((release) => { releaseCancelSave = release; });
      return originalSave();
    };
  });
  const cancelPromise = worker.cancel(task.id);
  await cancelSaveStarted;
  assert.equal(activeController.signal.aborted, true);
  releaseCancelSave();
  await cancelPromise;
  await runPromise;

  assert.equal(browserClosed, true);
  assert.equal(queue.requireTask(task.id).status, 'cancelled');
  assert.equal(worker.currentTaskId, null);
  await worker.close();
});

test('QueueWorker refuses to delete a task selected for execution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'queue-worker-remove-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await new TaskQueue(path.join(root, 'tasks.json')).open();
  t.after(() => queue.close());
  const { added: [task] } = await queue.enqueue(['https://example.com/one']);

  let releaseBrowser;
  const worker = new QueueWorker({
    queue,
    config: {},
    log: () => {},
    browserLauncher: () => new Promise((resolve) => {
      releaseBrowser = () => resolve({ close: async () => {} });
    }),
    workflowFactory: () => ({
      run: async () => ({ source: {}, results: [] })
    })
  });

  const runPromise = worker.kick();
  await assert.rejects(() => worker.remove(task.id), /Running task cannot be deleted/);
  assert.equal(queue.tasks().length, 1);
  releaseBrowser();
  await runPromise;
  await worker.close();
});

test('QueueWorker changes browser mode only while idle and closes the old context', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'queue-worker-browser-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await new TaskQueue(path.join(root, 'tasks.json')).open();
  t.after(() => queue.close());

  let contextClosed = false;
  let persistedHeadless;
  const config = { browser: { channel: 'chrome', headless: false } };
  const worker = new QueueWorker({
    queue,
    config,
    log: () => {},
    persistBrowserHeadless: async (headless) => { persistedHeadless = headless; }
  });
  worker.context = { close: async () => { contextClosed = true; } };

  assert.equal(await worker.setBrowserHeadless(true), true);
  assert.equal(contextClosed, true);
  assert.equal(persistedHeadless, true);
  assert.equal(config.browser.headless, true);
  assert.equal(worker.state().browser.headless, true);
  await worker.close();
});

test('QueueWorker refuses to change browser mode during a task', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'queue-worker-browser-busy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await new TaskQueue(path.join(root, 'tasks.json')).open();
  t.after(() => queue.close());
  const worker = new QueueWorker({ queue, config: { browser: { headless: false } }, log: () => {} });
  worker.running = true;

  await assert.rejects(() => worker.setBrowserHeadless(true), /while a task is running/);
  assert.equal(worker.state().browser.headless, false);
  worker.running = false;
  await worker.close();
});

function loginContext(goto = async () => {}) {
  const context = new EventEmitter();
  const page = new EventEmitter();
  let pageClosed = false;
  page.goto = goto;
  page.bringToFront = async () => {};
  page.close = async () => { pageClosed = true; page.emit('close'); };
  context.pages = () => pageClosed ? [] : [page];
  context.close = async () => { context.emit('close'); };
  return context;
}

async function loginWorker(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'queue-worker-login-'));
  const queue = await new TaskQueue(path.join(root, 'tasks.json')).open();
  const worker = new QueueWorker({ queue, config: {
    browserProfileDirectory: path.join(root, 'profile'), browser: { headless: true }
  }, plugins: testPlugins, log: () => {}, ...options });
  t.after(async () => {
    await worker.close();
    await queue.close();
    await rm(root, { recursive: true, force: true });
  });
  return { worker, queue };
}

test('Plugin login holds the queue and resumes downloads with the original browser mode and profile', async (t) => {
  const launches = [];
  const downloads = [];
  let oldClosed = false;
  let loginClosed = false;
  const { worker, queue } = await loginWorker(t, {
    browserLauncher: async (config) => {
      assert.equal(launches.length ? loginClosed : oldClosed, true);
      launches.push(config);
      const context = loginContext(async (url) => assert.equal(url, 'https://example.com/login'));
      context.on('close', () => { loginClosed = true; });
      return context;
    },
    workflowFactory: () => ({ run: async (_context, url) => {
      downloads.push(url);
      return { source: {}, results: [] };
    } })
  });
  worker.context = { close: async () => { oldClosed = true; } };
  await worker.openLogin('example-login');
  assert.equal(worker.state().browser.loginStatus, 'open');
  assert.equal(launches[0].browser.headless, false);
  assert.equal(worker.config.browser.headless, true);
  await worker.enqueue(['https://example.com/queued-during-login']);
  worker.resume();
  assert.equal(queue.tasks()[0].status, 'pending');
  assert.deepEqual(downloads, []);
  await assert.rejects(() => worker.openLogin('example-login'), /浏览器正在使用/);
  await assert.rejects(() => worker.setBrowserHeadless(false), /先完成/);
  await worker.finishLogin('example-login');
  await worker.runPromise;
  assert.equal(worker.state().browser.loginStatus, null);
  assert.equal(launches[1].browser.headless, true);
  assert.equal(launches[1].browserProfileDirectory, launches[0].browserProfileDirectory);
  assert.equal(queue.tasks()[0].status, 'completed');
  assert.equal(downloads.length, 1);
});

test('Closing the Plugin login window releases its profile and preserves a manually paused queue', async (t) => {
  const context = loginContext();
  const { worker, queue } = await loginWorker(t, { browserLauncher: async () => context });
  worker.pause();
  await worker.openLogin('example-login');
  await worker.enqueue(['https://example.com/waiting']);
  await context.close();
  assert.equal(worker.context, null);
  assert.equal(worker.state().browser.loginStatus, null);
  assert.equal(worker.paused, true);
  assert.equal(queue.tasks()[0].status, 'pending');
  await worker.finishLogin('example-login');
});

test('Closing the last login tab releases a background Chrome process and resumes queued tasks', async (t) => {
  const { worker, queue } = await loginWorker(t, {
    browserLauncher: async () => loginContext(),
    workflowFactory: () => ({ run: async () => ({ source: {}, results: [] }) })
  });
  await worker.openLogin('example-login');
  await worker.enqueue(['https://example.com/waiting']);
  assert.equal(queue.tasks()[0].status, 'pending');
  await worker.context.pages()[0].close();
  await new Promise(setImmediate);
  await worker.runPromise;
  assert.equal(worker.state().browser.loginStatus, null);
  assert.equal(queue.tasks()[0].status, 'completed');
});

test('Plugin login rejects busy tasks and concurrent requests while opening', async (t) => {
  let releaseLaunch;
  const { worker } = await loginWorker(t, {
    browserLauncher: () => new Promise((resolve) => { releaseLaunch = () => resolve(loginContext()); })
  });
  worker.running = true;
  await assert.rejects(() => worker.openLogin('example-login'), /任务运行中/);
  worker.running = false;
  const opening = worker.openLogin('example-login');
  assert.equal(worker.state().browser.loginStatus, 'opening');
  await assert.rejects(() => worker.openLogin('example-login'), /浏览器正在使用/);
  await assert.rejects(() => worker.finishLogin('example-login'), /正在打开或关闭/);
  releaseLaunch();
  await opening;
  await worker.finishLogin('example-login');
});

test('Plugin login navigation failure closes its browser and allows later tasks to run', async (t) => {
  let closed = false;
  const context = loginContext(async () => { throw new Error('login-navigation-failed'); });
  context.on('close', () => { closed = true; });
  const { worker, queue } = await loginWorker(t, {
    browserLauncher: async () => context,
    workflowFactory: () => ({ run: async () => ({ source: {}, results: [] }) })
  });
  await assert.rejects(() => worker.openLogin('example-login'), /login-navigation-failed/);
  assert.equal(closed, true);
  assert.equal(worker.state().browser.loginStatus, null);
  assert.equal(worker.context, null);
  await worker.runPromise;
  await worker.enqueue(['https://example.com/after-error']);
  await worker.runPromise;
  assert.equal(queue.tasks()[0].status, 'completed');
});

test('Worker shutdown waits for an opening login browser and closes it', async (t) => {
  let releaseLaunch;
  let closed = false;
  const { worker } = await loginWorker(t, {
    browserLauncher: () => new Promise((resolve) => {
      releaseLaunch = () => {
        const context = loginContext();
        context.on('close', () => { closed = true; });
        resolve(context);
      };
    })
  });
  const opening = assert.rejects(() => worker.openLogin('example-login'), /服务正在关闭/);
  const closing = worker.close();
  releaseLaunch();
  await Promise.all([opening, closing]);
  assert.equal(closed, true);
  assert.equal(worker.context, null);
});

test('login uses the enabled plugin declaration and refuses disabled or unrelated plugins', async (t) => {
  let visited;
  const { worker } = await loginWorker(t, {
    plugins: { manifests: [{ id: 'custom', type: 'forum', hosts: ['example.com'], loginUrl: 'https://example.com/sign-in' }] },
    browserLauncher: async () => loginContext(async (url) => { visited = url; })
  });
  await assert.rejects(() => worker.openLogin('example-login'), /插件未启用/);
  await worker.openLogin('custom');
  assert.equal(visited, 'https://example.com/sign-in');
  assert.equal(worker.state().browser.loginPluginId, 'custom');
  await assert.rejects(() => worker.finishLogin('other'), /属于其他插件/);
  assert.equal(worker.state().browser.loginStatus, 'open');
  await worker.finishLogin('custom');
  assert.equal(worker.state().browser.loginPluginId, null);
});

test('plugin operations hold the queue, exclude login and wait for completion during shutdown', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-plugin-'));
  const queue = await new TaskQueue(path.join(root, 'tasks.json')).open();
  const worker = new QueueWorker({ queue, config: {}, plugins: testPlugins, log: () => {} });
  t.after(async () => { await worker.close(); await queue.close(); await rm(root, { recursive: true, force: true }); });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const operation = worker.withPluginOperation('安装插件', async () => { await held; return { restartRequired: true }; });
  await worker.enqueue(['https://example.com/queued']);
  assert.equal(queue.tasks()[0].status, 'pending');
  assert.equal(worker.state().pluginOperation, '安装插件');
  await assert.rejects(() => worker.openLogin('example-login'), /浏览器正在使用/);
  await assert.rejects(() => worker.withPluginOperation('第二次安装', async () => ({})), /稍后/);
  let closed = false;
  const closing = worker.close().then(() => { closed = true; });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  release();
  await operation;
  await closing;
  assert.equal(worker.state().pluginsRestartRequired, true);
  assert.equal(worker.state().pluginOperation, null);
  assert.equal(queue.tasks()[0].status, 'pending');
});

test('failed plugin operations release guards and preserve manual queue pause', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-plugin-failure-'));
  const queue = await new TaskQueue(path.join(root, 'tasks.json')).open();
  const worker = new QueueWorker({ queue, config: {}, log: () => {} });
  t.after(async () => { await worker.close(); await queue.close(); await rm(root, { recursive: true, force: true }); });
  worker.pause();
  await assert.rejects(() => worker.withPluginOperation('安装', async () => { throw new Error('invalid-package'); }), /invalid-package/);
  assert.equal(worker.reconfiguring, false);
  assert.equal(worker.state().pluginOperation, null);
  assert.equal(worker.state().paused, true);
  worker.running = true;
  await assert.rejects(() => worker.withPluginOperation('安装', async () => ({})), /任务运行/);
  worker.running = false;
});

test('service reload replaces plugin routing and queue normalization while preserving tasks and pause', async (t) => {
  const config = { plugins: { enabled: ['old'] }, browser: { headless: true } };
  const { worker, queue } = await loginWorker(t, { config });
  worker.pause();
  await worker.enqueue(['https://example.com/waiting']);
  const tasks = structuredClone(queue.tasks());
  worker.pluginsRestartRequired = true;
  let closed = false;
  worker.context = { close: async () => { closed = true; } };
  const nextConfig = { plugins: { enabled: ['new'] } };
  const plugins = { sites: [{ id: 'new', hosts: ['new.example.com'] }],
    forums: [{ normalizeUrl: (value) => value.replace('/alias', '/canonical') }], providers: [] };
  const state = await worker.reloadService(async () => ({ config: nextConfig, plugins }));
  assert.equal(closed, true);
  assert.equal(worker.context, null);
  assert.equal(worker.config, config);
  assert.equal(config.plugins, nextConfig.plugins);
  assert.equal(worker.plugins, plugins);
  assert.deepEqual(state.forums, plugins.sites);
  assert.equal(state.pluginsRestartRequired, false);
  assert.equal(state.paused, true);
  assert.deepEqual(queue.tasks(), tasks);
  const result = await worker.enqueue(['https://example.com/alias']);
  assert.equal(result.added[0].url, 'https://example.com/canonical');
});

test('failed and busy service reloads keep the running plugins and pending change indicator', async (t) => {
  const { worker, queue } = await loginWorker(t);
  worker.pause();
  worker.pluginsRestartRequired = true;
  const plugins = worker.plugins;
  const config = worker.config;
  const forums = worker.forums;
  const context = { close: async () => { throw new Error('close-failed'); } };
  worker.context = context;
  await assert.rejects(() => worker.reloadService(async () => { throw new Error('bad-plugin'); }), /bad-plugin/);
  await assert.rejects(() => worker.reloadService(async () => ({ config: { plugins: {} }, plugins: {} })), /close-failed/);
  assert.equal(worker.plugins, plugins);
  assert.equal(worker.config, config);
  assert.equal(worker.forums, forums);
  assert.equal(worker.context, context);
  assert.equal(worker.state().pluginsRestartRequired, true);
  assert.equal(worker.reconfiguring, false);
  assert.equal(worker.paused, true);
  for (const property of ['running', 'loginStatus', 'reconfiguring', 'closing']) {
    worker[property] = true;
    await assert.rejects(() => worker.reloadService(async () => { assert.fail('must not load'); }), /稍后/);
    worker[property] = false;
  }
  assert.deepEqual(queue.tasks(), []);
  worker.context = null;
});
