import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function serviceIsReady(config) {
  let token;
  try {
    token = (await readFile(config.server.tokenFile, 'utf8')).trim();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${config.server.port}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startLocalService(configPath, { projectDirectory = projectRoot } = {}) {
  const config = await loadConfig(configPath);
  if (await serviceIsReady(config)) return { ok: true, started: false };

  const dataDirectory = path.dirname(config.server.tokenFile);
  await mkdir(dataDirectory, { recursive: true });
  const logPath = path.join(dataDirectory, 'server.log');
  const log = await open(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(projectDirectory, 'src', 'server.mjs'), '--config', configPath, '--managed'], {
      cwd: projectDirectory,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd]
    });
    await once(child, 'spawn');
    child.unref();
  } finally {
    await log.close();
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await serviceIsReady(config)) return { ok: true, started: true };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`本地服务未能在 15 秒内启动，请查看 ${logPath}`);
}
