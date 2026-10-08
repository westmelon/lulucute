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
  const directory = path.join(root, 'installed');
  const options = { id: 'sample', directory, repository, ref: 'v1' };
  async function loadedVersion() {
    const loaded = await loadLocalPlugins({ plugins: { directories: [directory], enabled: ['sample'] } }, { log: () => {} });
    return (await loaded.providers[0].resolve()).version;
  }
  return { root, plugin, git, version, directory, options, loadedVersion };
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
  await assert.rejects(() => managePlugin({ ...f.options, action: 'update', ref: 'missing-tag' }), /Git 操作失败/);
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
    '--repository', f.options.repository, '--ref', 'v1']);
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
  await writeFile(path.join(f.options.repository, 'repository.json'), JSON.stringify(catalog));
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
  await rm(path.join(f.options.repository, 'repository.json'));
  await symlink('plugins/sample/plugin.json', path.join(f.options.repository, 'repository.json'));
  await f.git('add', '.');
  await f.git('commit', '--quiet', '-m', 'linked index');
  await assert.rejects(() => readPluginRepository({ repository: f.options.repository }), /普通文件/);
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
