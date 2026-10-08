import test from 'node:test';
import assert from 'node:assert/strict';
import { runQueuedTasks } from '../src/core/batch-runner.mjs';

test('runQueuedTasks processes tasks sequentially and classifies results', async () => {
  const tasks = [
    { id: 'one', url: 'https://example.com/one' },
    { id: 'two', url: 'https://example.com/two' }
  ];
  const events = [];
  const queue = {
    pending: () => tasks,
    hasCompletedResource: () => false,
    markResourceCompleted: async () => {},
    markProgress: async (id, stage) => events.push(`${id}:${stage}`),
    markCompleted: async (id) => events.push(`${id}:completed`),
    markFailed: async (id) => events.push(`${id}:failed`),
    markActionRequired: async (id) => events.push(`${id}:action-required`)
  };
  const workflow = {
    run: async (_context, url, { onProgress }) => {
      await onProgress('inspecting');
      await onProgress('downloading');
      return url.endsWith('/one')
        ? { results: [{ status: 'downloaded' }] }
        : { results: [{ status: 'action-required', message: 'login required' }] };
    }
  };

  const processed = await runQueuedTasks({ queue, workflow, context: {}, log: () => {} });

  assert.deepEqual(processed.map((task) => task.status), ['completed', 'action-required']);
  assert.deepEqual(events, [
    'one:inspecting',
    'one:downloading',
    'one:completed',
    'two:inspecting',
    'two:downloading',
    'two:action-required'
  ]);
});

test('runQueuedTasks skips resources completed through an alias URL', async () => {
  const task = { id: 'dynamic', url: 'https://afdian.com/api/post/get-list?user_id=user' };
  let skipped = false;
  const queue = {
    pending: () => [task],
    hasCompletedResource: (url) => url.includes('/album/'),
    markResourceCompleted: async () => {},
    markProgress: async () => {},
    markCompleted: async () => {},
    markFailed: async () => {},
    markActionRequired: async () => {}
  };
  const workflow = {
    run: async (_context, _url, { shouldSkipResource }) => {
      skipped = await shouldSkipResource({
        url: 'https://afdian.com/p/post-one?resource=video',
        aliasUrls: ['https://afdian.com/album/album-one/post-one?resource=video']
      });
      return { results: [{ status: 'skipped' }] };
    }
  };

  await runQueuedTasks({ queue, workflow, context: {}, log: () => {} });

  assert.equal(skipped, true);
});
