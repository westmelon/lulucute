import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

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
