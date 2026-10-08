import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createWorkflow } from '../src/app-runtime.mjs';
import { loadLocalPlugins } from '../src/core/plugin-loader.mjs';

async function writePlugin(root, manifest, source) {
  const directory = path.join(root, manifest.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify(manifest));
  if (source) await writeFile(path.join(directory, 'index.mjs'), source);
  return directory;
}

const forumSource = `
export function createAdapter() {
  return {
    match: (url) => new URL(url).hostname === 'forum.example.com',
    inspect: async () => ({ locked: false, source: {} }),
    reply: async () => {},
    extractResources: async () => []
  };
}
`;

test('loadLocalPlugins loads enabled forum adapters into the workflow', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePlugin(root, {
    id: 'example-forum',
    type: 'forum',
    apiVersion: 1,
    entry: './index.mjs',
    hosts: ['forum.example.com']
  }, forumSource);
  const logs = [];
  const plugins = await loadLocalPlugins({
    plugins: { directories: [root], enabled: ['example-forum'] }
  }, { log: (message) => logs.push(message) });

  assert.equal(plugins.forums.length, 1);
  assert.equal(plugins.providers.length, 0);
  assert.equal(plugins.manifests[0].id, 'example-forum');
  assert.equal(plugins.forums[0].match('https://forum.example.com/thread/1'), true);
  assert.match(logs[0], /Loaded forum plugin: example-forum/);

  const workflow = createWorkflow({
    downloadRoot: root,
    workflow: {
      baiduDownloadTimeoutMs: 10_000,
      baiduDownloadPollIntervalMs: 100,
      baiduDownloadQuietPeriodMs: 1_000
    }
  }, plugins);
  assert.equal(
    workflow.registry.forumFor('https://forum.example.com/thread/1'),
    plugins.forums[0]
  );
});

test('loadLocalPlugins does not import disabled plugins', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-disabled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePlugin(root, {
    id: 'disabled-plugin',
    type: 'forum',
    apiVersion: 1,
    entry: './index.mjs',
    hosts: ['forum.example.com']
  }, 'throw new Error("disabled plugin was imported");');

  const plugins = await loadLocalPlugins({
    plugins: { directories: [root], enabled: [] }
  }, { log: () => {} });

  assert.deepEqual(plugins.forums, []);
  assert.deepEqual(plugins.providers, []);
  assert.deepEqual(plugins.manifests, []);
  assert.equal(plugins.catalog[0].id, 'disabled-plugin');
  assert.deepEqual(plugins.sites, []);
});

test('loadLocalPlugins rejects entries outside the plugin directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await writePlugin(root, {
    id: 'unsafe-plugin',
    type: 'forum',
    apiVersion: 1,
    entry: '../outside.mjs',
    hosts: ['forum.example.com']
  });
  await writeFile(path.join(root, 'outside.mjs'), forumSource);

  await assert.rejects(
    () => loadLocalPlugins({
      plugins: { directories: [directory], enabled: ['unsafe-plugin'] }
    }, { log: () => {} }),
    /entry must stay inside its plugin directory/
  );
});

test('loadLocalPlugins rejects adapters that do not implement their contract', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePlugin(root, {
    id: 'incomplete-forum',
    type: 'forum',
    apiVersion: 1,
    entry: './index.mjs',
    hosts: ['forum.example.com']
  }, 'export function createAdapter() { return { match: () => true }; }');

  await assert.rejects(
    () => loadLocalPlugins({
      plugins: { directories: [root], enabled: ['incomplete-forum'] }
    }, { log: () => {} }),
    /adapter is missing inspect\(\)/
  );
});

test('loadLocalPlugins rejects enabled plugin ids that are not installed', async () => {
  await assert.rejects(
    () => loadLocalPlugins({
      plugins: { directories: [], enabled: ['missing-plugin'] }
    }, { log: () => {} }),
    /Enabled plugin was not found: missing-plugin/
  );
});

test('bundle hooks drive normalization, incremental refresh and resource completion for a new site', async (t) => {
  const { TaskQueue } = await import('../src/core/task-queue.mjs');
  const { runQueuedTasks } = await import('../src/core/batch-runner.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePlugin(root, { id: 'custom-site', type: 'bundle', apiVersion: 1, entry: './index.mjs',
    hosts: ['site.example.com'], loginUrl: 'https://site.example.com/login' }, `
    export function createAdapters() {
      return { forums: [{ match: (value) => new URL(value).hostname === 'site.example.com',
        normalizeUrl: (value) => { const url = new URL(value); url.searchParams.delete('cursor'); return url.toString(); },
        shouldRefresh: () => true,
        inspect: async () => ({ locked: false, source: { forum: 'Custom', section: 'Music', threadTitle: 'Album' } }),
        reply: async () => {}, extractResources: async (page) => page.resources }],
        providers: [{ match: (resource) => resource.provider === 'custom-site',
          resolve: async (_context, resource) => ({ status: 'downloaded', resource, download: { path: '/fixture.mp4' } }) }] };
    }
  `);
  const config = { downloadRoot: root, workflow: {}, plugins: { directories: [root], enabled: ['custom-site'] } };
  const plugins = await loadLocalPlugins(config, { log: () => {} });
  const queue = await new TaskQueue(path.join(root, 'tasks.json'), plugins).open();
  t.after(() => queue.close());
  const resources = [{ provider: 'custom-site', url: 'https://site.example.com/one?cursor=old' }];
  const context = { newPage: async () => ({ resources, close: async () => {} }) };
  const workflow = createWorkflow(config, plugins);
  const { added: [task] } = await queue.enqueue(['https://site.example.com/album?cursor=first']);
  await runQueuedTasks({ queue, workflow, context, log: () => {} });
  resources.push({ provider: 'custom-site', url: 'https://site.example.com/two?cursor=new' });
  const refresh = await queue.enqueue(['https://site.example.com/album?cursor=second']);
  assert.equal(refresh.refreshed[0].id, task.id);
  const [result] = await runQueuedTasks({ queue, workflow, context, log: () => {} });
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.summary.downloaded, 1);
  assert.equal(queue.tasks().length, 1);
  assert.equal(queue.hasCompletedResource('https://site.example.com/one?cursor=changed'), true);
  assert.equal(plugins.sites[0].loginUrl, 'https://site.example.com/login');
});

test('bundle plugins reject malformed adapter arrays and invalid capabilities', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-invalid-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { id: 'broken-bundle', type: 'bundle', apiVersion: 1, entry: './index.mjs', hosts: ['example.com'] };
  const directory = await writePlugin(root, manifest, 'export function createAdapters() { return { forums: {} }; }');
  const config = { plugins: { directories: [root], enabled: [manifest.id] } };
  await assert.rejects(() => loadLocalPlugins(config), /forums\/providers arrays/);
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({ ...manifest, loginUrl: 'file:///tmp/login' }));
  await assert.rejects(() => loadLocalPlugins(config), /loginUrl/);
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({ ...manifest, actions: [{ id: 'bad', label: 'Bad', pathPattern: '[', query: { p: 'all' } }] }));
  await assert.rejects(() => loadLocalPlugins(config), /regular expression/i);
});

