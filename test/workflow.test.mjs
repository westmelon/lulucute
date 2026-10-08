import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DownloadWorkflow } from '../src/core/workflow.mjs';

test('DownloadWorkflow accepts provider downloads and forwards byte progress with resource position', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'download-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = {
    forum: 'HiFiTi',
    section: '华语',
    threadId: '123',
    threadTitle: '测试帖子'
  };
  const resource = { provider: 'baidu', url: 'https://pan.baidu.com/s/example', source };
  const page = { close: async () => {} };
  let receivedDirectory;
  let downloaderCalled = false;
  const stages = [];
  const details = [];
  const workflow = new DownloadWorkflow({
    registry: {
      forumFor: () => ({
        inspect: async () => ({ locked: false, source }),
        extractResources: async () => [resource]
      }),
      providerFor: () => ({
        resolve: async (_context, _resource, options) => {
          receivedDirectory = options.directory;
          await options.onProgress({ bytes: 512, totalBytes: 1024, speed: 256 });
          return {
            status: 'downloaded',
            resource,
            download: { method: 'baidu-client', paths: [path.join(options.directory, 'album.zip')] }
          };
        }
      })
    },
    downloader: {
      download: async () => {
        downloaderCalled = true;
      }
    },
    config: {
      downloadRoot: root,
      workflow: { autoReply: false, replyText: '' }
    }
  });

  const result = await workflow.run(
    { newPage: async () => page },
    resource.url,
    { onProgress: async (stage, value) => { stages.push(stage); details.push(value); } }
  );

  assert.equal(result.results[0].status, 'downloaded');
  assert.equal(downloaderCalled, false);
  assert.equal(receivedDirectory, path.join(root, 'HiFiTi', '华语', '测试帖子'));
  const manifest = JSON.parse(await readFile(path.join(receivedDirectory, '.resource-downloader.json')));
  assert.equal(manifest.results[0].download.method, 'baidu-client');
  assert.deepEqual(stages, ['inspecting', 'extracting', 'downloading', 'downloading', 'finalizing']);
  assert.deepEqual(details[3], { current: 1, total: 1,
    transfer: { bytes: 512, totalBytes: 1024, speed: 256 } });
});

test('DownloadWorkflow skips a resource recorded as completed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'download-workflow-skip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { forum: 'HiFiTi', section: '华语', threadId: '456', threadTitle: '重复资源' };
  const resource = { provider: 'baidu', url: 'https://pan.baidu.com/s/example', source };
  const workflow = new DownloadWorkflow({
    registry: {
      forumFor: () => ({
        inspect: async () => ({ locked: false, source }),
        extractResources: async () => [resource]
      }),
      providerFor: () => { throw new Error('provider must not be called'); }
    },
    downloader: {},
    config: { downloadRoot: root, workflow: { autoReply: false, replyText: '' } }
  });

  const result = await workflow.run(
    { newPage: async () => ({ close: async () => {} }) },
    'https://www.hifiti.com/thread-456.htm',
    { shouldSkipResource: async () => true }
  );

  assert.equal(result.results[0].status, 'skipped');
  assert.equal(result.results[0].reason, 'already-downloaded');
});

test('DownloadWorkflow propagates cancellation instead of recording a resource failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'download-workflow-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { forum: 'HiFiTi', section: '华语', threadId: '789', threadTitle: '取消任务' };
  const resource = { provider: 'baidu', url: 'https://pan.baidu.com/s/example', source };
  const controller = new AbortController();
  let pageClosed = false;
  const workflow = new DownloadWorkflow({
    registry: {
      forumFor: () => ({
        inspect: async () => ({ locked: false, source }),
        extractResources: async () => [resource]
      }),
      providerFor: () => ({
        resolve: async (_context, _resource, { signal }) => {
          controller.abort(new Error('cancelled'));
          signal.throwIfAborted();
        }
      })
    },
    downloader: {},
    config: { downloadRoot: root, workflow: { autoReply: false, replyText: '' } }
  });

  await assert.rejects(
    () => workflow.run(
      { newPage: async () => ({ close: async () => { pageClosed = true; } }) },
      'https://www.hifiti.com/thread-789.htm',
      { signal: controller.signal }
    ),
    /cancelled/
  );
  assert.equal(pageClosed, true);
});
