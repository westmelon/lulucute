import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Aria2Downloader } from '../src/core/aria2-downloader.mjs';

const executable = process.env.BILIBILI_TEST_ARIA2 || 'aria2c';

async function fixture(t, handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aria2-transfer-'));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, origin: `http://127.0.0.1:${server.address().port}` };
}

function respondWithRange(req, res, payload, intervalMs = 0) {
  const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = Number(match?.[1] || 0);
  const end = match?.[2] ? Number(match[2]) : payload.length - 1;
  res.writeHead(match ? 206 : 200, { 'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', ...(match ? {
      'Content-Range': `bytes ${start}-${end}/${payload.length}`
    } : {}) });
  if (!intervalMs) { res.end(payload.subarray(start, end + 1)); return; }
  let offset = start;
  const timer = setInterval(() => {
    const next = Math.min(offset + 64 * 1024, end + 1);
    res.write(payload.subarray(offset, next));
    offset = next;
    if (offset > end) { clearInterval(timer); res.end(); }
  }, intervalMs);
  res.on('close', () => clearInterval(timer));
}

test('aria2 uses backup mirrors, downloads ranges intact, reports bytes, and removes RPC secrets', async (t) => {
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  const requests = [];
  const { directory, origin } = await fixture(t, (req, res) => {
    requests.push({ path: req.url, range: req.headers.range });
    assert.equal(req.headers.referer, 'https://www.bilibili.com/');
    assert.equal(req.headers.cookie, undefined);
    if (req.url === '/denied') { res.writeHead(403).end(); return; }
    respondWithRange(req, res, payload, 40);
  });
  const progress = [];
  const downloader = new Aria2Downloader({ executable, pollIntervalMs: 100 });
  const result = await downloader.download({ urls: [`${origin}/denied`, `${origin}/video`],
    directory, filename: 'video.m4s', headers: { Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(15_000), onProgress: async (value) => progress.push(value) });
  assert.deepEqual(await readFile(result.path), payload);
  assert.ok(requests.some((request) => request.path === '/denied'));
  assert.ok(requests.some((request) => request.path === '/video' && request.range));
  assert.ok(progress.some((value) => value.bytes > 0 && value.bytes < payload.length));
  assert.equal(progress.at(-1).bytes, payload.length);
  assert.deepEqual(await readdir(directory), ['video.m4s']);
});

test('aria2 ends a continuously trickling stream instead of waiting forever', async (t) => {
  let sent = 0;
  const { directory, origin } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': 4 * 1024 * 1024, 'Accept-Ranges': 'bytes' });
    const timer = setInterval(() => { res.write(Buffer.alloc(64)); sent += 64; }, 100);
    res.on('close', () => clearInterval(timer));
  });
  const downloader = new Aria2Downloader({ executable, pollIntervalMs: 100, timeoutSeconds: 1 });
  const started = Date.now();
  await assert.rejects(() => downloader.download({ urls: [`${origin}/slow?secret=do-not-log`],
    directory, filename: 'video.m4s', signal: AbortSignal.timeout(35_000) }), (error) => {
    assert.match(error.message, /aria2 下载失败/);
    assert.doesNotMatch(error.message, /secret|127\.0\.0\.1/);
    return true;
  });
  assert.ok(sent > 0);
  assert.ok(Date.now() - started < 35_000);
  assert.equal((await readdir(directory)).some((name) => name.startsWith('.aria2-rpc-')), false);
});

test('aria2 falls back to a single slow connection and completes the saved media', async (t) => {
  const payload = Buffer.alloc(32 * 1024, 73);
  let requests = 0;
  const { directory, origin } = await fixture(t, (req, res) => {
    requests += 1;
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    let offset = Number(match?.[1] || 0);
    const end = match?.[2] ? Number(match[2]) : payload.length - 1;
    res.writeHead(match ? 206 : 200, { 'Content-Length': end - offset + 1,
      ...(match ? { 'Content-Range': `bytes ${offset}-${end}/${payload.length}` } : {}) });
    const timer = setInterval(() => {
      const next = Math.min(offset + 256, end + 1);
      res.write(payload.subarray(offset, next));
      offset = next;
      if (offset > end) { clearInterval(timer); res.end(); }
    }, 100);
    res.on('close', () => clearInterval(timer));
  });
  const downloader = new Aria2Downloader({ executable, pollIntervalMs: 100 });
  const result = await downloader.download({ urls: [`${origin}/slow`], directory,
    filename: 'video.m4s', signal: AbortSignal.timeout(35_000) });
  assert.ok(requests >= 2);
  assert.deepEqual(await readFile(result.path), payload);
  assert.deepEqual(await readdir(directory), ['video.m4s']);
});

test('aria2 cancellation stops requests and a new transfer resumes saved pieces', async (t) => {
  const payload = Buffer.alloc(8 * 1024 * 1024, 91);
  const requests = [];
  let active = 0;
  let slow = true;
  const { directory, origin } = await fixture(t, (req, res) => {
    active += 1;
    res.on('close', () => { active -= 1; });
    requests.push(req.headers.range || '');
    respondWithRange(req, res, payload, slow ? 20 : 0);
  });
  const controller = new AbortController();
  const downloader = new Aria2Downloader({ executable, pollIntervalMs: 100 });
  await assert.rejects(() => downloader.download({ urls: [`${origin}/video`], directory,
    filename: 'video.m4s', signal: controller.signal, onProgress: async ({ bytes }) => {
      if (bytes >= 2 * 1024 * 1024) controller.abort(new Error('cancel-test'));
    } }), /cancel-test/);
  assert.equal(active, 0);
  assert.ok((await readdir(directory)).includes('video.m4s.aria2'));
  assert.equal((await readdir(directory)).some((name) => name.startsWith('.aria2-rpc-')), false);
  const before = requests.length;
  slow = false;
  const result = await downloader.download({ urls: [`${origin}/video`], directory,
    filename: 'video.m4s', signal: AbortSignal.timeout(10_000) });
  assert.ok(requests.slice(before).some((range) => /^bytes=[1-9]\d*-/.test(range)));
  assert.deepEqual(await readFile(result.path), payload);
  assert.deepEqual(await readdir(directory), ['video.m4s']);
});

test('aria2 reports exhausted mirrors without exposing signed URLs', async (t) => {
  const { directory, origin } = await fixture(t, (_req, res) => res.writeHead(403).end());
  const downloader = new Aria2Downloader({ executable, pollIntervalMs: 100 });
  await assert.rejects(() => downloader.download({ urls: [`${origin}/a?token=private`, `${origin}/b`],
    directory, filename: 'video.m4s', signal: AbortSignal.timeout(10_000) }), (error) => {
    assert.match(error.message, /aria2 下载失败/);
    assert.doesNotMatch(error.message, /private|127\.0\.0\.1/);
    return true;
  });
  assert.deepEqual(await readdir(directory), []);
});
