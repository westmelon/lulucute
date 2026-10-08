import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const EXAMPLE_DOWNLOAD_ROOT = '/absolute/path/to/ResourceHub';

export function validateDownloadRootPath(downloadRoot) {
  if (!downloadRoot || !path.isAbsolute(downloadRoot)) {
    throw new Error('config.downloadRoot must be an absolute path');
  }
  if (path.normalize(downloadRoot) === EXAMPLE_DOWNLOAD_ROOT) {
    throw new Error(
      'config.downloadRoot still contains the example path; replace it with a real writable directory'
    );
  }
  return path.resolve(downloadRoot);
}

export async function prepareDownloadRoot(downloadRoot) {
  const root = validateDownloadRootPath(downloadRoot);
  const probe = path.join(root, `.resource-downloader-write-test-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(probe, '', { flag: 'wx' });
  } catch (error) {
    throw new Error(`config.downloadRoot is not writable: ${root}\n${error.message}`);
  } finally {
    await rm(probe, { force: true });
  }
  return root;
}

export async function updateBrowserHeadless(configPath, headless) {
  if (typeof headless !== 'boolean') {
    throw new Error('browser.headless must be a boolean');
  }

  const absoluteConfigPath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absoluteConfigPath, 'utf8'));
  raw.browser = { ...raw.browser, headless };
  const temporary = `${absoluteConfigPath}.part-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    await rename(temporary, absoluteConfigPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function enablePlugin(configPath, id) {
  return setPluginEnabled(configPath, id, true);
}

export async function setPluginEnabled(configPath, id, value) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id || '')) throw new Error('插件 ID 无效');
  if (typeof value !== 'boolean') throw new Error('enabled 必须为布尔值');
  const absolute = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absolute, 'utf8'));
  const enabled = raw.plugins?.enabled || [];
  if (!Array.isArray(enabled)) throw new Error('plugins.enabled must be an array');
  if (enabled.includes(id) === value) return enabled;
  const next = value ? [...enabled, id] : enabled.filter((item) => item !== id);
  raw.plugins = { ...raw.plugins, enabled: next };
  const temporary = `${absolute}.part-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`);
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
  return next;
}

export async function loadConfig(configPath) {
  const absoluteConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(absoluteConfigPath);
  const raw = JSON.parse(await readFile(absoluteConfigPath, 'utf8'));

  const downloadRoot = validateDownloadRootPath(raw.downloadRoot);

  const browserProfileDirectory = path.resolve(
    configDirectory,
    raw.browserProfileDirectory || './.data/browser-profile'
  );
  const taskQueueFile = path.resolve(
    configDirectory,
    raw.taskQueueFile || './.data/task-queue.json'
  );
  const server = {
    port: 43_127,
    tokenFile: './.data/server-token',
    idleShutdownMs: 120_000,
    ...raw.server
  };
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65_535) {
    throw new Error('config.server.port must be an integer between 1 and 65535');
  }
  if (!Number.isInteger(server.idleShutdownMs) || server.idleShutdownMs < 0) {
    throw new Error('config.server.idleShutdownMs must be a non-negative integer');
  }
  server.tokenFile = path.resolve(configDirectory, server.tokenFile);
  const workflow = {
    autoReply: false,
    replyText: '',
    keepBrowserOpenOnActionRequired: true,
    ...raw.workflow
  };

  if (workflow.autoReply && !workflow.replyText?.trim()) {
    throw new Error('config.workflow.replyText is required when autoReply is enabled');
  }
  const plugins = {
    directories: ['./plugins'],
    enabled: [],
    options: {},
    ...raw.plugins
  };
  if (!Array.isArray(plugins.directories) || plugins.directories.some((item) => typeof item !== 'string' || !item)) {
    throw new Error('config.plugins.directories must be an array of directory paths');
  }
  if (!Array.isArray(plugins.enabled) || plugins.enabled.some((item) => !/^[a-z0-9][a-z0-9-]*$/.test(item))) {
    throw new Error('config.plugins.enabled must be an array of plugin ids');
  }
  if (new Set(plugins.enabled).size !== plugins.enabled.length) {
    throw new Error('config.plugins.enabled must not contain duplicate ids');
  }
  if (!plugins.options || typeof plugins.options !== 'object' || Array.isArray(plugins.options)) {
    throw new Error('config.plugins.options must be an object keyed by plugin id');
  }
  plugins.directories = plugins.directories.map((directory) => path.resolve(configDirectory, directory));

  return {
    downloadRoot,
    browserProfileDirectory,
    taskQueueFile,
    server,
    browser: {
      channel: 'chrome',
      headless: false,
      ...raw.browser
    },
    plugins,
    workflow
  };
}
