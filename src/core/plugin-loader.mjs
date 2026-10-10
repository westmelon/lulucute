import path from 'node:path';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Aria2Downloader } from './aria2-downloader.mjs';
import { ExternalDownloadMonitor } from './external-download-monitor.mjs';
import { allocateAvailablePath, sanitizeSegment } from './path-policy.mjs';
import { pluginToolPaths, validatePluginTools } from './plugin-tools.mjs';

export const pluginServices = Object.freeze({
  Aria2Downloader, ExternalDownloadMonitor, allocateAvailablePath, sanitizeSegment
});

export const PLUGIN_API_VERSION = 1;
const REQUIRED_METHODS = {
  forum: ['match', 'inspect', 'reply', 'extractResources'],
  provider: ['match', 'resolve']
};

export async function findPluginManifests(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === 'plugin.json')) {
    return [path.join(root, 'plugin.json')];
  }
  const nested = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== '.tools')
    .map((entry) => findPluginManifests(path.join(root, entry.name))));
  return nested.flat();
}

function validateManifest(manifest, manifestPath, { allowUnsupportedApi = false } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Plugin manifest must be an object: ${manifestPath}`);
  }
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) {
    throw new Error(`Plugin id is invalid in ${manifestPath}`);
  }
  if (manifest.name !== undefined && (typeof manifest.name !== 'string' || !manifest.name.trim())) {
    throw new Error(`Plugin ${manifest.id} name must be a non-empty string`);
  }
  if (!REQUIRED_METHODS[manifest.type] && manifest.type !== 'bundle') {
    throw new Error(`Plugin ${manifest.id} has unsupported type: ${manifest.type}`);
  }
  if (!Number.isInteger(manifest.apiVersion) || manifest.apiVersion < 1
    || (!allowUnsupportedApi && manifest.apiVersion !== PLUGIN_API_VERSION)) {
    throw new Error(`Plugin ${manifest.id} requires unsupported API version: ${manifest.apiVersion}`);
  }
  if (typeof manifest.entry !== 'string' || !manifest.entry.trim()) {
    throw new Error(`Plugin ${manifest.id} entry is required`);
  }
  if (!/\.(?:mjs|js)$/i.test(manifest.entry)) {
    throw new Error(`Plugin ${manifest.id} entry must be a .mjs or .js file`);
  }
  if (
    !Array.isArray(manifest.hosts)
    || manifest.hosts.length === 0
    || manifest.hosts.some((host) => typeof host !== 'string' || !/^(?:\*\.)?[a-z0-9.-]+$/i.test(host))
  ) {
    throw new Error(`Plugin ${manifest.id} hosts must be an array of host names`);
  }
  if (manifest.loginUrl !== undefined) {
    const url = new URL(manifest.loginUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error(`Plugin ${manifest.id} loginUrl must be an HTTP(S) URL`);
    }
  }
  if (manifest.actions !== undefined) {
    if (!Array.isArray(manifest.actions)) throw new Error(`Plugin ${manifest.id} actions must be an array`);
    const ids = new Set();
    for (const action of manifest.actions) {
      if (!action?.id || ids.has(action.id) || typeof action.label !== 'string' || !action.label.trim()
        || typeof action.pathPattern !== 'string' || !action.pathPattern
        || !action.query || typeof action.query !== 'object' || Array.isArray(action.query)
        || !Object.keys(action.query).length || Object.values(action.query).some((value) => typeof value !== 'string')
        || (action.taskLabel !== undefined && typeof action.taskLabel !== 'string')) {
        throw new Error(`Plugin ${manifest.id} has an invalid action`);
      }
      new RegExp(action.pathPattern);
      ids.add(action.id);
    }
  }
  validatePluginTools(manifest.tools);
  return manifest;
}

async function resolvePluginEntry(manifest, manifestPath) {
  const directory = await realpath(path.dirname(manifestPath));
  const entry = await realpath(path.resolve(directory, manifest.entry));
  const relative = path.relative(directory, entry);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Plugin ${manifest.id} entry must stay inside its plugin directory`);
  }
  return entry;
}

// 安装时仅检查包结构，不导入或执行插件。
export async function inspectPluginPackage(directory, options) {
  const manifestPath = path.join(directory, 'plugin.json');
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')), manifestPath, options);
  await resolvePluginEntry(manifest, manifestPath);
  return manifest;
}

function validateAdapter(adapter, manifest, type = manifest.type) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`Plugin ${manifest.id} did not create an adapter object`);
  }
  for (const method of REQUIRED_METHODS[type]) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`Plugin ${manifest.id} adapter is missing ${method}()`);
    }
  }
  for (const hook of ['normalizeUrl', 'shouldRefresh']) {
    if (adapter[hook] !== undefined && typeof adapter[hook] !== 'function') {
      throw new Error(`Plugin ${manifest.id} ${hook} must be a function`);
    }
  }
  return adapter;
}

async function loadAdapter(manifestPath, config) {
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    manifestPath
  );
  const entry = await resolvePluginEntry(manifest, manifestPath);
  const module = await import(pathToFileURL(entry).href);
  const createAdapter = (manifest.type === 'bundle' ? module.createAdapters : module.createAdapter) || module.default;
  if (typeof createAdapter !== 'function') {
    throw new Error(`Plugin ${manifest.id} must export ${manifest.type === 'bundle' ? 'createAdapters' : 'createAdapter'}() or a default factory`);
  }
  const toolPaths = await pluginToolPaths(path.dirname(manifestPath), manifest.tools);
  const result = await createAdapter({ config, manifest: Object.freeze({ ...manifest }),
    services: Object.freeze({ ...pluginServices, toolPaths }) });
  if (manifest.type !== 'bundle') {
    const adapter = validateAdapter(result, manifest);
    return { manifest, forums: manifest.type === 'forum' ? [adapter] : [],
      providers: manifest.type === 'provider' ? [adapter] : [] };
  }
  if (!result || (result.forums !== undefined && !Array.isArray(result.forums))
    || (result.providers !== undefined && !Array.isArray(result.providers))) {
    throw new Error(`Plugin ${manifest.id} must return forums/providers arrays`);
  }
  const forums = (result.forums || []).map((adapter) => validateAdapter(adapter, manifest, 'forum'));
  const providers = (result.providers || []).map((adapter) => validateAdapter(adapter, manifest, 'provider'));
  if (!forums.length && !providers.length) throw new Error(`Plugin ${manifest.id} did not provide any adapters`);
  return { manifest, forums, providers };
}

export async function loadLocalPlugins(config, { log = console.error } = {}) {
  const enabled = new Set(config.plugins?.enabled || []);
  const loaded = { forums: [], providers: [], manifests: [], catalog: [], sites: [] };

  const manifests = (await Promise.all(
    (config.plugins?.directories || []).map((directory) => findPluginManifests(directory))
  )).flat();
  const discovered = new Map();
  for (const manifestPath of manifests) {
    const manifest = validateManifest(
      JSON.parse(await readFile(manifestPath, 'utf8')),
      manifestPath
    );
    if (discovered.has(manifest.id)) {
      throw new Error(`Duplicate plugin id ${manifest.id}: ${manifestPath}`);
    }
    discovered.set(manifest.id, manifestPath);
    loaded.catalog.push(manifest);
  }

  for (const id of enabled) {
    const manifestPath = discovered.get(id);
    if (!manifestPath) throw new Error(`Enabled plugin was not found: ${id}`);
    const { manifest, forums, providers } = await loadAdapter(manifestPath, config);
    loaded.forums.push(...forums);
    loaded.providers.push(...providers);
    loaded.manifests.push(manifest);
    if (forums.length) loaded.sites.push({ id: manifest.id, name: manifest.name || manifest.id,
      hosts: manifest.hosts, ...(manifest.loginUrl ? { loginUrl: manifest.loginUrl } : {}),
      ...(manifest.actions ? { actions: manifest.actions } : {}) });
    log(`[resource-downloader] Loaded ${manifest.type} plugin: ${manifest.id}`);
  }
  return loaded;
}
