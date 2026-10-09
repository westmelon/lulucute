import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { startPortableService } from '../src/core/portable-service.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portable-service-'));
  const projectDirectory = path.join(root, '便携 服务');
  await mkdir(projectDirectory);
  await cp(new URL('../src', import.meta.url), path.join(projectDirectory, 'src'), { recursive: true });
  await cp(new URL('../extension', import.meta.url), path.join(projectDirectory, 'extension'), { recursive: true });
  await symlink(path.resolve('node_modules'), path.join(projectDirectory, 'node_modules'), 'junction');
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const template = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  template.server = { ...template.server, port, idleShutdownMs: 2_000 };
  await writeFile(path.join(projectDirectory, 'config.example.json'), JSON.stringify(template));
  const endpoint = `http://127.0.0.1:${port}/`;
  t.after(async () => {
    for (let index = 0; index < 60; index += 1) {
      try { await fetch(endpoint, { signal: AbortSignal.timeout(500) }); } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await rm(root, { recursive: true, force: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('Portable service did not shut down when idle');
  });
  return { root, projectDirectory, endpoint, homeDirectory: path.join(root, 'home') };
}

test('first portable startup creates valid defaults and preserves config and token on subsequent launches', async (t) => {
  const f = await fixture(t);
  const registrations = [];
  const register = async (options) => registrations.push(options);
  const first = await startPortableService({ ...f, register });
  assert.equal(first.firstSetup, true);
  assert.equal(first.endpoint, f.endpoint);
  assert.equal(first.downloadRoot, path.join(f.homeDirectory, 'Downloads', 'lulucute'));
  assert.equal(first.extensionDirectory, path.join(f.projectDirectory, 'extension'));
  assert.ok(first.token.length >= 32);
  const configPath = path.join(f.projectDirectory, 'config.json');
  const original = await readFile(configPath, 'utf8');
  const next = await startPortableService({ ...f, register });
  assert.equal(next.firstSetup, false);
  assert.equal(next.token, first.token);
  assert.equal(await readFile(configPath, 'utf8'), original);
  assert.deepEqual(registrations, [
    { configPath, projectDirectory: f.projectDirectory },
    { configPath, projectDirectory: f.projectDirectory }
  ]);
});

test('registration failure keeps the portable service usable and existing settings untouched', async (t) => {
  const f = await fixture(t);
  const configPath = path.join(f.projectDirectory, 'config.json');
  const original = JSON.parse(await readFile(path.join(f.projectDirectory, 'config.example.json'), 'utf8'));
  original.downloadRoot = path.join(f.root, 'custom downloads');
  original.browser.headless = true;
  const text = JSON.stringify(original);
  await writeFile(configPath, text);
  const result = await startPortableService({ ...f, register: async () => { throw new Error('registration denied'); } });
  assert.equal(result.registrationError, 'registration denied');
  assert.equal(result.downloadRoot, original.downloadRoot);
  assert.equal(await readFile(configPath, 'utf8'), text);
  const response = await fetch(`${result.endpoint}api/state`, { headers: { Authorization: `Bearer ${result.token}` } });
  assert.equal(response.status, 200);
});
