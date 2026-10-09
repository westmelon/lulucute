#!/usr/bin/env node
import path from 'node:path';
import { startLocalService } from '../src/core/local-service-launcher.mjs';

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

async function main() {
  try {
    const { config } = parseArguments(process.argv.slice(2));
    const message = await readNativeMessage();
    if (message?.action !== 'start') throw new Error('Unsupported native host action');
    await writeNativeMessage(await startLocalService(config));
  } catch (error) {
    await writeNativeMessage({ ok: false, error: error.message }).catch(() => {});
    process.exitCode = 1;
  }
}

main();
