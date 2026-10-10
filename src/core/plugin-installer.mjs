import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { inspectPluginPackage, loadLocalPlugins, PLUGIN_API_VERSION } from './plugin-loader.mjs';
import { checkoutRepository, normalizeRepository } from './plugin-source.mjs';
import { installPluginTools } from './plugin-tools.mjs';
import { setPluginEnabled } from '../config.mjs';

const run = promisify(execFile);
const metadataFile = '.resource-hub-install.json';

async function exists(target) {
  try { await lstat(target); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function validatePackage(directory, id, { allowUnsupportedApi = false, checkSyntax = true } = {}) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
      else throw new Error('插件包不能包含符号链接或特殊文件');
    }
  }
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error('插件必须是普通目录');
  await walk(directory);
  const manifest = await inspectPluginPackage(directory, { allowUnsupportedApi });
  if (manifest.id !== id) throw new Error(`插件 ID 不匹配：需要 ${id}，实际为 ${manifest.id}`);
  for (const file of files.filter((file) => checkSyntax && /\.(?:mjs|js)$/.test(file))) {
    try { await run(process.execPath, ['--check', file], { timeout: 10_000, windowsHide: true }); }
    catch { throw new Error(`插件 JavaScript 语法无效：${path.relative(directory, file)}`); }
  }
  return manifest;
}

function validateRef(ref) {
  if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) {
    throw new Error('请通过 --ref 指定版本标签、分支或 commit');
  }
  return ref;
}

export async function readPluginRepository({ repository, ref = 'HEAD' }) {
  repository = normalizeRepository(repository);
  ref = validateRef(ref);
  const staging = await mkdtemp(path.join(tmpdir(), 'resource-hub-catalog-'));
  try {
    const checkout = path.join(staging, 'repository');
    const commit = await checkoutRepository(checkout, repository, ref);
    const indexPath = path.join(checkout, 'repository.json');
    if (!(await exists(indexPath))) throw new Error('仓库缺少 repository.json，请使用符合插件仓库规范的版本');
    if (!(await lstat(indexPath)).isFile()) throw new Error('repository.json 必须是普通文件');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    if (index?.schemaVersion !== 1 || typeof index.name !== 'string' || !index.name.trim()
      || !Array.isArray(index.plugins) || !index.plugins.length || index.plugins.length > 100) {
      throw new Error('repository.json 格式无效：需要 schemaVersion=1、name 和 1–100 个插件');
    }
    if (!(await lstat(path.join(checkout, 'plugins'))).isDirectory()) throw new Error('仓库 plugins 必须是普通目录');
    const ids = new Set();
    const plugins = [];
    for (const item of index.plugins) {
      if (typeof item?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.id) || ids.has(item.id)
        || (item.description !== undefined && typeof item.description !== 'string')) {
        throw new Error('repository.json 插件 ID 无效、重复或说明格式错误');
      }
      ids.add(item.id);
      const manifest = await validatePackage(path.join(checkout, 'plugins', item.id), item.id,
        { allowUnsupportedApi: true, checkSyntax: false });
      plugins.push({ ...manifest, description: item.description || '',
        compatible: manifest.apiVersion === PLUGIN_API_VERSION });
    }
    return { name: index.name, repository, ref, commit, plugins };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function listInstalledPlugins(directories) {
  const plugins = await loadLocalPlugins({ plugins: { directories, enabled: [] } }, { log: () => {} });
  return plugins.catalog;
}

async function replacePackage(staged, target, backupRoot, id) {
  let backup;
  if (await exists(target)) {
    if (!(await lstat(target)).isDirectory()) throw new Error('安装目标必须是普通目录');
    if (await exists(path.dirname(backupRoot)) && !(await lstat(path.dirname(backupRoot))).isDirectory()) {
      throw new Error('插件备份目录不能是符号链接');
    }
    await mkdir(backupRoot, { recursive: true });
    backup = path.join(backupRoot, `${Date.now()}-${randomUUID()}`);
    await rename(target, backup);
  }
  try { await rename(staged, target); }
  catch (error) {
    if (backup) await rename(backup, target);
    throw error;
  }
  return backup;
}

export async function managePlugin({ action, id, directory, repository, ref, configPath }) {
  if (!['install', 'update', 'rollback', 'uninstall'].includes(action)) throw new Error('操作必须为 install、update、rollback 或 uninstall');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id || '')) throw new Error('插件 ID 无效');
  const root = path.resolve(directory);
  const parent = path.dirname(root);
  const target = path.join(root, id);
  // 临时包和备份放在扫描目录之外，避免出现重复插件 ID。
  const backupRoot = path.join(parent, `.${path.basename(root)}-backups`, id);
  const lock = path.join(parent, `.${path.basename(root)}-install.lock`);
  await mkdir(parent, { recursive: true });
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有插件安装操作；若此前进程异常退出，请检查后移除锁目录：${lock}`);
    throw error;
  }
  let staging;
  try {
    await mkdir(root, { recursive: true });
    if (!(await lstat(root)).isDirectory()) throw new Error('插件安装目录不能是符号链接');
    if (action === 'uninstall') {
      if (!(await exists(target))) throw new Error(`插件 ${id} 尚未安装`);
      await validatePackage(target, id, { checkSyntax: false, allowUnsupportedApi: true });
      staging = await mkdtemp(path.join(parent, `.${path.basename(root)}-stage-`));
      const removed = path.join(staging, 'removed');
      const backups = path.join(staging, 'backups');
      await rename(target, removed);
      let movedBackups = false;
      try {
        if (await exists(backupRoot)) {
          if (!(await lstat(path.dirname(backupRoot))).isDirectory()) throw new Error('插件备份目录不能是符号链接');
          if (!(await lstat(backupRoot)).isDirectory()) throw new Error('插件备份目录不能是符号链接');
          await rename(backupRoot, backups);
          movedBackups = true;
        }
        if (configPath) await setPluginEnabled(configPath, id, false);
      } catch (error) {
        if (movedBackups) await rename(backups, backupRoot);
        await rename(removed, target);
        throw error;
      }
      return { id, action, directory: target };
    }
    if (action === 'rollback') {
      const backups = await exists(backupRoot) ? await readdir(backupRoot) : [];
      const candidates = backups.filter((name) => /^\d+-[a-f0-9-]+$/.test(name)).sort().reverse();
      if (!candidates.length) throw new Error(`插件 ${id} 没有可回滚版本`);
      const previous = path.join(backupRoot, candidates[0]);
      await validatePackage(previous, id);
      const backup = await replacePackage(previous, target, backupRoot, id);
      return { id, action, directory: target, backup };
    }
    const installed = await exists(target);
    if (action === 'install' && installed) throw new Error(`插件 ${id} 已安装，请使用 update`);
    if (action === 'update' && !installed) throw new Error(`插件 ${id} 尚未安装，请使用 install`);
    let previous = {};
    if (installed) {
      try { previous = JSON.parse(await readFile(path.join(target, metadataFile), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    repository = normalizeRepository(repository ?? previous.repository);
    ref = ref ?? previous.ref;
    validateRef(ref);
    staging = await mkdtemp(path.join(parent, `.${path.basename(root)}-stage-`));
    const checkout = path.join(staging, 'repository');
    const commit = await checkoutRepository(checkout, repository, ref);
    const source = path.join(checkout, 'plugins', id);
    // 拒绝仓库 plugins 根目录的符号链接。
    if (!(await lstat(path.dirname(source))).isDirectory()) throw new Error('仓库 plugins 必须是普通目录');
    const manifest = await validatePackage(source, id);
    if (await exists(path.join(source, '.tools'))) throw new Error('插件仓库不能包含安装器专用的 .tools 目录');
    const staged = path.join(staging, 'package');
    await cp(source, staged, { recursive: true });
    await installPluginTools(staged, manifest.tools);
    await writeFile(path.join(staged, metadataFile), `${JSON.stringify({ repository, ref, commit,
      installedAt: new Date().toISOString() }, null, 2)}\n`);
    const backup = await replacePackage(staged, target, backupRoot, id);
    return { id, action, name: manifest.name || id, commit, ref, directory: target, backup };
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}
