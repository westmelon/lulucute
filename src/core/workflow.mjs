import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildTargetDirectory } from './path-policy.mjs';

function renderReply(template, metadata) {
  return template.replaceAll('{title}', metadata.threadTitle);
}

async function writeManifest(directory, payload) {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, '.resource-downloader.json');
  const temporary = `${target}.part-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export class DownloadWorkflow {
  constructor({ registry, downloader, config }) {
    this.registry = registry;
    this.downloader = downloader;
    this.config = config;
  }

  async run(context, url, {
    dryRun = false,
    signal,
    onProgress = async () => {},
    shouldSkipResource = async () => false,
    onResourceCompleted = async () => {}
  } = {}) {
    signal?.throwIfAborted();
    await onProgress('inspecting');
    const forum = this.registry.forumFor(url);
    const page = await context.newPage();

    try {
      signal?.throwIfAborted();
      let state = await forum.inspect(page, url, { signal });
      if (state.locked) {
        if (dryRun) {
          return { status: 'locked', source: state.source, resources: [] };
        }
        if (!this.config.workflow.autoReply) {
          throw new Error('Resource is locked and automatic replies are disabled');
        }
        signal?.throwIfAborted();
        await onProgress('replying', { threadId: state.source.threadId });
        await forum.reply(page, renderReply(this.config.workflow.replyText, state.source));
        signal?.throwIfAborted();
        await onProgress('reply-completed', { threadId: state.source.threadId });
        state = await forum.inspect(page, url, { navigate: false, signal });
      }

      signal?.throwIfAborted();
      await onProgress('extracting');
      const resources = await forum.extractResources(page, state.source, { signal });
      const directory = buildTargetDirectory(this.config.downloadRoot, state.source);
      if (dryRun) {
        return { status: 'planned', source: state.source, directory, resources };
      }

      const results = [];
      for (let index = 0; index < resources.length; index += 1) {
        signal?.throwIfAborted();
        const resource = resources[index];
        await onProgress('downloading', { current: index + 1, total: resources.length });
        if (await shouldSkipResource(resource)) {
          results.push({ status: 'skipped', resource, reason: 'already-downloaded' });
          continue;
        }
        try {
          const provider = this.registry.providerFor(resource);
          const resolved = await provider.resolve(context, resource, { directory, signal,
            onProgress: (transfer) => onProgress('downloading', {
              current: index + 1, total: resources.length, transfer
            }) });
          signal?.throwIfAborted();
          if (resolved.status === 'action-required') {
            results.push(resolved);
            continue;
          }
          if (resolved.status === 'downloaded') {
            await onResourceCompleted(resource, resolved);
            results.push(resolved);
            continue;
          }
          const download = await this.downloader.download({
            ...resolved,
            directory,
            signal
          });
          signal?.throwIfAborted();
          const completed = { status: 'downloaded', resource, download };
          await onResourceCompleted(resource, completed);
          results.push(completed);
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          results.push({ status: 'failed', resource, error: error.message });
        }
      }

      signal?.throwIfAborted();
      await writeManifest(directory, {
        source: state.source,
        resources,
        results,
        updatedAt: new Date().toISOString()
      });
      await onProgress('finalizing', { total: resources.length });
      return { status: 'completed', source: state.source, directory, results };
    } finally {
      await page.close().catch(() => {});
    }
  }
}
