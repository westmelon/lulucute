import os from 'node:os';
import path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { installNativeHost } from './native-host-registration.mjs';
import { startLocalService } from './local-service-launcher.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function startPortableService({
  projectDirectory = projectRoot,
  homeDirectory = os.homedir(),
  register = installNativeHost
} = {}) {
  const configPath = path.join(projectDirectory, 'config.json');
  try {
    await access(configPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const initial = JSON.parse(await readFile(path.join(projectDirectory, 'config.example.json'), 'utf8'));
    initial.downloadRoot = path.join(homeDirectory, 'Downloads', 'lulucute');
    try {
      await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`, { flag: 'wx' });
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
    }
  }

  const config = await loadConfig(configPath);
  let firstSetup = false;
  try { await access(config.server.tokenFile); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    firstSetup = true;
  }
  await startLocalService(configPath, { projectDirectory });
  let registrationError = '';
  try {
    await register({ configPath, projectDirectory });
  } catch (error) {
    registrationError = error.message;
  }
  return {
    endpoint: `http://127.0.0.1:${config.server.port}/`,
    token: (await readFile(config.server.tokenFile, 'utf8')).trim(),
    extensionDirectory: path.join(projectDirectory, 'extension'),
    downloadRoot: config.downloadRoot,
    firstSetup,
    registrationError
  };
}
