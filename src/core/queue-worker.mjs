import { createWorkflow, launchBrowser } from '../app-runtime.mjs';
import { runQueuedTasks } from './batch-runner.mjs';

export class QueueWorker {
  constructor({
    queue,
    config,
    log = console.error,
    browserLauncher = launchBrowser,
    workflowFactory = createWorkflow,
    persistBrowserHeadless = async () => {},
    plugins = {}
  }) {
    this.queue = queue;
    this.config = config;
    this.log = log;
    this.browserLauncher = browserLauncher;
    this.workflowFactory = workflowFactory;
    this.persistBrowserHeadless = persistBrowserHeadless;
    this.plugins = plugins;
    this.forums = plugins.sites || (plugins.manifests || [])
        .filter((manifest) => manifest.type === 'forum')
        .map((manifest) => ({
          id: manifest.id,
          name: manifest.name || manifest.id,
          hosts: [...manifest.hosts],
          ...(manifest.loginUrl ? { loginUrl: manifest.loginUrl } : {})
        }));
    this.paused = false;
    this.running = false;
    this.reconfiguring = false;
    this.closing = false;
    this.context = null;
    this.loginStatus = null;
    this.loginPluginId = null;
    this.loginPromise = null;
    this.pluginPromise = null;
    this.pluginOperation = null;
    this.pluginsRestartRequired = false;
    this.currentTaskId = null;
    this.currentAbortController = null;
    this.runPromise = null;
    this.listeners = new Set();
  }

  state() {
    return {
      paused: this.paused,
      running: this.running,
      activeTaskId: this.currentTaskId,
      browser: { headless: Boolean(this.config.browser?.headless), loginStatus: this.loginStatus,
        loginPluginId: this.loginPluginId },
      forums: this.forums,
      pluginOperation: this.pluginOperation,
      pluginsRestartRequired: this.pluginsRestartRequired,
      tasks: this.queue.tasks()
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        this.log(`[resource-downloader] State listener failed: ${error.message}`);
      }
    }
  }

  async enqueue(urls) {
    const result = await this.queue.enqueue(urls);
    this.notify();
    this.kick();
    return result;
  }

  async retry(id) {
    const task = await this.queue.retry(id);
    this.notify();
    this.kick();
    return task;
  }

  async retryFailed() {
    const tasks = await this.queue.retryFailed();
    this.notify();
    this.kick();
    return tasks;
  }

  async remove(id) {
    if (this.currentTaskId === id) throw new Error(`Running task cannot be deleted: ${id}`);
    const task = await this.queue.remove(id);
    this.notify();
    return task;
  }

  async cancel(id) {
    if (this.currentTaskId !== id || !this.currentAbortController) {
      throw new Error(`Task is not running: ${id}`);
    }
    if (this.currentAbortController.signal.aborted) return this.queue.requireTask(id);

    const cancellationRequested = this.queue.markCancelRequested(id);
    this.notify();
    this.currentAbortController.abort(new Error('Task cancelled by user'));

    const context = this.context;
    this.context = null;
    if (context) {
      await context.close().catch((error) => {
        this.log(`[resource-downloader] Unable to close cancelled browser context: ${error.message}`);
      });
    }
    return cancellationRequested;
  }

  pause() {
    this.paused = true;
    this.notify();
  }

  resume() {
    this.paused = false;
    this.notify();
    this.kick();
  }

  async setBrowserHeadless(headless) {
    if (typeof headless !== 'boolean') throw new Error('headless must be a boolean');
    if (this.running || this.currentTaskId) {
      throw new Error('Browser mode cannot be changed while a task is running');
    }
    if (this.loginStatus) throw new Error('请先完成登录');
    if (this.reconfiguring) throw new Error('Browser mode is already being changed');
    if (Boolean(this.config.browser?.headless) === headless) return headless;

    this.reconfiguring = true;
    try {
      const context = this.context;
      this.context = null;
      if (context) await context.close();
      await this.persistBrowserHeadless(headless);
      this.config.browser = { ...this.config.browser, headless };
      return headless;
    } finally {
      this.reconfiguring = false;
      this.notify();
      this.kick();
    }
  }

  async withPluginOperation(label, action) {
    if (this.running || this.currentTaskId || this.loginStatus || this.reconfiguring || this.closing) {
      throw new Error('任务运行、登录或配置修改期间，请稍后管理插件');
    }
    this.reconfiguring = true;
    this.pluginOperation = label;
    this.notify();
    this.pluginPromise = (async () => {
      try {
        const result = await action();
        if (result.restartRequired) this.pluginsRestartRequired = true;
        return result;
      } finally {
        this.reconfiguring = false;
        this.pluginOperation = null;
        this.notify();
        this.kick();
      }
    })();
    try { return await this.pluginPromise; }
    finally { this.pluginPromise = null; }
  }

  async reloadService(loadRuntime) {
    await this.withPluginOperation('正在重新加载服务', async () => {
      const { config, plugins } = await loadRuntime();
      if (this.closing) throw new Error('本地服务正在关闭');
      if (this.context) await this.context.close();
      this.context = null;
      this.config.plugins = config.plugins;
      this.plugins = plugins;
      this.forums = plugins.sites;
      this.queue.forums = plugins.forums;
      this.pluginsRestartRequired = false;
      return { restartRequired: false };
    });
    return this.state();
  }

  async openLogin(pluginId) {
    const plugin = (this.plugins.manifests || []).find((manifest) => manifest.id === pluginId);
    if (!plugin?.loginUrl) throw new Error('插件未启用或未提供登录入口');
    if (this.running || this.currentTaskId) throw new Error('任务运行中，请等待完成后再登录');
    if (this.closing || this.reconfiguring || this.loginStatus) throw new Error('浏览器正在使用中，请稍后重试');
    this.loginStatus = 'opening';
    this.loginPluginId = pluginId;
    this.reconfiguring = true;
    this.notify();
    this.loginPromise = (async () => {
      try {
        if (this.context) await this.context.close();
        this.context = null;
        const context = await this.browserLauncher({
          ...this.config, browser: { ...this.config.browser, headless: false }
        });
        this.context = context;
        context.on('close', () => {
          if (this.context !== context) return;
          this.context = null;
          this.loginStatus = null;
          this.loginPluginId = null;
          this.notify();
          this.kick();
        });
        const watchPage = (page) => page.on('close', () => {
          if (this.context === context && this.loginStatus === 'open' && !context.pages().length) {
            this.finishLogin().catch((error) => this.log(`关闭登录窗口失败：${error.message}`));
          }
        });
        context.on('page', watchPage);
        context.pages().forEach(watchPage);
        if (this.closing) throw new Error('本地服务正在关闭');
        const page = context.pages()[0] || await context.newPage();
        await page.goto(plugin.loginUrl, { waitUntil: 'domcontentloaded' });
        if (this.context !== context) throw new Error('登录窗口已关闭');
        await page.bringToFront();
        this.loginStatus = 'open';
      } catch (error) {
        if (this.context) await this.context.close();
        this.context = null;
        this.loginStatus = null;
        this.loginPluginId = null;
        throw error;
      } finally {
        this.reconfiguring = false;
        this.notify();
        this.kick();
      }
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async finishLogin(pluginId) {
    if (pluginId && this.loginPluginId && pluginId !== this.loginPluginId) throw new Error('登录窗口属于其他插件');
    if (this.reconfiguring) throw new Error('登录窗口正在打开或关闭，请稍后重试');
    if (!this.loginStatus) return;
    this.reconfiguring = true;
    this.loginStatus = 'closing';
    this.notify();
    try {
      await this.context.close();
      this.context = null;
      this.loginStatus = null;
      this.loginPluginId = null;
    } finally {
      if (this.context) this.loginStatus = 'open';
      this.reconfiguring = false;
      this.notify();
      this.kick();
    }
  }

  kick() {
    if (this.running || this.paused || this.closing || this.reconfiguring || this.loginStatus) return this.runPromise;
    this.runPromise = this.run().catch((error) => {
      this.log(`[resource-downloader] Queue worker stopped: ${error.stack || error.message}`);
    });
    return this.runPromise;
  }

  async run() {
    this.running = true;
    this.notify();
    try {
      while (!this.paused && !this.closing) {
        const task = this.queue.pending()[0];
        if (!task) break;

        this.currentTaskId = task.id;
        this.currentAbortController = new AbortController();
        const signal = this.currentAbortController.signal;
        this.notify();
        try {
          if (!this.context) {
            try {
              const context = await this.browserLauncher(this.config);
              if (signal.aborted) await context.close();
              else this.context = context;
            } catch (error) {
              if (signal.aborted) {
                await this.queue.markCancelled(task.id);
                this.notify();
                continue;
              }
              await this.queue.markFailed(task.id, `Unable to start Chrome: ${error.message}`);
              this.notify();
              break;
            }
          }

          await runQueuedTasks({
            queue: this.queue,
            workflow: this.workflowFactory(this.config, this.plugins),
            context: this.context,
            tasks: [task],
            log: this.log,
            signal,
            onUpdate: async () => this.notify()
          });
        } finally {
          this.currentTaskId = null;
          this.currentAbortController = null;
        }
      }
    } finally {
      this.running = false;
      this.runPromise = null;
      this.notify();
    }
  }

  async close() {
    this.closing = true;
    this.paused = true;
    if (this.loginPromise) await this.loginPromise.catch(() => {});
    if (this.pluginPromise) await this.pluginPromise.catch(() => {});
    if (this.runPromise) await this.runPromise;
    if (this.context) await this.context.close();
    this.context = null;
    this.notify();
  }
}
