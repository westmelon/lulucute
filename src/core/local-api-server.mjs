import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';

const STATIC_FILES = new Map([
  ['/', ['sidepanel.html', 'text/html; charset=utf-8']],
  ['/sidepanel.css', ['sidepanel.css', 'text/css; charset=utf-8']],
  ['/sidepanel.js', ['sidepanel.js', 'text/javascript; charset=utf-8']],
  ['/vendor/lucide.min.js', ['vendor/lucide.min.js', 'text/javascript; charset=utf-8']]
]);

function bearerMatches(header, token) {
  const actual = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class LocalApiServer {
  constructor({ worker, token, downloadRoot, staticDirectory, pluginManager, port = 43127, log = console.error }) {
    this.worker = worker;
    this.pluginManager = pluginManager;
    this.token = token;
    this.downloadRoot = path.resolve(downloadRoot);
    this.staticDirectory = path.resolve(staticDirectory);
    this.port = port;
    this.log = log;
    this.clients = new Set();
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.log(`[resource-downloader] API error: ${error.stack || error.message}`);
        this.sendJson(response, 400, { error: error.message });
      });
    });
    this.unsubscribe = this.worker.subscribe((state) => this.broadcast(state));
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  async close() {
    this.unsubscribe();
    for (const client of this.clients) client.end();
    await new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  allowedOrigin(origin) {
    if (!origin) return true;
    if (origin.startsWith('chrome-extension://')) return true;
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  setCors(request, response) {
    const origin = request.headers.origin;
    if (origin && this.allowedOrigin(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }

  async handle(request, response) {
    const url = new URL(request.url, `http://127.0.0.1:${this.port}`);
    this.setCors(request, response);

    if (request.method === 'OPTIONS') {
      if (!this.allowedOrigin(request.headers.origin)) return this.sendJson(response, 403, { error: 'Origin is not allowed' });
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
      const [filename, contentType] = STATIC_FILES.get(url.pathname);
      const body = await readFile(path.join(this.staticDirectory, filename));
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' http://127.0.0.1:*; script-src 'self'; style-src 'self'"
      });
      response.end(body);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (!url.pathname.startsWith('/api/')) return this.sendJson(response, 404, { error: 'Not found' });
    if (!this.allowedOrigin(request.headers.origin)) return this.sendJson(response, 403, { error: 'Origin is not allowed' });
    if (!bearerMatches(request.headers.authorization, this.token)) {
      return this.sendJson(response, 401, { error: 'Invalid local service token' });
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return this.sendJson(response, 200, this.worker.state());
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      response.write(`data: ${JSON.stringify(this.worker.state())}\n\n`);
      this.clients.add(response);
      request.once('close', () => this.clients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await readJson(request);
      if (!Array.isArray(body.urls) || body.urls.length === 0 || body.urls.length > 100) {
        throw new Error('urls must contain between 1 and 100 items');
      }
      const result = await this.worker.enqueue(body.urls);
      return this.sendJson(response, 202, {
        added: result.added.map((task) => task.id),
        existing: result.existing.map((task) => task.id),
        refreshed: (result.refreshed || []).map((task) => task.id),
        state: this.worker.state()
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/retry-failed') {
      const tasks = await this.worker.retryFailed();
      return this.sendJson(response, 202, { retried: tasks.map((task) => task.id), state: this.worker.state() });
    }
    const retryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
    if (request.method === 'POST' && retryMatch) {
      const task = await this.worker.retry(decodeURIComponent(retryMatch[1]));
      return this.sendJson(response, 202, { retried: task.id, state: this.worker.state() });
    }
    const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const task = await this.worker.cancel(decodeURIComponent(cancelMatch[1]));
      return this.sendJson(response, 202, { cancelling: task.id, state: this.worker.state() });
    }
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (request.method === 'DELETE' && taskMatch) {
      const task = await this.worker.remove(decodeURIComponent(taskMatch[1]));
      return this.sendJson(response, 200, { deleted: task.id, state: this.worker.state() });
    }
    if (request.method === 'POST' && url.pathname === '/api/queue/pause') {
      this.worker.pause();
      return this.sendJson(response, 200, this.worker.state());
    }
    if (request.method === 'POST' && url.pathname === '/api/queue/resume') {
      this.worker.resume();
      return this.sendJson(response, 200, this.worker.state());
    }
    if (request.method === 'POST' && url.pathname === '/api/settings/browser') {
      const body = await readJson(request);
      const headless = await this.worker.setBrowserHeadless(body.headless);
      return this.sendJson(response, 200, { headless, state: this.worker.state() });
    }
    if (request.method === 'GET' && url.pathname === '/api/plugins/installed') {
      if (!this.pluginManager) throw new Error('插件管理未配置');
      return this.sendJson(response, 200, await this.pluginManager.installed());
    }
    if (request.method === 'POST' && url.pathname === '/api/plugins/enabled') {
      if (!this.pluginManager) throw new Error('插件管理未配置');
      const body = await readJson(request);
      const result = await this.worker.withPluginOperation('正在保存插件配置',
        () => this.pluginManager.setEnabled(body));
      return this.sendJson(response, 200, result);
    }
    if (request.method === 'POST' && url.pathname === '/api/service/reload') {
      if (!this.pluginManager) throw new Error('插件管理未配置');
      const state = await this.worker.reloadService(() => this.pluginManager.loadRuntime());
      return this.sendJson(response, 200, { state });
    }
    if (request.method === 'POST' && ['/api/plugins/repository', '/api/plugins/install'].includes(url.pathname)) {
      if (!this.pluginManager) throw new Error('插件管理未配置');
      const body = await readJson(request);
      const browsing = url.pathname.endsWith('/repository');
      const result = await this.worker.withPluginOperation(browsing ? '正在读取插件列表' : '正在安装插件',
        () => browsing ? this.pluginManager.browse(body) : this.pluginManager.install(body));
      return this.sendJson(response, 200, result);
    }
    const loginMatch = url.pathname.match(/^\/api\/(?:plugins\/)?([^/]+)\/login(\/finish)?$/);
    if (request.method === 'POST' && loginMatch) {
      const pluginId = decodeURIComponent(loginMatch[1]);
      if (loginMatch[2]) await this.worker.finishLogin(pluginId);
      else await this.worker.openLogin(pluginId);
      return this.sendJson(response, 200, { state: this.worker.state() });
    }
    if (request.method === 'POST' && url.pathname === '/api/open-directory') {
      const body = await readJson(request);
      const task = this.worker.state().tasks.find((candidate) => candidate.id === body.taskId);
      const directory = task?.summary?.directory && path.resolve(task.summary.directory);
      const relative = directory && path.relative(this.downloadRoot, directory);
      if (!directory || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Task does not have a valid archive directory');
      }
      const child = spawn(process.platform === 'win32' ? 'explorer.exe' : '/usr/bin/open', [directory], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      await once(child, 'spawn');
      child.unref();
      return this.sendJson(response, 202, { opened: true });
    }

    return this.sendJson(response, 404, { error: 'Not found' });
  }

  broadcast(state) {
    const event = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of this.clients) client.write(event);
  }

  sendJson(response, status, payload) {
    if (response.headersSent) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(`${JSON.stringify(payload)}\n`);
  }
}
