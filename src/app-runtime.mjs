import { createRequire } from 'node:module';
import { PluginRegistry } from './core/plugin-registry.mjs';
import { HttpDownloader } from './core/http-downloader.mjs';
import { DownloadWorkflow } from './core/workflow.mjs';
import { DirectProviderAdapter } from './adapters/providers/direct.mjs';

const require = createRequire(import.meta.url);

export async function launchBrowser(config) {
  const { chromium } = require('playwright-core');
  console.error('[resource-downloader] Starting Chrome');
  const context = await chromium.launchPersistentContext(config.browserProfileDirectory, {
    channel: config.browser.channel,
    headless: config.browser.headless,
    acceptDownloads: true,
    timeout: 30_000
  });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(30_000);
  return context;
}

export function createWorkflow(config, plugins = {}) {
  const registry = new PluginRegistry({
    forums: plugins.forums || [],
    providers: plugins.providers || [],
    fallback: new DirectProviderAdapter(),
    catalog: plugins.catalog || []
  });
  return new DownloadWorkflow({ registry, downloader: new HttpDownloader(), config });
}
