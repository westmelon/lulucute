import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForShutdown } from '../src/core/idle-shutdown.mjs';

function createWorker(initialState) {
  let state = initialState;
  const listeners = new Set();
  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(nextState) {
      state = nextState;
      for (const listener of listeners) listener(state);
    },
    listenerCount: () => listeners.size
  };
}

test('waitForShutdown stops after the queue remains idle', async () => {
  const worker = createWorker({ running: false, tasks: [] });
  const signals = new EventEmitter();

  assert.equal(await waitForShutdown({ worker, idleShutdownMs: 10, signalEmitter: signals }), 'idle');
  assert.equal(worker.listenerCount(), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('waitForShutdown does not stop while a task is pending', async () => {
  const worker = createWorker({
    running: false,
    tasks: [{ id: 'one', status: 'pending' }]
  });
  const signals = new EventEmitter();
  const shutdown = waitForShutdown({ worker, idleShutdownMs: 10, signalEmitter: signals });
  const early = await Promise.race([
    shutdown.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25))
  ]);
  assert.equal(early, false);

  worker.update({ running: false, tasks: [{ id: 'one', status: 'completed' }] });
  assert.equal(await shutdown, 'idle');
});

test('waitForShutdown keeps a login window open even without queued tasks', async () => {
  const worker = createWorker({ running: false, browser: { loginStatus: 'opening' }, tasks: [] });
  const shutdown = waitForShutdown({ worker, idleShutdownMs: 10, signalEmitter: new EventEmitter() });
  assert.equal(await Promise.race([
    shutdown.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25))
  ]), false);
  worker.update({ running: false, browser: { loginStatus: 'open' }, tasks: [] });
  assert.equal(await Promise.race([
    shutdown.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25))
  ]), false);
  worker.update({ running: false, browser: { loginStatus: null }, tasks: [] });
  assert.equal(await shutdown, 'idle');
});

test('waitForShutdown does not interrupt a repository or plugin installation operation', async () => {
  const worker = createWorker({ running: false, pluginOperation: '安装插件', tasks: [] });
  const shutdown = waitForShutdown({ worker, idleShutdownMs: 10, signalEmitter: new EventEmitter() });
  assert.equal(await Promise.race([shutdown.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25))]), false);
  worker.update({ running: false, pluginOperation: null, tasks: [] });
  assert.equal(await shutdown, 'idle');
});
