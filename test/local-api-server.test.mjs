import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { LocalApiServer } from '../src/core/local-api-server.mjs';

function createResponse() {
  return {
    headersSent: false,
    status: null,
    body: '',
    setHeader() {},
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(body = '') {
      this.body += body;
    }
  };
}

test('LocalApiServer authenticates API calls and serves the dashboard', async (t) => {
  let listener;
  let headless = false;
  const calls = [];
  const worker = {
    state: () => ({ paused: false, running: false, browser: { headless }, tasks: [] }),
    subscribe: (next) => {
      listener = next;
      return () => { listener = null; };
    },
    enqueue: async (urls) => {
      calls.push(urls);
      return { added: [{ id: 'new' }], existing: [] };
    },
    remove: async (id) => {
      calls.push(['remove', id]);
      return { id };
    },
    cancel: async (id) => {
      calls.push(['cancel', id]);
      return { id };
    },
    setBrowserHeadless: async (value) => {
      headless = value;
      calls.push(['headless', value]);
      return value;
    }
  };
  const staticDirectory = fileURLToPath(new URL('../extension/', import.meta.url));
  const server = new LocalApiServer({
    worker,
    token: 'test-token-with-at-least-32-characters',
    downloadRoot: path.resolve('/tmp/downloads'),
    staticDirectory,
    port: 0,
    log: () => {}
  });
  t.after(() => server.close());
  const port = await server.listen();
  const origin = `http://127.0.0.1:${port}`;

  const dashboard = await fetch(`${origin}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /lulucute/);

  const unauthorized = await fetch(`${origin}/api/state`);
  assert.equal(unauthorized.status, 401);

  const headers = {
    Authorization: 'Bearer test-token-with-at-least-32-characters',
    'Content-Type': 'application/json'
  };
  const state = await fetch(`${origin}/api/state`, { headers });
  assert.deepEqual(await state.json(), {
    paused: false,
    running: false,
    browser: { headless: false },
    tasks: []
  });

  const added = await fetch(`${origin}/api/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ urls: ['https://www.hifiti.com/thread-1.htm'] })
  });
  assert.equal(added.status, 202);
  assert.deepEqual(calls, [['https://www.hifiti.com/thread-1.htm']]);

  const deleted = await fetch(`${origin}/api/tasks/task-1`, { method: 'DELETE', headers });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted, 'task-1');
  assert.deepEqual(calls, [['https://www.hifiti.com/thread-1.htm'], ['remove', 'task-1']]);

  const cancelled = await fetch(`${origin}/api/tasks/task-2/cancel`, { method: 'POST', headers });
  assert.equal(cancelled.status, 202);
  assert.equal((await cancelled.json()).cancelling, 'task-2');
  assert.deepEqual(calls.at(-1), ['cancel', 'task-2']);

  const browserSettings = await fetch(`${origin}/api/settings/browser`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ headless: true })
  });
  assert.equal(browserSettings.status, 200);
  assert.deepEqual(await browserSettings.json(), {
    headless: true,
    state: { paused: false, running: false, browser: { headless: true }, tasks: [] }
  });
  assert.deepEqual(calls.at(-1), ['headless', true]);
  assert.equal(typeof listener, 'function');
});

test('LocalApiServer updates browser mode without opening a network listener', async (t) => {
  let headless = false;
  const worker = {
    state: () => ({ paused: false, running: false, browser: { headless }, tasks: [] }),
    subscribe: () => () => {},
    setBrowserHeadless: async (value) => {
      if (typeof value !== 'boolean') throw new Error('headless must be a boolean');
      headless = value;
      return value;
    }
  };
  const token = 'test-token-with-at-least-32-characters';
  const server = new LocalApiServer({
    worker,
    token,
    downloadRoot: path.resolve('/tmp/downloads'),
    staticDirectory: path.resolve('extension'),
    log: () => {}
  });
  t.after(() => server.unsubscribe());
  const request = Readable.from([Buffer.from(JSON.stringify({ headless: true }))]);
  request.method = 'POST';
  request.url = '/api/settings/browser';
  request.headers = { authorization: `Bearer ${token}` };
  const response = createResponse();

  await server.handle(request, response);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    headless: true,
    state: { paused: false, running: false, browser: { headless: true }, tasks: [] }
  });
});

test('Bilibili login API requires the existing token and reports open and finished states', async (t) => {
  let loginStatus = null;
  let opened = 0;
  const token = 'test-token-with-at-least-32-characters';
  const server = new LocalApiServer({
    worker: {
      state: () => ({ browser: { headless: true, loginStatus } }),
      subscribe: () => () => {},
      openLogin: async (id) => { assert.equal(id, 'bilibili'); loginStatus = 'open'; opened += 1; },
      finishLogin: async (id) => { assert.equal(id, 'bilibili'); loginStatus = null; }
    }, token, downloadRoot: '/tmp/downloads', staticDirectory: path.resolve('extension'), log: () => {}
  });
  t.after(() => server.unsubscribe());
  for (const [route, authenticated, expectedStatus] of [
    ['/api/bilibili/login', false, 401],
    ['/api/bilibili/login', true, 200],
    ['/api/bilibili/login/finish', false, 401],
    ['/api/bilibili/login/finish', true, 200],
    ['/api/plugins/bilibili/login', true, 200],
    ['/api/plugins/bilibili/login/finish', true, 200]
  ]) {
    const request = Readable.from([]);
    request.method = 'POST';
    request.url = route;
    request.headers = authenticated ? { authorization: `Bearer ${token}` } : {};
    const response = createResponse();
    await server.handle(request, response);
    assert.equal(response.status, expectedStatus);
    if (authenticated) assert.equal(JSON.parse(response.body).state.browser.loginStatus,
      route.endsWith('/finish') ? null : 'open');
  }
  assert.equal(opened, 2);
});

test('installed plugin API checks token and origin and permits read-only listing during downloads', async (t) => {
  let calls = 0;
  const plugins = [{ id: 'sample', name: '示例下载', type: 'provider', enabled: false }];
  const token = 'local-plugin-token';
  const server = new LocalApiServer({ token, downloadRoot: '/tmp/downloads', staticDirectory: path.resolve('extension'),
    worker: { subscribe: () => () => {}, state: () => ({ running: true }) },
    pluginManager: { installed: async () => { calls += 1; return { plugins }; } } });
  t.after(() => server.unsubscribe());
  for (const [headers, expected] of [[{}, 401],
    [{ authorization: `Bearer ${token}`, origin: 'https://untrusted.example' }, 403],
    [{ authorization: `Bearer ${token}`, origin: 'chrome-extension://sample' }, 200]]) {
    const request = Readable.from([]);
    Object.assign(request, { method: 'GET', url: '/api/plugins/installed', headers });
    const response = createResponse();
    await server.handle(request, response);
    assert.equal(response.status, expected);
    if (expected === 200) assert.deepEqual(JSON.parse(response.body), { plugins });
  }
  assert.equal(calls, 1);
});

test('plugin mutations and service reload require authentication and allowed origin before performing operations', async (t) => {
  const calls = [];
  const token = 'local-plugin-token';
  const server = new LocalApiServer({ token, downloadRoot: '/tmp/downloads', staticDirectory: path.resolve('extension'),
    worker: { subscribe: () => () => {}, withPluginOperation: async (label, action) => { calls.push(label); return action(); },
      reloadService: async (load) => { calls.push('reload'); await load(); return { pluginsRestartRequired: false }; } },
    pluginManager: { browse: async (body) => ({ repository: body.repository }),
      setEnabled: async (body) => ({ id: body.id, enabled: body.enabled, restartRequired: true }),
      loadRuntime: async () => ({}),
      install: async (body) => ({ id: body.id, restartRequired: true }) } });
  t.after(() => server.unsubscribe());
  for (const route of ['/api/plugins/repository', '/api/plugins/install', '/api/plugins/enabled', '/api/service/reload']) {
    for (const [headers, expected] of [[{}, 401],
      [{ authorization: `Bearer ${token}`, origin: 'https://untrusted.example' }, 403],
      [{ authorization: `Bearer ${token}` }, 200]]) {
      const request = Readable.from([Buffer.from(JSON.stringify({ repository: '/tmp/repo', id: 'sample', enabled: false }))]);
      Object.assign(request, { method: 'POST', url: route, headers });
      const response = createResponse();
      await server.handle(request, response);
      assert.equal(response.status, expected);
      if (expected === 200 && route.endsWith('/enabled')) assert.deepEqual(JSON.parse(response.body),
        { id: 'sample', enabled: false, restartRequired: true });
      if (expected === 200 && route.endsWith('/reload')) assert.deepEqual(JSON.parse(response.body),
        { state: { pluginsRestartRequired: false } });
    }
  }
  assert.deepEqual(calls, ['正在读取插件列表', '正在安装插件', '正在保存插件配置', 'reload']);
});
