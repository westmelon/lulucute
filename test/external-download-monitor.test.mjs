import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { ExternalDownloadMonitor } from '../src/core/external-download-monitor.mjs';

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'external-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const monitor = new ExternalDownloadMonitor({
    root,
    timeoutMs: 1_000,
    pollIntervalMs: 10,
    quietPeriodMs: 30
  });
  return { root, monitor };
}

test('ExternalDownloadMonitor waits for a temporary file and archives the completed item', async (t) => {
  const { root, monitor } = await createFixture(t);
  const destination = path.join(root, 'HiFiTi', '华语', '测试帖子');
  const baseline = await monitor.captureBaseline();
  const temporary = path.join(root, 'album.zip.baiduyun.p.downloading');
  const completed = path.join(root, 'album.zip');
  await writeFile(temporary, 'fixture');

  setTimeout(() => rename(temporary, completed), 25);
  const result = await monitor.waitForCompleted({ baseline, destination });

  assert.equal(result.status, 'completed');
  assert.equal(result.paths.length, 1);
  assert.equal(path.dirname(result.paths[0]), destination);
  assert.equal(await readFile(result.paths[0], 'utf8'), 'fixture');
});

test('ExternalDownloadMonitor archives multiple completed files together', async (t) => {
  const { root, monitor } = await createFixture(t);
  const destination = path.join(root, 'HiFiTi', '华语', '测试帖子');
  const baseline = await monitor.captureBaseline();
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'one.zip'), 'existing');
  await writeFile(path.join(root, 'one.zip'), 'one');
  await writeFile(path.join(root, 'two.zip'), 'two');

  const result = await monitor.waitForCompleted({ baseline, destination });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.paths.map((item) => path.basename(item)), ['one (1).zip', 'two.zip']);
  assert.equal(await readFile(path.join(destination, 'one.zip'), 'utf8'), 'existing');
  assert.equal(await readFile(path.join(destination, 'one (1).zip'), 'utf8'), 'one');
  assert.equal(await readFile(path.join(destination, 'two.zip'), 'utf8'), 'two');
});

test('ExternalDownloadMonitor does not treat a newly created destination as a download', async (t) => {
  const { root, monitor } = await createFixture(t);
  const destination = path.join(root, 'HiFiTi', '华语', '测试帖子');
  const baseline = await monitor.captureBaseline();
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'browser-download.zip'), 'browser');
  await writeFile(path.join(root, 'client-download.zip'), 'client');

  const result = await monitor.waitForCompleted({ baseline, destination });

  assert.equal(result.status, 'completed');
  assert.equal(path.basename(result.paths[0]), 'client-download.zip');
  assert.equal(await readFile(path.join(destination, 'browser-download.zip'), 'utf8'), 'browser');
});

test('ExternalDownloadMonitor stops waiting when cancelled', async (t) => {
  const { root, monitor } = await createFixture(t);
  const baseline = await monitor.captureBaseline();
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));

  await assert.rejects(
    () => monitor.waitForCompleted({
      baseline,
      destination: path.join(root, 'HiFiTi', '华语', '测试帖子'),
      signal: controller.signal
    }),
    /cancelled/
  );
});
