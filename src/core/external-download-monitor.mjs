import path from 'node:path';
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { allocateAvailablePath } from './path-policy.mjs';

const TEMPORARY_NAME = /(?:\.baiduyun(?:\.p)?\.downloading|\.crdownload|\.download|\.part)$/i;

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function inspectEntry(target, relativeName = path.basename(target)) {
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], temporary: false };
    throw error;
  }

  if (!metadata.isFile() && !metadata.isDirectory()) {
    return { records: [], temporary: false, unsafe: true };
  }

  const temporary = TEMPORARY_NAME.test(relativeName);
  const records = [
    `${relativeName}\0${metadata.isDirectory() ? 'd' : 'f'}\0${metadata.size}\0${metadata.mtimeMs}`
  ];
  let unsafe = false;

  if (metadata.isDirectory()) {
    let children;
    try {
      children = await readdir(target, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (error.code === 'ENOENT') return { records: [], temporary: false };
      throw error;
    }
    for (const child of children) {
      const childRelative = path.join(relativeName, child.name);
      const result = await inspectEntry(path.join(target, child.name), childRelative);
      records.push(...result.records);
      unsafe ||= result.unsafe;
      if (result.temporary) return { records, temporary: true, unsafe };
    }
  }

  return { records, temporary, unsafe };
}

export class ExternalDownloadMonitor {
  constructor({ root, timeoutMs = 60 * 60_000, pollIntervalMs = 2_000, quietPeriodMs = 15_000 }) {
    this.root = path.resolve(root);
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.quietPeriodMs = quietPeriodMs;
  }

  async captureBaseline() {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    return new Set(entries.map((entry) => entry.name));
  }

  async waitForCompleted({ baseline, destination, signal }) {
    const resolvedDestination = path.resolve(destination);
    if (!isInside(this.root, resolvedDestination)) {
      throw new Error('External download destination must be below the configured download root');
    }

    const deadline = Date.now() + this.timeoutMs;
    const destinationRootEntry = path.relative(this.root, resolvedDestination).split(path.sep)[0];
    let previousFingerprint = '';
    let unchangedSince = 0;

    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const entries = await readdir(this.root, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => (
          !baseline.has(entry.name)
          && !entry.name.startsWith('.')
          && entry.name !== destinationRootEntry
        ))
        .sort((left, right) => left.name.localeCompare(right.name));

      const details = [];
      for (const candidate of candidates) {
        details.push({
          name: candidate.name,
          ...(await inspectEntry(path.join(this.root, candidate.name), candidate.name))
        });
      }

      const fingerprint = details.flatMap((detail) => detail.records).join('\n');
      if (fingerprint !== previousFingerprint) {
        previousFingerprint = fingerprint;
        unchangedSince = Date.now();
      }

      const settled = details.length > 0
        && details.every((detail) => !detail.temporary && !detail.unsafe && detail.records.length > 0)
        && Date.now() - unchangedSince >= this.quietPeriodMs;

      if (settled) {
        signal?.throwIfAborted();
        await mkdir(resolvedDestination, { recursive: true });
        const moves = [];
        for (const detail of details) {
          signal?.throwIfAborted();
          const target = await allocateAvailablePath(resolvedDestination, detail.name);
          moves.push({ source: path.join(this.root, detail.name), target });
        }
        signal?.throwIfAborted();
        for (const move of moves) await rename(move.source, move.target);
        return { status: 'completed', paths: moves.map((move) => move.target) };
      }

      await sleep(this.pollIntervalMs, signal);
    }

    return { status: 'action-required', reason: 'download-timeout', candidates: [] };
  }
}
