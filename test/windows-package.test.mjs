import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

const exec = promisify(execFile);
const registryKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.resourcehub.launcher';

test('Windows portable EXE works without system Node or Git and the registered launcher can restart it', {
  skip: process.platform !== 'win32' || !process.env.LULUCUTE_PORTABLE_DIRECTORY,
  timeout: 90_000
}, async (t) => {
  const source = process.env.LULUCUTE_PORTABLE_DIRECTORY;
  await assert.rejects(access(path.join(source, 'config.json')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(source, '.data')), { code: 'ENOENT' });
  await access(path.join(source, 'runtime', 'LICENSE'));
  await access(path.join(source, 'tools', 'git', 'LICENSE.txt'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'windows-package-'));
  const portable = path.join(root, "便携 & user's ! app");
  await cp(source, portable, { recursive: true });
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = path.join(process.env.SystemRoot, 'System32');
  const { stdout: registryValue } = await exec('powershell.exe', ['-NoProfile', '-Command', `
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry32)
    $key = $base.OpenSubKey('Software\\Google\\Chrome\\NativeMessagingHosts\\com.resourcehub.launcher')
    $value = $null
    if ($key) { $value = $key.GetValue(''); $key.Dispose() }
    $base.Dispose()
    if ($null -eq $value) { 'null' } else { ConvertTo-Json -InputObject $value -Compress }
  `]);
  const previousManifest = JSON.parse(registryValue.trim());
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  let completed = false;
  async function waitForIdleExit() {
    for (let index = 0; index < 200; index += 1) {
      try { await fetch(`${endpoint}/api/state`, { signal: AbortSignal.timeout(500) }); } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('Packaged service did not stop after its idle timeout');
  }
  t.after(async () => {
    if (!completed) {
      t.diagnostic(await readFile(path.join(portable, '.data', 'server.log'), 'utf8').catch(() => 'No packaged service log'));
    }
    if (previousManifest) {
      await exec('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', previousManifest, '/f', '/reg:32']);
    } else {
      await exec('reg.exe', ['delete', registryKey, '/f', '/reg:32']).catch(() => {});
    }
    await waitForIdleExit();
    await rm(root, { recursive: true, force: true });
  });
  const config = JSON.parse(await readFile(path.join(portable, 'config.example.json'), 'utf8'));
  config.downloadRoot = path.join(root, 'downloads');
  // 首次运行 EXE 的 .NET 初始化和注册需留出时间，之后仍验证真实空闲退出。
  config.server = { ...config.server, port, idleShutdownMs: 10_000 };
  await writeFile(path.join(portable, 'config.json'), JSON.stringify(config));

  const git = path.join(portable, 'tools', 'git', 'cmd', 'git.exe');
  const repository = path.join(root, 'plugin repository');
  const plugin = path.join(repository, 'plugins', 'portable-sample');
  await mkdir(plugin, { recursive: true });
  await writeFile(path.join(repository, 'repository.json'), JSON.stringify({
    schemaVersion: 1, name: 'Portable test', plugins: [{ id: 'portable-sample' }]
  }));
  await writeFile(path.join(plugin, 'plugin.json'), JSON.stringify({
    id: 'portable-sample', type: 'provider', apiVersion: 1, entry: './index.mjs', hosts: ['portable.example']
  }));
  await writeFile(path.join(plugin, 'index.mjs'), 'export function createAdapter() { return { match: () => false, resolve: async () => ({}) }; }');
  await exec(git, ['init', '--quiet'], { cwd: repository, env });
  await exec(git, ['add', '.'], { cwd: repository, env });
  await exec(git, ['-c', 'user.name=Package Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'sample'], { cwd: repository, env });

  // 模拟双击的无终端启动；等待 EXE 退出，不等待后台进程继承的管道 EOF。
  const launcher = spawn(path.join(portable, 'lulucute.exe'), ['--check'], {
    cwd: root, env, timeout: 45_000, windowsHide: true, stdio: 'ignore'
  });
  const [launcherCode] = await once(launcher, 'exit');
  assert.equal(launcherCode, 0, 'Portable EXE failed; see the packaged service log');
  const token = (await readFile(path.join(portable, '.data', 'server-token'), 'utf8')).trim();
  async function api(route, body) {
    const response = await fetch(`${endpoint}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    }).catch((error) => { throw new Error(`Packaged service request failed: ${route}`, { cause: error }); });
    const result = await response.json();
    assert.equal(response.ok, true, result.error);
    return result;
  }
  const catalog = await api('/api/plugins/repository', { repository });
  const installed = await api('/api/plugins/install', { catalogId: catalog.catalogId, id: 'portable-sample', enable: true });
  assert.equal(installed.enabled, true);
  await api('/api/service/reload', {});
  const plugins = await api('/api/plugins/installed');
  assert.equal(plugins.plugins[0].enabled, true);
  const { stdout: playwright } = await exec(path.join(portable, 'runtime', 'node.exe'), [
    '-e', 'console.log(Boolean(require("playwright-core").chromium))'
  ], { cwd: portable, env });
  assert.equal(playwright.trim(), 'true');

  await waitForIdleExit();
  const manifest = JSON.parse(await readFile(path.join(portable, '.data', 'com.resourcehub.launcher.json'), 'utf8'));
  const host = spawn(process.env.ComSpec, ['/d', '/s', '/c', `""${manifest.path}""`], {
    cwd: root, env, windowsHide: true, windowsVerbatimArguments: true
  });
  let stderr = '';
  host.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const chunks = [];
  host.stdout.on('data', (chunk) => chunks.push(chunk));
  const closed = once(host, 'close');
  const body = Buffer.from(JSON.stringify({ action: 'start' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  host.stdin.end(Buffer.concat([header, body]));
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  const response = Buffer.concat(chunks);
  assert.equal(response.length, 4 + response.readUInt32LE(0));
  assert.deepEqual(JSON.parse(response.subarray(4).toString('utf8')), { ok: true, started: true });
  const reloaded = await api('/api/plugins/installed');
  assert.equal(reloaded.plugins[0].enabled, true);
  completed = true;
});
