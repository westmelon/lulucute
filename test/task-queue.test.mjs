import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { TaskQueue } from '../src/core/task-queue.mjs';


async function createQueue(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'tasks.json');
  const queue = await new TaskQueue(filePath).open();
  t.after(() => queue.close());
  return { filePath, queue };
}

test('TaskQueue persists resource fingerprints without URLs or extraction codes', async (t) => {
  const { filePath, queue } = await createQueue(t);
  const { added: [task] } = await queue.enqueue(['https://www.hifiti.com/thread-1228.htm']);
  await queue.markResourceCompleted(task.id, {
    provider: 'baidu',
    url: 'https://pan.baidu.com/s/example?b=2&a=1',
    code: 'secret'
  });

  assert.equal(queue.hasCompletedResource('https://pan.baidu.com/s/example?a=1&b=2'), true);
  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /secret/);
  assert.doesNotMatch(persisted, /pan\.baidu\.com/);
  assert.equal(JSON.parse(persisted).resources.length, 1);
});

test('TaskQueue records stable resource aliases without persisting their URLs', async (t) => {
  const { filePath, queue } = await createQueue(t);
  const { added: [task] } = await queue.enqueue(['https://www.hifiti.com/thread-1228.htm']);
  const canonical = 'https://afdian.com/p/post-one?resource=video';
  const albumAlias = 'https://afdian.com/album/album-one/post-one?resource=video';
  await queue.markResourceCompleted(task.id, {
    provider: 'afdian',
    url: canonical,
    aliasUrls: [albumAlias],
    preserveCompletion: true
  });

  assert.equal(queue.hasCompletedResource(canonical), true);
  assert.equal(queue.hasCompletedResource(albumAlias), true);
  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /afdian\.com/);
  assert.equal(JSON.parse(persisted).resources.length, 2);
});

test('TaskQueue deletes tasks and their resource fingerprints', async (t) => {
  const { filePath, queue } = await createQueue(t);
  const { added: [task] } = await queue.enqueue(['https://www.hifiti.com/thread-1228.htm']);
  await queue.markResourceCompleted(task.id, { provider: 'direct', url: 'https://example.com/file.zip' });
  await queue.remove(task.id);

  assert.deepEqual(queue.tasks(), []);
  assert.equal(queue.hasCompletedResource('https://example.com/file.zip'), false);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(persisted.tasks, []);
  assert.deepEqual(persisted.resources, []);
});

test('TaskQueue keeps persistent download fingerprints after deleting a task', async (t) => {
  const { filePath, queue } = await createQueue(t);
  const url = 'https://afdian.com/album/93148dc0ad3811f0a32e52540025c377';
  const { added: [task] } = await queue.enqueue([url]);
  const resourceUrl = `${url}/post-one?resource=video`;
  await queue.markResourceCompleted(task.id, {
    provider: 'afdian',
    url: resourceUrl,
    preserveCompletion: true
  });
  await queue.remove(task.id);

  assert.deepEqual(queue.tasks(), []);
  assert.equal(queue.hasCompletedResource(resourceUrl), true);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.resources.length, 1);
  assert.equal(persisted.resources[0].preserveCompletion, true);
  assert.equal('path' in persisted.resources[0], false);
});

test('TaskQueue refuses to delete a running task', async (t) => {
  const { queue } = await createQueue(t);
  const { added: [task] } = await queue.enqueue(['https://www.hifiti.com/thread-1228.htm']);
  await queue.markProgress(task.id, 'inspecting');

  await assert.rejects(() => queue.remove(task.id), /Running task cannot be deleted/);
  assert.equal(queue.tasks().length, 1);
});

test('TaskQueue marks cancellation and allows an explicit retry', async (t) => {
  const { queue } = await createQueue(t);
  const { added: [task] } = await queue.enqueue(['https://www.hifiti.com/thread-1228.htm']);
  await queue.markProgress(task.id, 'downloading');
  await queue.markCancelRequested(task.id);

  assert.equal(queue.requireTask(task.id).stage, 'cancelling');
  await queue.markCancelled(task.id);
  assert.equal(queue.requireTask(task.id).status, 'cancelled');

  await queue.retry(task.id);
  assert.equal(queue.requireTask(task.id).status, 'pending');
  assert.equal(queue.requireTask(task.id).stage, 'retry-queued');
});

test('TaskQueue treats cancellation during a public reply as action required', async (t) => {
  const { queue } = await createQueue(t);
  const { added: [task] } = await queue.enqueue(['https://www.hifiti.com/thread-1228.htm']);
  await queue.markProgress(task.id, 'replying');
  await queue.markCancelRequested(task.id);
  await queue.markCancelled(task.id);

  assert.equal(queue.requireTask(task.id).status, 'action-required');
  assert.equal(queue.requireTask(task.id).stage, 'reply-status-unknown');
});

test('TaskQueue recovers interrupted tasks and retries failed tasks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-queue-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'tasks.json');
  await writeFile(filePath, `${JSON.stringify({
    version: 1,
    tasks: [
      { id: 'running', url: 'https://example.com/1', status: 'running', stage: 'downloading' },
      { id: 'failed', url: 'https://example.com/2', status: 'failed', stage: 'failed' },
      { id: 'replying', url: 'https://example.com/3', status: 'running', stage: 'replying' },
      { id: 'cancelling', url: 'https://example.com/4', status: 'running', stage: 'cancelling', cancelRequestedAt: 'now', cancelRequestedFromStage: 'downloading' },
      { id: 'cancelling-reply', url: 'https://example.com/5', status: 'running', stage: 'cancelling', cancelRequestedAt: 'now', cancelRequestedFromStage: 'replying' }
    ]
  })}\n`);

  const queue = await new TaskQueue(filePath).open();
  t.after(() => queue.close());
  assert.equal(queue.requireTask('running').status, 'pending');
  assert.equal(queue.requireTask('replying').status, 'action-required');
  assert.equal(queue.requireTask('replying').stage, 'reply-status-unknown');
  assert.equal(queue.requireTask('cancelling').status, 'cancelled');
  assert.equal(queue.requireTask('cancelling-reply').status, 'action-required');
  assert.deepEqual(queue.pending().map((task) => task.id), ['running']);

  const retried = await queue.retryFailed();
  assert.deepEqual(retried.map((task) => task.id), ['failed', 'replying', 'cancelling-reply']);
  assert.deepEqual(queue.pending().map((task) => task.id), ['running', 'failed', 'replying', 'cancelling-reply']);
});

test('TaskQueue prevents a second process from using the same queue', async (t) => {
  const { filePath } = await createQueue(t);
  await assert.rejects(
    () => new TaskQueue(filePath).open(),
    /Another resource-downloader process/
  );
});

