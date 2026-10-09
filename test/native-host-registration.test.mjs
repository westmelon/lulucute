import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { installNativeHost } from '../src/core/native-host-registration.mjs';

const extensionId = 'adnhnlfllcfaaicijnclpeaogmebpclf';
const registryKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.resourcehub.launcher';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = path.join(root, "服务 & user's ! project");
  await mkdir(path.join(projectDirectory, 'extension'), { recursive: true });
  await mkdir(path.join(projectDirectory, 'scripts'));
  await copyFile(new URL('../extension/manifest.json', import.meta.url), path.join(projectDirectory, 'extension', 'manifest.json'));
  const configPath = path.join(root, "配置 & user's ! settings.json");
  const homeDirectory = path.join(root, 'home');
  return { root, projectDirectory, configPath, homeDirectory };
}

test('Windows registration is user-scoped and only allows the stable extension', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const result = await installNativeHost({ ...f, platform: 'win32', run: async (...args) => calls.push(args) });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(result.extensionId, extensionId);
  assert.equal(manifest.name, 'com.resourcehub.launcher');
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, result.launcherPath);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.deepEqual(calls, [['reg.exe', [
    'add', registryKey, '/ve', '/t', 'REG_SZ', '/d', result.manifestPath, '/f', '/reg:32'
  ], { windowsHide: true, timeout: 10_000 }]]);
  const launcher = await readFile(result.launcherPath, 'utf8');
  assert.match(launcher, /@echo off\r\nsetlocal DisableDelayedExpansion\r\n/);
  assert.ok(launcher.includes(`--config "${f.configPath}"`));
});

test('re-registering refreshes the config and Node path and safely escapes batch percent signs', async (t) => {
  const f = await fixture(t);
  const options = { ...f, platform: 'win32', run: async () => {} };
  const before = await installNativeHost(options);
  const configPath = path.join(f.root, 'new %TEMP% config.json');
  const nodeExecutable = path.join(f.root, 'Node %TOOLS%', 'node.exe');
  const after = await installNativeHost({ ...options, configPath, nodeExecutable });
  assert.equal(before.manifestPath, after.manifestPath);
  const launcher = await readFile(after.launcherPath, 'utf8');
  assert.ok(launcher.includes(`"${nodeExecutable.replaceAll('%', '%%')}"`));
  assert.ok(launcher.includes(`--config "${configPath.replaceAll('%', '%%')}"`));
  assert.ok(!launcher.includes(f.configPath));
});

test('macOS registration preserves the user manifest location and executable launcher', async (t) => {
  const f = await fixture(t);
  const result = await installNativeHost({ ...f, platform: 'darwin', run: async () => assert.fail('macOS must not invoke reg.exe') });
  assert.equal(result.manifestPath, path.join(f.homeDirectory, 'Library', 'Application Support', 'Google',
    'Chrome', 'NativeMessagingHosts', 'com.resourcehub.launcher.json'));
  if (process.platform !== 'win32') assert.equal((await stat(result.launcherPath)).mode & 0o777, 0o700);
});

test('invalid platform or missing extension key never registers a host', async (t) => {
  const f = await fixture(t);
  const run = async () => assert.fail('invalid input must not register');
  await assert.rejects(installNativeHost({ ...f, platform: 'linux', run }), /Windows and macOS only/);
  await writeFile(path.join(f.projectDirectory, 'extension', 'manifest.json'), '{}');
  await assert.rejects(installNativeHost({ ...f, platform: 'win32', run }), /stable key/);
});

test('registry failures are reported to the caller', async (t) => {
  const f = await fixture(t);
  await assert.rejects(installNativeHost({ ...f, platform: 'win32', run: async () => {
    throw new Error('registry access denied');
  } }), /registry access denied/);
});

test('Windows can write and read back the user registry manifest path', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const f = await fixture(t);
  const exec = promisify(execFile);
  const testKey = `${registryKey}.test_${path.basename(f.root)}`;
  t.after(() => exec('reg.exe', ['delete', testKey, '/f', '/reg:32'], { windowsHide: true }));
  const result = await installNativeHost({ ...f, run: (command, args, options) => {
    return exec(command, args.map((value) => value === registryKey ? testKey : value), options);
  } });
  const { stdout } = await exec('reg.exe', ['query', testKey, '/ve', '/reg:32'], { encoding: 'buffer', windowsHide: true });
  const decoded = stdout.toString('utf8');
  assert.match(decoded, /REG_SZ/);
  // reg.exe uses the system code page, so verify the ASCII filename suffix only.
  assert.ok(decoded.includes(path.basename(result.manifestPath)));
});

test('the platform launcher keeps framed stdout clean and preserves Unicode and spaced paths', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.projectDirectory, 'scripts', 'native-host.mjs'), `
    process.stdin.once('data', () => {
      const config = process.argv[process.argv.indexOf('--config') + 1];
      const body = Buffer.from(JSON.stringify({ config, node: process.execPath }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      process.stdout.write(Buffer.concat([header, body]));
    });
  `);
  const configPath = path.join(f.root, "配置 %USERPROFILE% & user's ! settings.json");
  const result = await installNativeHost({ ...f, configPath, run: async () => {} });
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${result.launcherPath}""`], {
      windowsHide: true, windowsVerbatimArguments: true
    })
    : spawn(result.launcherPath);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const closed = once(child, 'close');
  child.stdin.end(Buffer.from([2, 0, 0, 0, 123, 125]));
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  const response = Buffer.concat(chunks);
  assert.equal(response.length, 4 + response.readUInt32LE(0));
  assert.deepEqual(JSON.parse(response.subarray(4).toString('utf8')), { config: configPath, node: process.execPath });
});
