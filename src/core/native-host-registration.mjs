import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.resourcehub.launcher';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function batchQuote(value) {
  if (/["\r\n]/.test(value)) throw new Error('Native host paths cannot contain quotes or newlines');
  return `"${value.replaceAll('%', '%%')}"`;
}

export async function installNativeHost({
  configPath,
  projectDirectory = projectRoot,
  platform = process.platform,
  homeDirectory = os.homedir(),
  nodeExecutable = process.execPath,
  run = exec
} = {}) {
  if (!['darwin', 'win32'].includes(platform)) {
    throw new Error('The native host installer currently supports Windows and macOS only');
  }

  const extensionManifest = JSON.parse(await readFile(path.join(projectDirectory, 'extension', 'manifest.json'), 'utf8'));
  if (!extensionManifest.key) throw new Error('extension/manifest.json is missing its stable key');
  const digest = createHash('sha256').update(Buffer.from(extensionManifest.key, 'base64')).digest().subarray(0, 16);
  const extensionId = [...digest].map((byte) => (
    String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))
  )).join('');
  const absoluteConfigPath = path.resolve(configPath || path.join(projectDirectory, 'config.json'));
  const dataDirectory = path.join(projectDirectory, '.data');
  const launcherPath = path.join(dataDirectory, platform === 'win32' ? 'native-host-launcher.cmd' : 'native-host-launcher');
  const nativeHostPath = path.join(projectDirectory, 'scripts', 'native-host.mjs');
  const manifestDirectory = platform === 'win32' ? dataDirectory : path.join(
    homeDirectory, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'
  );
  const manifestPath = path.join(manifestDirectory, `${HOST_NAME}.json`);
  const launcher = platform === 'win32'
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n${batchQuote(nodeExecutable)} ${batchQuote(nativeHostPath)} --config ${batchQuote(absoluteConfigPath)}\r\n`
    : `#!/bin/sh\nexec ${shellQuote(nodeExecutable)} ${shellQuote(nativeHostPath)} --config ${shellQuote(absoluteConfigPath)}\n`;

  await mkdir(dataDirectory, { recursive: true });
  await writeFile(launcherPath, launcher, { encoding: 'utf8', mode: 0o700 });
  if (platform === 'darwin') await chmod(launcherPath, 0o700);
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({
    name: HOST_NAME,
    description: 'Start lulucute local service on demand',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  if (platform === 'win32') {
    await run('reg.exe', [
      'add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:32'
    ], { windowsHide: true, timeout: 10_000 });
  }
  return { extensionId, manifestPath, launcherPath };
}
