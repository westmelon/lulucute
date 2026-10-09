import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

test('native host reads and writes Chrome framed messages', async () => {
  const child = spawn(process.execPath, [
    'scripts/native-host.mjs',
    '--config',
    'config.json'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const request = Buffer.from(JSON.stringify({ action: 'unsupported' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(request.length);
  child.stdin.end(Buffer.concat([header, request]));

  const output = [];
  for await (const chunk of child.stdout) output.push(chunk);
  const response = Buffer.concat(output);
  assert.ok(response.length >= 4);
  const length = response.readUInt32LE(0);
  const payload = JSON.parse(response.subarray(4, length + 4).toString('utf8'));
  assert.deepEqual(payload, { ok: false, error: 'Unsupported native host action' });
});

async function requestStart(configPath) {
  const child = spawn(process.execPath, ['scripts/native-host.mjs', '--config', configPath], { windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 20_000);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const closed = once(child, 'close');
  const body = Buffer.from(JSON.stringify({ action: 'start' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.end(Buffer.concat([header, body]));
  try {
    const [code] = await closed;
    const response = Buffer.concat(chunks);
    assert.ok(response.length >= 4, stderr);
    assert.equal(response.length, 4 + response.readUInt32LE(0), stderr);
    return { code, payload: JSON.parse(response.subarray(4).toString('utf8')) };
  } finally {
    clearTimeout(timeout);
  }
}

test('native host starts a stopped service, reuses a running service and lets it exit when idle', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-service-'));
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const endpoint = `http://127.0.0.1:${port}/api/state`;
  const tokenFile = path.join(root, '.data', 'server-token');
  const configPath = path.join(root, 'custom config.json');
  await writeFile(configPath, JSON.stringify({
    downloadRoot: path.join(root, 'downloads'),
    server: { port, tokenFile, idleShutdownMs: 2_000 }
  }));
  t.after(async () => {
    for (let index = 0; index < 60; index += 1) {
      try {
        await fetch(endpoint, { signal: AbortSignal.timeout(500) });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await rm(root, { recursive: true, force: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('Detached service did not shut down when idle');
  });

  assert.deepEqual(await requestStart(configPath), { code: 0, payload: { ok: true, started: true } });
  assert.deepEqual(await requestStart(configPath), { code: 0, payload: { ok: true, started: false } });
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const log = await readFile(path.join(root, '.data', 'server.log'), 'utf8');
  assert.ok(!log.includes(token), 'Managed startup must not print the token');
  assert.ok(!log.includes('Native host registered'), 'Managed startup must not re-register the launcher');
});

test('native host reports a missing config through the framed protocol', async () => {
  const configPath = path.join(os.tmpdir(), `missing-native-config-${process.pid}.json`);
  const result = await requestStart(configPath);
  assert.equal(result.code, 1);
  assert.equal(result.payload.ok, false);
  assert.match(result.payload.error, /ENOENT/);
});
