#!/usr/bin/env node
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadConfig, prepareDownloadRoot, updateBrowserHeadless } from './config.mjs';
import { TaskQueue } from './core/task-queue.mjs';
import { QueueWorker } from './core/queue-worker.mjs';
import { LocalApiServer } from './core/local-api-server.mjs';
import { loadLocalPlugins } from './core/plugin-loader.mjs';
import { waitForShutdown } from './core/idle-shutdown.mjs';
import { PluginManager } from './core/plugin-manager.mjs';
import { installNativeHost } from './core/native-host-registration.mjs';

function parseArguments(argv) {
  let config;
  let managed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--config') config = argv[++index];
    else if (value === '--managed') managed = true;
    else if (value === '--help' || value === '-h') return { help: true };
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!config) throw new Error('--config is required');
  return { config, managed };
}

async function loadOrCreateToken(filePath) {
  try {
    const token = (await readFile(filePath, 'utf8')).trim();
    if (token.length < 32) throw new Error('Local service token is invalid');
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const token = randomBytes(32).toString('base64url');
  try {
    await writeFile(filePath, `${token}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return token;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return (await readFile(filePath, 'utf8')).trim();
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run server -- --config config.json [--managed]');
    return;
  }

  const config = await loadConfig(args.config);
  await prepareDownloadRoot(config.downloadRoot);
  const token = await loadOrCreateToken(config.server.tokenFile);
  const plugins = await loadLocalPlugins(config);
  const queue = await new TaskQueue(config.taskQueueFile, plugins).open();
  const worker = new QueueWorker({
    queue,
    config,
    plugins,
    persistBrowserHeadless: (headless) => updateBrowserHeadless(args.config, headless)
  });
  const staticDirectory = fileURLToPath(new URL('../extension/', import.meta.url));
  const api = new LocalApiServer({
    worker,
    token,
    downloadRoot: config.downloadRoot,
    staticDirectory,
    pluginManager: new PluginManager({ config, configPath: args.config }),
    port: config.server.port
  });

  try {
    const port = await api.listen();
    console.log(`[resource-downloader] Dashboard: http://127.0.0.1:${port}/`);
    if (!args.managed) {
      console.log(`[resource-downloader] Extension token: ${token}`);
      console.log(`[resource-downloader] Load unpacked extension: ${staticDirectory}`);
      if (['darwin', 'win32'].includes(process.platform)) {
        try {
          const { extensionId } = await installNativeHost({ configPath: args.config });
          console.log(`[resource-downloader] Native host registered for extension ${extensionId}`);
        } catch (error) {
          console.warn(`[resource-downloader] 自动注册启动器失败，服务仍可手动使用：${error.message}`);
          console.warn('[resource-downloader] 可运行 npm run install:native-host -- --config <配置文件路径> 重试。');
        }
      }
    }
    const shutdown = waitForShutdown({
      worker,
      idleShutdownMs: config.server.idleShutdownMs
    });
    worker.kick();
    const reason = await shutdown;
    console.log(reason === 'idle'
      ? '[resource-downloader] Stopping after the idle timeout.'
      : '[resource-downloader] Stopping after the current task.');
  } finally {
    await api.close().catch(() => {});
    try {
      await worker.close();
    } finally {
      await queue.close();
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
