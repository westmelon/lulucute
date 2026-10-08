import path from 'node:path';
import { access } from 'node:fs/promises';

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function sanitizeSegment(value, fallback = 'unknown') {
  let segment = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!segment || segment === '.' || segment === '..') segment = fallback;
  if (RESERVED_WINDOWS_NAMES.test(segment)) segment = `_${segment}`;
  return segment.slice(0, 100);
}

export function buildTargetDirectory(downloadRoot, source) {
  const root = path.resolve(downloadRoot);
  const segments = [source.forum, source.section, source.threadTitle]
    .map((value) => sanitizeSegment(value));
  const target = path.resolve(root, ...segments);

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Resolved download directory escaped the configured root');
  }
  return target;
}

export async function allocateAvailablePath(directory, filename) {
  const parsed = path.parse(sanitizeSegment(filename, 'download'));
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : ` (${index})`;
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    try {
      await access(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error(`Unable to allocate a unique filename for ${filename}`);
}
