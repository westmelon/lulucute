#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const serverEntry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

function parseArguments(argv) {
  const index = argv.indexOf('--config');
  if (index === -1 || !argv[index + 1]) throw new Error('--config is required');
  return { config: path.resolve(argv[index + 1]) };
}

function readNativeMessage() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('error', onError);
      process.stdin.pause();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > 64 * 1024) {
        cleanup();
        reject(new Error('Native message is too large'));
        return;
      }
      if (buffer.length < length + 4) return;
      cleanup();
      try {
        resolve(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    };
    process.stdin.on('data', onData);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

async function writeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  await new Promise((resolve, reject) => {
    process.stdout.write(Buffer.concat([header, body]), (error) => error ? reject(error) : resolve());
  });
}

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

async function waitUntilReady(config, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serviceIsReady(config)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function startService(configPath) {
  const config = await loadConfig(configPath);
  if (await serviceIsReady(config)) return { ok: true, started: false };

  const dataDirectory = path.dirname(config.server.tokenFile);
  await mkdir(dataDirectory, { recursive: true });
  const log = await open(path.join(dataDirectory, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [serverEntry, '--config', configPath, '--managed'], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', log.fd, log.fd]
  });
  child.unref();
  await log.close();

  if (!await waitUntilReady(config)) {
    throw new Error(`本地服务未能在 15 秒内启动，请查看 ${path.join(dataDirectory, 'server.log')}`);
  }
  return { ok: true, started: true };
}

async function main() {
  try {
    const { config } = parseArguments(process.argv.slice(2));
    const message = await readNativeMessage();
    if (message?.action !== 'start') throw new Error('Unsupported native host action');
    await writeNativeMessage(await startService(config));
  } catch (error) {
    await writeNativeMessage({ ok: false, error: error.message }).catch(() => {});
    process.exitCode = 1;
  }
}

main();
