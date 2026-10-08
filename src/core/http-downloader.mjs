import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { allocateAvailablePath, sanitizeSegment } from './path-policy.mjs';

function filenameFromDisposition(value) {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1] || null;
}

function filenameFromUrl(url) {
  try {
    return decodeURIComponent(path.basename(new URL(url).pathname)) || 'download';
  } catch {
    return 'download';
  }
}

export class HttpDownloader {
  async download({ directUrl, directory, filename, headers = {}, signal, headersTimeoutMs, idleTimeoutMs }) {
    await mkdir(directory, { recursive: true });
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = headersTimeoutMs ? setTimeout(() => controller.abort(
      new Error(`Download response timed out after ${headersTimeoutMs} ms`)), headersTimeoutMs) : null;
    let response;
    try {
      response = await fetch(directUrl, {
        redirect: 'follow', headers,
        signal: requestSignal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with HTTP ${response.status}`);
    }

    const resolvedFilename = sanitizeSegment(
      filename ||
        filenameFromDisposition(response.headers.get('content-disposition')) ||
        filenameFromUrl(response.url)
    );
    const finalPath = await allocateAvailablePath(directory, resolvedFilename);
    const temporaryPath = `${finalPath}.part-${randomUUID()}`;
    let idleTimer;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      if (idleTimeoutMs) idleTimer = setTimeout(() => controller.abort(
        new Error(`Download stalled: no data for ${idleTimeoutMs} ms`)), idleTimeoutMs);
    };

    try {
      resetIdleTimer();
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({ transform(chunk, encoding, callback) {
          if (chunk.length) resetIdleTimer();
          callback(null, chunk);
        } }),
        createWriteStream(temporaryPath, { flags: 'wx' }),
        { signal: requestSignal }
      );
      clearTimeout(idleTimer);
      await rename(temporaryPath, finalPath);
      const fileStat = await stat(finalPath);
      return { path: finalPath, bytes: fileStat.size };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      requestSignal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(idleTimer);
    }
  }
}
