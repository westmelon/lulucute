import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { managePlugin, readPluginRepository } from '../src/core/plugin-installer.mjs';
import { PluginManager } from '../src/core/plugin-manager.mjs';
import { loadLocalPlugins } from '../src/core/plugin-loader.mjs';
import { normalizeRepository } from '../src/core/plugin-source.mjs';

const run = promisify(execFile);
const manifest = { id: 'sample', type: 'provider', apiVersion: 1, entry: './index.mjs', hosts: ['example.com'] };
const source = (version) => `export function createAdapter() { return {
  match: () => true, resolve: async () => ({ version: ${version} })
}; }`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'source repository');
  const plugin = path.join(repository, 'plugins', 'sample');
  await mkdir(plugin, { recursive: true });
  async function git(...args) {
    return run('git', ['-c', 'user.name=Plugin Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repository });
  }
  await git('init', '--quiet');
  await writeFile(path.join(plugin, 'plugin.json'), JSON.stringify(manifest));
  async function version(ref, text, overrides = {}) {
    await writeFile(path.join(plugin, 'index.mjs'), text);
    await writeFile(path.join(plugin, 'plugin.json'), JSON.stringify({ ...manifest, ...overrides }));
    await git('add', '.');
    await git('commit', '--quiet', '-m', ref);
    await git('tag', ref);
  }
  await version('v1', source(1));
  // 用真实 Git 快照模拟 GitHub 的 API/raw 响应，运行时安装器完全不调用 Git。
  const remote = 'https://github.com/example/plugins';
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (url.hostname === 'api.github.com' && parts[3] === 'commits') {
        const ref = parts[4] || 'HEAD';
        const { stdout } = await git('rev-parse', `${ref}^{commit}`);
        const info = { sha: stdout.trim() };
        return Response.json(parts[4] ? info : [info]);
      }
      if (url.hostname === 'api.github.com' && parts[3] === 'git' && parts[4] === 'trees') {
        const { stdout } = await git('ls-tree', '-r', '-l', parts[5]);
        const tree = stdout.trim().split('\n').filter(Boolean).map((line) => {
          const [info, name] = line.split('\t');
          const [mode, type, sha, size] = info.trim().split(/\s+/);
          return { path: name, mode, type, sha, size: Number(size) };
        });
        return Response.json({ tree, truncated: false });
      }
      if (url.hostname === 'raw.githubusercontent.com') {
        const { stdout } = await run('git', ['show', `${parts[2]}:${parts.slice(3).join('/')}`], {
          cwd: repository, encoding: 'buffer'
        });
        return new Response(stdout);
      }
      throw new Error(`Unexpected test URL: ${url}`);
    } catch { return new Response('', { status: 404 }); }
  });
  const directory = path.join(root, 'installed');
  const options = { id: 'sample', directory, repository: remote, ref: 'v1' };
  async function loadedVersion() {
    const loaded = await loadLocalPlugins({ plugins: { directories: [directory], enabled: ['sample'] } }, { log: () => {} });
    return (await loaded.providers[0].resolve()).version;
  }
  return { root, repository, plugin, git, version, directory, options, loadedVersion };
}

test('install fetches a pinned version, writes provenance and only installs the selected plugin', async (t) => {
  const f = await fixture(t);
  await f.version('v2', source(2));
  const result = await managePlugin({ ...f.options, action: 'install' });
  assert.equal(await f.loadedVersion(), 1);
  assert.equal(result.backup, undefined);
  assert.deepEqual(await readdir(f.directory), ['sample']);
  const metadata = JSON.parse(await readFile(path.join(result.directory, '.resource-hub-install.json'), 'utf8'));
  assert.equal(metadata.ref, 'v1');
  assert.equal(metadata.repository, f.options.repository);
  assert.match(metadata.commit, /^[a-f0-9]{40}$/);
  await assert.rejects(() => managePlugin({ ...f.options, action: 'install' }), /已安装/);
});

test('update preserves old files outside discovery and rollback restores the old commit', async (t) => {
  const f = await fixture(t);
  await managePlugin({ ...f.options, action: 'install' });
  await f.version('v2', source(2));
  const updated = await managePlugin({ id: 'sample', directory: f.directory, action: 'update', ref: 'v2' });
  assert.equal(await readFile(path.join(updated.directory, 'index.mjs'), 'utf8'), source(2));
  assert.equal(await readFile(path.join(updated.backup, 'index.mjs'), 'utf8'), source(1));
  const loaded = await loadLocalPlugins({ plugins: { directories: [f.directory], enabled: [] } });
  assert.equal(loaded.catalog.length, 1);
  const restored = await managePlugin({ id: 'sample', directory: f.directory, action: 'rollback' });
  assert.equal(await readFile(path.join(restored.directory, 'index.mjs'), 'utf8'), source(1));
  assert.equal(JSON.parse(await readFile(path.join(restored.directory, '.resource-hub-install.json'), 'utf8')).ref, 'v1');
  assert.equal(await readFile(path.join(restored.backup, 'index.mjs'), 'utf8'), source(2));
});

test('invalid versions, manifests and syntax leave the installed plugin and backup history intact', async (t) => {
  const f = await fixture(t);
  await managePlugin({ ...f.options, action: 'install' });
  await f.version('bad-api', source(2), { apiVersion: 999 });
  await assert.rejects(() => managePlugin({ ...f.options, action: 'update', ref: 'bad-api' }), /API version/);
  await f.version('bad-id', source(3), { id: 'other' });
  await assert.rejects(() => managePlugin({ ...f.options, action: 'update', ref: 'bad-id' }), /ID 不匹配/);
  await f.version('bad-syntax', 'export function {');
  await assert.rejects(() => managePlugin({ ...f.options, action: 'update', ref: 'bad-syntax' }), /语法无效/);
  await assert.rejects(() => managePlugin({ ...f.options, action: 'update', ref: 'missing-tag' }), /版本不存在/);
  assert.equal(await readFile(path.join(f.directory, 'sample/index.mjs'), 'utf8'), source(1));
  assert.deepEqual((await readdir(f.root)).sort(), ['installed', 'source repository']);
});

test('installation never imports plugin code and rejects links that escape the package', async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'executed');
  await f.version('throws', `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('must not run');`);
  await managePlugin({ ...f.options, action: 'install', ref: 'throws' });
  assert.equal((await readdir(f.root)).includes('executed'), false);
  await symlink('../outside.mjs', path.join(f.plugin, 'escape.mjs'));
  await f.git('add', '.');
  await f.git('commit', '--quiet', '-m', 'symlink');
  await f.git('tag', 'symlink');
  await assert.rejects(() => managePlugin({ ...f.options, action: 'update', ref: 'symlink' }), /符号链接/);
});

test('CLI resolves the install directory beside the config without requiring a download root', async (t) => {
  const f = await fixture(t);
  const config = path.join(f.root, 'config.json');
  await writeFile(config, JSON.stringify({ plugins: { directories: ['./custom/plugins'], enabled: [] } }));
  const before = await readFile(config, 'utf8');
  const script = new URL('../scripts/plugins.mjs', import.meta.url);
  const { stdout } = await run(process.execPath, [script.pathname, 'install', 'sample', '--config', config,
    '--repository', f.repository, '--ref', 'HEAD']);
  assert.match(stdout, /插件文件已就绪/);
  assert.equal(await readFile(path.join(f.root, 'custom/plugins/sample/index.mjs'), 'utf8'), source(1));
  assert.equal(await readFile(config, 'utf8'), before);
});

test('installer serializes mutations and rejects invalid input without touching installed files', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.installed-install.lock'));
  await assert.rejects(() => managePlugin({ ...f.options, action: 'install' }), /已有插件安装操作/);
  await rm(path.join(f.root, '.installed-install.lock'), { recursive: true });
  await assert.rejects(() => managePlugin({ ...f.options, id: '../escape', action: 'install' }), /ID 无效/);
  await assert.rejects(() => managePlugin({ ...f.options, ref: undefined, action: 'install' }), /--ref/);
  await assert.rejects(() => managePlugin({ ...f.options, repository: 'ext::evil', action: 'install' }), /仅支持/);
  await assert.rejects(() => managePlugin({ ...f.options, action: 'rollback' }), /没有可回滚/);
});

async function addCatalog(f, catalog = { schemaVersion: 1, name: '示例仓库',
  plugins: [{ id: 'sample', description: '下载示例' }] }) {
  await writeFile(path.join(f.repository, 'repository.json'), JSON.stringify(catalog));
  await f.version(`catalog-${Date.now()}`, source(1));
}

test('repository discovery reads HEAD without executing code and reports unsupported APIs', async (t) => {
  const f = await fixture(t);
  await addCatalog(f);
  const catalog = await readPluginRepository({ repository: f.options.repository });
  assert.equal(catalog.name, '示例仓库');
  assert.equal(catalog.ref, 'HEAD');
  assert.equal(catalog.plugins[0].description, '下载示例');
  assert.equal(catalog.plugins[0].compatible, true);
  await f.version('future', "throw new Error('should never run')", { apiVersion: 2 });
  const future = await readPluginRepository({ repository: f.options.repository });
  assert.equal(future.plugins[0].compatible, false);
  assert.notEqual(future.commit, catalog.commit);
  const manager = new PluginManager({ config: { plugins: { directories: [f.directory], enabled: [] } } });
  const listed = await manager.browse({ repository: f.options.repository });
  await assert.rejects(() => manager.install({ catalogId: listed.catalogId, id: 'sample' }), /不兼容/);
});

test('catalog rejects missing index, duplicate IDs, traversal and directory links', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => readPluginRepository({ repository: f.options.repository }), /缺少 repository.json/);
  await addCatalog(f, { schemaVersion: 1, name: '仓库', plugins: [{ id: 'sample' }, { id: 'sample' }] });
  await assert.rejects(() => readPluginRepository({ repository: f.options.repository }), /重复/);
  await addCatalog(f, { schemaVersion: 1, name: '仓库', plugins: [{ id: '../escape' }] });
  await assert.rejects(() => readPluginRepository({ repository: f.options.repository }), /ID 无效/);
  await addCatalog(f, { schemaVersion: 1, name: '仓库', plugins: [{ id: 'sample' }] });
  await rm(path.join(f.repository, 'repository.json'));
  await symlink('plugins/sample/plugin.json', path.join(f.repository, 'repository.json'));
  await f.git('add', '.');
  await f.git('commit', '--quiet', '-m', 'linked index');
  await assert.rejects(() => readPluginRepository({ repository: f.options.repository }), /符号链接/);
});

test('page install pins the catalog commit after HEAD moves and preserves config while enabling', async (t) => {
  const f = await fixture(t);
  await addCatalog(f);
  const configPath = path.join(f.root, 'config.json');
  const raw = { downloadRoot: '/example', browser: { headless: true },
    plugins: { directories: ['./installed'], enabled: ['existing'], options: { existing: { key: 1 } } } };
  await writeFile(configPath, JSON.stringify(raw));
  const config = { plugins: { ...raw.plugins, directories: [f.directory], enabled: ['existing'] } };
  const manager = new PluginManager({ config, configPath });
  const catalog = await manager.browse({ repository: f.options.repository });
  assert.equal(catalog.plugins[0].installed, false);
  await f.version('newer', source(2));
  const installed = await manager.install({ catalogId: catalog.catalogId, id: 'sample', enable: true });
  assert.equal(installed.commit, catalog.commit);
  assert.equal(installed.restartRequired, true);
  assert.equal(installed.enabled, true);
  assert.equal(await readFile(path.join(f.directory, 'sample/index.mjs'), 'utf8'), source(1));
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    ...raw, plugins: { ...raw.plugins, enabled: ['existing', 'sample'] }
  });
  const again = await manager.browse({ repository: f.options.repository });
  assert.equal(again.plugins[0].installed, true);
  assert.equal(again.plugins[0].enabled, true);
  await assert.rejects(() => manager.install({ catalogId: catalog.catalogId, id: 'sample' }), /已安装/);
  await assert.rejects(() => manager.install({ catalogId: catalog.catalogId, id: 'other' }), /不在列表/);
  await assert.rejects(() => manager.install({ catalogId: 'expired', id: 'sample' }), /失效/);
});

test('installed list includes disabled plugins and configured enabled status without executing entries', async (t) => {
  const f = await fixture(t);
  const config = { plugins: { directories: [f.directory], enabled: [] } };
  const manager = new PluginManager({ config });
  assert.deepEqual(await manager.installed(), { plugins: [] });
  const marker = path.join(f.root, 'executed');
  await f.version('listed', `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('must not run');`, { name: '示例下载' });
  await managePlugin({ ...f.options, action: 'install', ref: 'listed' });
  const expected = { ...manifest, name: '示例下载', enabled: false };
  assert.deepEqual(await manager.installed(), { plugins: [expected] });
  config.plugins.enabled.push('sample');
  assert.deepEqual(await manager.installed(), { plugins: [{ ...expected, enabled: true }] });
  assert.equal((await readdir(f.root)).includes('executed'), false);
});

test('page installer reports config persistence failures without losing installed files', async (t) => {
  const f = await fixture(t);
  await addCatalog(f);
  const manager = new PluginManager({ config: { plugins: { directories: [f.directory], enabled: [] } },
    configPath: path.join(f.root, 'missing/config.json') });
  const catalog = await manager.browse({ repository: f.options.repository });
  const installed = await manager.install({ catalogId: catalog.catalogId, id: 'sample', enable: true });
  assert.equal(installed.enabled, false);
  assert.match(installed.warning, /启用配置保存失败/);
  assert.equal(await readFile(path.join(f.directory, 'sample/index.mjs'), 'utf8'), source(1));
});

test('page enable and disable preserve other configuration, plugin files and enabled order', async (t) => {
  const f = await fixture(t);
  await managePlugin({ ...f.options, action: 'install' });
  const configPath = path.join(f.root, 'config.json');
  const raw = { browser: { headless: true }, plugins: { directories: ['./installed'],
    enabled: ['first', 'sample', 'last'], options: { sample: { key: 1 } } } };
  await writeFile(configPath, JSON.stringify(raw));
  const config = { plugins: { ...raw.plugins, directories: [f.directory] } };
  const manager = new PluginManager({ config, configPath });
  assert.deepEqual(await manager.setEnabled({ id: 'sample', enabled: false }),
    { id: 'sample', enabled: false, restartRequired: true });
  assert.deepEqual(config.plugins.enabled, ['first', 'last']);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')),
    { ...raw, plugins: { ...raw.plugins, enabled: ['first', 'last'] } });
  assert.equal((await manager.installed()).plugins[0].enabled, false);
  assert.equal(await readFile(path.join(f.directory, 'sample/index.mjs'), 'utf8'), source(1));
  await manager.setEnabled({ id: 'sample', enabled: true });
  assert.deepEqual(config.plugins.enabled, ['first', 'last', 'sample']);
  const saved = await readFile(configPath, 'utf8');
  assert.equal((await manager.setEnabled({ id: 'sample', enabled: true })).restartRequired, false);
  assert.equal(await readFile(configPath, 'utf8'), saved);
  await assert.rejects(() => manager.setEnabled({ id: 'missing', enabled: true }), /未安装/);
  await assert.rejects(() => manager.setEnabled({ id: '../sample', enabled: false }), /ID 无效/);
  await assert.rejects(() => manager.setEnabled({ id: 'sample', enabled: 'false' }), /布尔值/);
  assert.equal(await readFile(configPath, 'utf8'), saved);
  manager.configPath = path.join(f.root, 'missing/config.json');
  await assert.rejects(() => manager.setEnabled({ id: 'sample', enabled: false }), /ENOENT/);
  assert.deepEqual(config.plugins.enabled, ['first', 'last', 'sample']);
});

test('raw index downloads nested imports and fixes every request to the resolved commit', async (t) => {
  const f = await fixture(t);
  await addCatalog(f);
  await mkdir(path.join(f.plugin, 'lib'));
  await writeFile(path.join(f.plugin, 'lib', 'value.mjs'), 'export const version = 3;');
  await f.version('raw', `import { version } from './lib/value.mjs';
    export function createAdapter() { return { match: () => true, resolve: async () => ({ version }) }; }`);
  const repository = 'https://raw.githubusercontent.com/example/plugins/HEAD/repository.json';
  const catalog = await readPluginRepository({ repository });
  await f.version('changed', source(4));
  const result = await managePlugin({ ...f.options, repository, ref: catalog.commit, action: 'install' });
  assert.equal(result.commit, catalog.commit);
  assert.equal(await f.loadedVersion(), 3);
  const urls = globalThis.fetch.mock.calls.map((call) => call.arguments[0]);
  assert.ok(urls.filter((url) => url.includes('raw.githubusercontent.com')).every((url) => /\/[a-f0-9]{40}\//.test(url)));
});

test('raw checksum failures and rate limits preserve installed files and remove staging', async (t) => {
  const f = await fixture(t);
  await managePlugin({ ...f.options, action: 'install' });
  await f.version('changed', source(2));
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url) => url.includes('raw.githubusercontent.com')
    ? new Response('corrupted') : originalFetch(url));
  await assert.rejects(() => managePlugin({ ...f.options, ref: 'changed', action: 'update' }), /校验失败/);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await assert.rejects(() => managePlugin({ ...f.options, ref: 'changed', action: 'update' }), /请求次数/);
  assert.equal(await readFile(path.join(f.directory, 'sample', 'index.mjs'), 'utf8'), source(1));
  assert.deepEqual((await readdir(f.root)).sort(), ['installed', 'source repository']);
});

test('unsafe GitHub tree paths and truncated trees are rejected before writing files', async (t) => {
  const f = await fixture(t);
  for (const unsafe of ['plugins/../outside.mjs', 'plugins/sample/CON.txt', 'plugins/sample/name:stream', 'plugins/sample/name\\escape']) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ tree: [{
      path: unsafe, mode: '100644', type: 'blob', size: 1, sha: '0'.repeat(40)
    }] }));
    await assert.rejects(() => managePlugin({ ...f.options, ref: '0'.repeat(40), action: 'install' }), /路径无效/);
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ tree: [], truncated: true }));
  await assert.rejects(() => managePlugin({ ...f.options, ref: '0'.repeat(40), action: 'install' }), /文件列表不完整/);
});

test('local directory installs need no Git and reject stale catalog fingerprints', async (t) => {
  const f = await fixture(t);
  await addCatalog(f);
  const catalog = await readPluginRepository({ repository: f.repository });
  await writeFile(path.join(f.plugin, 'index.mjs'), source(2));
  await assert.rejects(() => managePlugin({ ...f.options, repository: f.repository, ref: catalog.commit, action: 'install' }), /内容已变化/);
  await managePlugin({ ...f.options, repository: f.repository, ref: 'HEAD', action: 'install' });
  assert.equal(await f.loadedVersion(), 2);
});

test('repository addresses reject SSH, credentials and non-GitHub destinations', () => {
  assert.equal(normalizeRepository('https://github.com/example/plugins.git'), 'https://github.com/example/plugins');
  for (const value of ['git@example.com:plugins.git', 'ssh://git@github.com/example/plugins',
    'https://token@github.com/example/plugins', 'https://example.com/repository.json',
    'https://github.com/example/plugins?token=secret']) {
    assert.throws(() => normalizeRepository(value), /仅支持/);
  }
});
