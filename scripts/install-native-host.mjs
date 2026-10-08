#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.resourcehub.launcher';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const extensionManifestPath = path.join(projectRoot, 'extension', 'manifest.json');

function extensionIdFromKey(key) {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16);
  return [...digest].map((byte) => (
    String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))
  )).join('');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('The native host installer currently supports macOS only');
  }

  const extensionManifest = JSON.parse(await readFile(extensionManifestPath, 'utf8'));
  if (!extensionManifest.key) throw new Error('extension/manifest.json is missing its stable key');
  const extensionId = extensionIdFromKey(extensionManifest.key);
  const dataDirectory = path.join(projectRoot, '.data');
  const launcherPath = path.join(dataDirectory, 'native-host-launcher');
  const configPath = path.join(projectRoot, 'config.json');
  const nativeHostPath = path.join(projectRoot, 'scripts', 'native-host.mjs');
  const manifestDirectory = path.join(
    os.homedir(),
    'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'
  );
  const nativeManifestPath = path.join(manifestDirectory, `${HOST_NAME}.json`);

  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    launcherPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(nativeHostPath)} --config ${shellQuote(configPath)}\n`,
    { encoding: 'utf8', mode: 0o700 }
  );
  await chmod(launcherPath, 0o700);
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(nativeManifestPath, `${JSON.stringify({
    name: HOST_NAME,
    description: 'Start lulucute local service on demand',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  console.log(`Native host installed for extension ${extensionId}`);
  console.log(`Manifest: ${nativeManifestPath}`);
  console.log('Reload the unpacked extension in chrome://extensions/.');
  console.log(`If its ID is not ${extensionId}, remove it and load the extension directory again.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
