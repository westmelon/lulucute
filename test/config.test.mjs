import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  loadConfig,
  prepareDownloadRoot,
  updateBrowserHeadless,
  validateDownloadRootPath
} from '../src/config.mjs';

test('validateDownloadRootPath rejects the example placeholder', () => {
  assert.throws(
    () => validateDownloadRootPath('/absolute/path/to/ResourceHub'),
    /still contains the example path/
  );
});

test('prepareDownloadRoot creates and verifies a configured directory', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'resource-root-'));
  const downloadRoot = path.join(temporaryRoot, 'downloads');
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  assert.equal(await prepareDownloadRoot(downloadRoot), downloadRoot);
  await access(downloadRoot);
});

test('loadConfig resolves the task queue beside the config file', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'resource-config-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const configPath = path.join(temporaryRoot, 'config.json');
  await writeFile(configPath, JSON.stringify({
    downloadRoot: path.join(temporaryRoot, 'downloads'),
    plugins: {
      directories: ['./custom-plugins'],
      enabled: ['custom-forum']
    }
  }));

  const config = await loadConfig(configPath);

  assert.equal(config.taskQueueFile, path.join(temporaryRoot, '.data', 'task-queue.json'));
  assert.equal(config.server.port, 43127);
  assert.equal(config.server.tokenFile, path.join(temporaryRoot, '.data', 'server-token'));
  assert.equal(config.server.idleShutdownMs, 120000);
  assert.deepEqual(config.plugins, {
    directories: [path.join(temporaryRoot, 'custom-plugins')],
    enabled: ['custom-forum'],
    options: {}
  });
});

test('loadConfig validates the server idle timeout', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'resource-config-idle-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const configPath = path.join(temporaryRoot, 'config.json');
  await writeFile(configPath, JSON.stringify({
    downloadRoot: path.join(temporaryRoot, 'downloads'),
    server: { idleShutdownMs: -1 }
  }));

  await assert.rejects(() => loadConfig(configPath), /idleShutdownMs must be a non-negative integer/);
});

test('updateBrowserHeadless persists the browser mode without replacing other settings', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'resource-config-update-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const configPath = path.join(temporaryRoot, 'config.json');
  await writeFile(configPath, JSON.stringify({
    downloadRoot: path.join(temporaryRoot, 'downloads'),
    browser: { channel: 'chrome', headless: false },
    workflow: { autoReply: false }
  }));

  await updateBrowserHeadless(configPath, true);

  const persisted = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(persisted.browser, { channel: 'chrome', headless: true });
  assert.deepEqual(persisted.workflow, { autoReply: false });
});
