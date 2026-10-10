import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const run = promisify(execFile);
const maxBytes = 150 * 1024 * 1024;
const platformKey = `${process.platform}-${process.arch}`;

function safePath(value) {
  return typeof value === 'string' && value.split('/').every((part) =>
    /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part) && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) && !value.startsWith('-');
}

export function validatePluginTools(tools) {
  if (tools === undefined) return;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) throw new Error('插件 tools 必须是对象');
  for (const [id, tool] of Object.entries(tools)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !tool || typeof tool.version !== 'string' || !tool.version.trim()
      || !tool.platforms || typeof tool.platforms !== 'object' || Array.isArray(tool.platforms)) {
      throw new Error('插件工具 ID、版本或平台声明无效');
    }
    for (const [platform, spec] of Object.entries(tool.platforms)) {
      if (!/^(win32|darwin|linux)-(x64|arm64|ia32|arm)$/.test(platform)
        || !safePath(spec?.executable) || !Array.isArray(spec.downloads) || !spec.downloads.length) {
        throw new Error(`插件工具 ${id} 平台声明无效`);
      }
      const destinations = new Set();
      for (const artifact of spec.downloads) {
        let url;
        try { url = new URL(artifact.url); } catch { throw new Error(`插件工具 ${id} 下载地址无效`); }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash
          || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || !['file', 'gzip', 'tar', 'zip'].includes(artifact.format)) {
          throw new Error(`插件工具 ${id} 下载地址、SHA-256 或格式无效`);
        }
        const files = ['tar', 'zip'].includes(artifact.format) ? artifact.files : { [artifact.path]: artifact.path };
        if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) {
          throw new Error(`插件工具 ${id} 缺少文件声明`);
        }
        for (const [destination, member] of Object.entries(files)) {
          if (!safePath(destination) || !safePath(member) || destinations.has(destination)) {
            throw new Error(`插件工具 ${id} 文件路径无效或重复`);
          }
          destinations.add(destination);
        }
      }
      if (!destinations.has(spec.executable)) throw new Error(`插件工具 ${id} 缺少可执行文件`);
    }
  }
}

async function download(artifact) {
  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`工具下载失败：HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if ((size += value.length) > maxBytes) throw new Error('工具下载超过 150 MB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('工具 SHA-256 校验失败');
  return bytes;
}

export async function installPluginTools(directory, tools) {
  validatePluginTools(tools);
  if (!tools || !Object.keys(tools).length) return;
  const temporary = await mkdtemp(path.join(path.dirname(directory), 'tool-download-'));
  try {
    for (const [id, tool] of Object.entries(tools)) {
      const spec = tool.platforms[platformKey];
      if (!spec) throw new Error(`插件工具 ${id} 暂不支持 ${platformKey} 自动安装`);
      const target = path.join(directory, '.tools', id);
      await mkdir(target, { recursive: true });
      for (const artifact of spec.downloads) {
        const bytes = await download(artifact);
        if (['file', 'gzip'].includes(artifact.format)) {
          const output = artifact.format === 'gzip' ? gunzipSync(bytes, { maxOutputLength: maxBytes }) : bytes;
          await mkdir(path.dirname(path.join(target, artifact.path)), { recursive: true });
          await writeFile(path.join(target, artifact.path), output, { flag: 'wx' });
        } else {
          const archive = path.join(temporary, 'archive');
          await writeFile(archive, bytes);
          // 只将指定成员输出为普通文件，不展开归档中的路径或符号链接。
          const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
          for (const [destination, member] of Object.entries(artifact.files)) {
            const { stdout } = await run(tar, ['-xOf', archive, '--', member], {
              encoding: 'buffer', maxBuffer: maxBytes, timeout: 30_000, windowsHide: true
            });
            if (!stdout.length) throw new Error(`工具归档文件为空：${member}`);
            await mkdir(path.dirname(path.join(target, destination)), { recursive: true });
            await writeFile(path.join(target, destination), stdout, { flag: 'wx' });
          }
        }
      }
      await chmod(path.join(target, spec.executable), 0o755);
      await writeFile(path.join(target, 'source.json'), `${JSON.stringify(tool, null, 2)}\n`, { flag: 'wx' });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function pluginToolPaths(directory, tools) {
  const paths = {};
  for (const [id, tool] of Object.entries(tools || {})) {
    const spec = tool.platforms[platformKey];
    if (!spec) continue;
    const executable = path.join(directory, '.tools', id, spec.executable);
    try {
      if (!(await lstat(executable)).isFile()) throw new Error(`插件工具 ${id} 必须是普通文件`);
      paths[id] = executable;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return Object.freeze(paths);
}
