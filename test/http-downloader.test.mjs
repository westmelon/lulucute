import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { HttpDownloader } from '../src/core/http-downloader.mjs';

test('HttpDownloader streams files and avoids overwriting existing names', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'resource-downloader-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="track.flac"'
    });
    response.end('audio-fixture');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    server.close();
    await once(server, 'close');
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const { port } = server.address();
  const downloader = new HttpDownloader();
  const first = await downloader.download({
    directUrl: `http://127.0.0.1:${port}/file`,
    directory: temporaryRoot
  });
  const second = await downloader.download({
    directUrl: `http://127.0.0.1:${port}/file`,
    directory: temporaryRoot
  });

  assert.equal(path.basename(first.path), 'track.flac');
  assert.equal(path.basename(second.path), 'track (1).flac');
  assert.equal(await readFile(first.path, 'utf8'), 'audio-fixture');
  assert.equal(first.bytes, 13);
});

test('HttpDownloader cancels a stream and removes its temporary file', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'resource-downloader-cancel-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="large.zip"'
    });
    const interval = setInterval(() => response.write('chunk'), 5);
    response.on('close', () => clearInterval(interval));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    server.close();
    await once(server, 'close');
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('cancelled')), 20);
  const downloader = new HttpDownloader();
  await assert.rejects(
    () => downloader.download({
      directUrl: `http://127.0.0.1:${server.address().port}/file`,
      directory: temporaryRoot,
      signal: controller.signal
    }),
    /cancelled|abort/i
  );
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('HttpDownloader times out waiting for headers but allows a longer streaming body', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'resource-downloader-timeout-'));
  const server = http.createServer((request, response) => {
    if (request.url === '/stalled') return;
    response.writeHead(200);
    response.write('first');
    const timer = setTimeout(() => response.end('last'), 150);
    response.on('close', () => clearTimeout(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloader = new HttpDownloader();
  await assert.rejects(() => downloader.download({
    directUrl: `${origin}/stalled`, directory, headersTimeoutMs: 50
  }), /response timed out/);
  assert.deepEqual(await readdir(directory), []);
  const result = await downloader.download({
    directUrl: `${origin}/stream`, directory, headersTimeoutMs: 50
  });
  assert.equal(await readFile(result.path, 'utf8'), 'firstlast');
});

test('HttpDownloader times out a stalled body, cleans partial files, and keeps a slow active stream', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'resource-downloader-idle-'));
  const server = http.createServer((request, response) => {
    response.writeHead(200);
    response.write('first');
    if (request.url === '/stalled') return;
    let chunks = 0;
    const timer = setInterval(() => {
      if (++chunks === 8) { clearInterval(timer); response.end('last'); }
      else response.write('.');
    }, 40);
    response.on('close', () => clearInterval(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloader = new HttpDownloader();
  await assert.rejects(() => downloader.download({
    directUrl: `${origin}/stalled`, directory, idleTimeoutMs: 100,
    signal: AbortSignal.timeout(2_000)
  }), /Download stalled: no data/);
  assert.deepEqual(await readdir(directory), []);
  const result = await downloader.download({
    directUrl: `${origin}/slow`, directory, idleTimeoutMs: 200,
    signal: AbortSignal.timeout(2_000)
  });
  assert.equal(await readFile(result.path, 'utf8'), 'first.......last');
});
