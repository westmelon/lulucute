import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';

test('CLI opens an empty retry queue without starting Chrome', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const queuePath = path.join(root, 'tasks.json');
  await writeFile(configPath, JSON.stringify({
    downloadRoot: path.join(root, 'downloads'),
    browserProfileDirectory: path.join(root, 'browser'),
    taskQueueFile: queuePath
  }));

  const child = spawn(process.execPath, [
    'src/cli.mjs',
    '--config',
    configPath,
    '--retry-failed'
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');

  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.processed, []);
  assert.equal(result.retried, 0);
  await assert.rejects(() => access(`${queuePath}.lock`), { code: 'ENOENT' });
});
