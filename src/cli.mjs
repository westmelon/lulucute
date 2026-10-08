#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadConfig, prepareDownloadRoot } from './config.mjs';
import { TaskQueue } from './core/task-queue.mjs';
import { runQueuedTasks } from './core/batch-runner.mjs';
import { createWorkflow, launchBrowser } from './app-runtime.mjs';
import { loadLocalPlugins } from './core/plugin-loader.mjs';

function parseArguments(argv) {
  const args = { dryRun: false, retryFailed: false, urls: [], urlFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--retry-failed') args.retryFailed = true;
    else if (value === '--config') args.config = requireValue(argv, ++index, value);
    else if (value === '--url') args.urls.push(requireValue(argv, ++index, value));
    else if (value === '--urls-file') args.urlFiles.push(requireValue(argv, ++index, value));
    else if (value === '--login') args.login = requireValue(argv, ++index, value);
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp() {
  console.log(`lulucute

Usage:
  npm start -- --config config.json --login https://forum.example.com/login
  npm start -- --config config.json --url https://forum.example.com/thread/123 --dry-run
  npm start -- --config config.json --url https://forum.example.com/thread/123
  npm start -- --config config.json --urls-file urls.txt
  npm start -- --config config.json --retry-failed
`);
}

function waitForInterrupt() {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

async function collectUrls(args) {
  const urls = [...args.urls];
  for (const filePath of args.urlFiles) {
    const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/);
    urls.push(...lines.map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
  }
  return urls;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.config) throw new Error('--config is required');
  if (args.login && (args.urls.length || args.urlFiles.length || args.retryFailed || args.dryRun)) {
    throw new Error('--login cannot be combined with download or retry options');
  }
  if (args.dryRun && args.retryFailed) throw new Error('--dry-run cannot be combined with --retry-failed');
  if (!args.login && !args.urls.length && !args.urlFiles.length && !args.retryFailed) {
    throw new Error('--url, --urls-file, --retry-failed, or --login is required');
  }

  const config = await loadConfig(args.config);
  const plugins = await loadLocalPlugins(config);
  const urls = await collectUrls(args);
  let queue;
  let context;

  try {
    if (args.login) {
      context = await launchBrowser(config);
      const page = context.pages()[0] || await context.newPage();
      await page.goto(args.login, { waitUntil: 'domcontentloaded' });
      console.log('Complete the one-time login in the browser, then press Ctrl+C here.');
      await waitForInterrupt();
      return;
    }

    if (args.dryRun) {
      if (urls.length === 0) throw new Error('--dry-run requires at least one --url or --urls-file');
      context = await launchBrowser(config);
      const workflow = createWorkflow(config, plugins);
      const results = [];
      for (const url of urls) {
        console.error(`[resource-downloader] Inspecting ${url}`);
        results.push({ url, result: await workflow.run(context, url, { dryRun: true }) });
      }
      console.log(JSON.stringify(results.length === 1 ? results[0].result : results, null, 2));
      return;
    }

    console.error('[resource-downloader] Validating download directory');
    await prepareDownloadRoot(config.downloadRoot);
    queue = await new TaskQueue(config.taskQueueFile, plugins).open();
    const enqueued = await queue.enqueue(urls);
    const retried = args.retryFailed ? await queue.retryFailed() : [];
    const pending = queue.pending();

    if (pending.length === 0) {
      console.log(JSON.stringify({
        queueFile: config.taskQueueFile,
        added: enqueued.added.length,
        duplicates: enqueued.existing.length,
        refreshed: enqueued.refreshed.length,
        retried: retried.length,
        processed: []
      }, null, 2));
      return;
    }

    context = await launchBrowser(config);
    const processed = await runQueuedTasks({
      queue,
      workflow: createWorkflow(config, plugins),
      context
    });
    console.log(JSON.stringify({
      queueFile: config.taskQueueFile,
      added: enqueued.added.length,
      duplicates: enqueued.existing.length,
      refreshed: enqueued.refreshed.length,
      retried: retried.length,
      processed
    }, null, 2));

    const needsAction = processed.some((item) => item.status === 'action-required');
    if (needsAction && config.workflow.keepBrowserOpenOnActionRequired) {
      console.log('One or more queued tasks need official-page action. Press Ctrl+C when finished, then run --retry-failed.');
      await waitForInterrupt();
    }

    if (processed.some((item) => item.status === 'failed')) process.exitCode = 1;
  } finally {
    try {
      if (context) await context.close();
    } finally {
      if (queue) await queue.close();
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
