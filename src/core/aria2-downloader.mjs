import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sanitizeSegment } from './path-policy.mjs';

const exec = promisify(execFile);

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export class Aria2Downloader {
  constructor({ executable = 'aria2c', pollIntervalMs = 1_000,
    timeoutSeconds = 15, lowestSpeedLimit = 8 * 1024 } = {}) {
    this.executable = executable;
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutSeconds = timeoutSeconds;
    this.lowestSpeedLimit = lowestSpeedLimit;
  }

  async checkAvailable(signal) {
    await exec(this.executable, ['--version'], { signal, timeout: 5_000 });
  }

  async download({ urls, directory, filename, headers = {}, signal, onProgress = async () => {} }) {
    signal?.throwIfAborted();
    if (!urls?.length || urls.some((url) => !['http:', 'https:'].includes(new URL(url).protocol))) {
      throw new Error('aria2 需要有效的 HTTP 下载地址');
    }
    const headerLines = Object.entries(headers).map(([key, value]) => {
      if (/[\r\n]/.test(`${key}${value}`)) throw new Error('下载请求头包含非法换行');
      return `${key}: ${value}`;
    });
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, sanitizeSegment(filename));
    const controlDirectory = await mkdtemp(path.join(directory, '.aria2-rpc-'));
    let child;
    let closed;
    let exited = false;
    let launchError;
    try {
      const port = await availablePort();
      const secret = randomBytes(32).toString('hex');
      const config = path.join(controlDirectory, 'aria2.conf');
      await writeFile(config, `rpc-secret=${secret}\n`, { mode: 0o600 });
      child = spawn(this.executable, [
        `--conf-path=${config}`, '--async-dns=false', '--enable-rpc=true', '--rpc-listen-all=false',
        `--rpc-listen-port=${port}`, '--rpc-allow-origin-all=false',
        '--console-log-level=error', '--summary-interval=0', '--enable-color=false',
        '--show-console-readout=false', '--download-result=hide'
      ], { stdio: 'ignore', windowsHide: true });
      child.once('error', (error) => { launchError = error; });
      closed = new Promise((resolve) => child.once('close', () => { exited = true; resolve(); }));
      const rpc = async (method, params = []) => {
        const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1,
            method: `aria2.${method}`, params: [`token:${secret}`, ...params] }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000)
        });
        const payload = await response.json();
        if (!response.ok || payload.error) throw new Error('aria2 本机接口请求失败');
        return payload.result;
      };
      const startupDeadline = Date.now() + 10_000;
      while (true) {
        signal?.throwIfAborted();
        if (launchError) throw launchError;
        if (exited) throw new Error('aria2 启动失败，请检查可执行文件');
        try { await rpc('getVersion'); break; } catch {
          signal?.throwIfAborted();
          if (Date.now() >= startupDeadline) throw new Error('aria2 启动超时');
          await delay(100, undefined, { signal });
        }
      }
      // URLs and headers remain in memory; neither command lines nor logs contain signed media URLs.
      const options = {
        dir: path.resolve(directory), out: path.basename(target), header: headerLines,
        split: '4', 'max-connection-per-server': '2', 'min-split-size': '1M',
        'uri-selector': 'adaptive', 'lowest-speed-limit': String(this.lowestSpeedLimit),
        timeout: String(this.timeoutSeconds), 'connect-timeout': '10',
        'max-tries': '3', 'retry-wait': '1', continue: 'true',
        'auto-save-interval': '1', 'file-allocation': 'none',
        'allow-overwrite': 'false', 'auto-file-renaming': 'false',
        'always-resume': 'true', 'http-accept-gzip': 'false'
      };
      let gid = await rpc('addUri', [urls, options]);
      let slowRetry = false;
      while (true) {
        signal?.throwIfAborted();
        if (exited) throw new Error('aria2 下载进程意外退出');
        const status = await rpc('tellStatus', [gid, [
          'status', 'completedLength', 'totalLength', 'downloadSpeed', 'errorCode'
        ]]);
        await onProgress({ bytes: Number(status.completedLength),
          totalBytes: Number(status.totalLength), speed: Number(status.downloadSpeed) });
        signal?.throwIfAborted();
        if (status.status === 'complete') {
          const bytes = (await stat(target)).size;
          if (!bytes || bytes !== Number(status.totalLength)) throw new Error('aria2 下载文件大小不完整');
          return { path: target, bytes };
        }
        if (status.status === 'error' || status.status === 'removed') {
          if (status.errorCode === '5' && !slowRetry && this.lowestSpeedLimit > 1024) {
            slowRetry = true;
            await rpc('removeDownloadResult', [gid]);
            gid = await rpc('addUri', [urls, { ...options, split: '1',
              'max-connection-per-server': '1', 'lowest-speed-limit': '1024' }]);
            continue;
          }
          throw new Error(`aria2 下载失败（错误码 ${status.errorCode || 'unknown'}），请检查网络或重试`);
        }
        await delay(this.pollIntervalMs, undefined, { signal });
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      if (child && !exited) {
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
        await closed;
        clearTimeout(force);
      }
      await rm(controlDirectory, { recursive: true, force: true });
    }
  }
}
