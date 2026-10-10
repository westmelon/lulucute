import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { managePlugin } from '../src/core/plugin-installer.mjs';
import { loadLocalPlugins } from '../src/core/plugin-loader.mjs';
import { validatePluginTools } from '../src/core/plugin-tools.mjs';

const run = promisify(execFile);
const platform = `${process.platform}-${process.arch}`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin tools 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  const source = path.join(repository, 'plugins', 'media');
  await mkdir(source, { recursive: true });
  const manifest = { id: 'media', type: 'provider', apiVersion: 1, entry: './index.mjs', hosts: ['example.com'] };
  await writeFile(path.join(source, 'index.mjs'), `export function createAdapter({ services }) {
    return { match: () => true, resolve: async () => services.toolPaths };
  }`);
  const archiveRoot = path.join(root, 'archive contents');
  await mkdir(archiveRoot);
  await writeFile(path.join(archiveRoot, 'aria2c'), 'aria2 version one');
  await writeFile(path.join(archiveRoot, 'COPYING'), 'license');
  const archive = path.join(root, 'aria2.tar.gz');
  await run('tar', ['-czf', archive, '-C', archiveRoot, 'aria2c', 'COPYING']);
  const tar = await readFile(archive);
  const gz = gzipSync(Buffer.from('ffmpeg version one'));
  const files = new Map([['https://tools.example/aria2.tar.gz', tar], ['https://tools.example/ffmpeg.gz', gz]]);
  const artifact = (url, format, extra) => ({ url, format,
    sha256: createHash('sha256').update(files.get(url)).digest('hex'), ...extra });
  const tools = {
    aria2: { version: '1', platforms: { [platform]: { executable: 'bin/aria2c', downloads: [
      artifact('https://tools.example/aria2.tar.gz', 'tar', { files: { 'bin/aria2c': 'aria2c', LICENSE: 'COPYING' } })
    ] } } },
    ffmpeg: { version: '1', platforms: { [platform]: { executable: 'ffmpeg', downloads: [
      artifact('https://tools.example/ffmpeg.gz', 'gzip', { path: 'ffmpeg' })
    ] } } }
  };
  async function save(value = tools) {
    await writeFile(path.join(source, 'plugin.json'), JSON.stringify({ ...manifest, tools: value }));
  }
  await save();
  t.mock.method(globalThis, 'fetch', async (url) => new Response(files.get(url), { status: files.has(url) ? 200 : 404 }));
  const directory = path.join(root, 'installed plugins');
  const options = { id: 'media', directory, repository, ref: 'HEAD' };
  return { root, directory, source, tools, files, save, options };
}

test('installation prepares checked archives and gzip tools, licenses and absolute factory paths', async (t) => {
  const f = await fixture(t);
  const result = await managePlugin({ ...f.options, action: 'install' });
  const loaded = await loadLocalPlugins({ plugins: { directories: [f.directory], enabled: ['media'] } }, { log: () => {} });
  const paths = await loaded.providers[0].resolve();
  assert.equal(paths.aria2, path.join(result.directory, '.tools/aria2/bin/aria2c'));
  assert.equal(paths.ffmpeg, path.join(result.directory, '.tools/ffmpeg/ffmpeg'));
  assert.equal(await readFile(paths.ffmpeg, 'utf8'), 'ffmpeg version one');
  assert.equal(await readFile(path.join(result.directory, '.tools/aria2/LICENSE'), 'utf8'), 'license');
  assert.equal(JSON.parse(await readFile(path.join(result.directory, '.tools/aria2/source.json'), 'utf8')).version, '1');
  assert.equal(globalThis.fetch.mock.calls.length, 2);
  assert.deepEqual((await readdir(f.root)).sort(), ['archive contents', 'aria2.tar.gz', 'installed plugins', 'repository']);
});

test('tool update and rollback restore matching binaries; checksum and network failures keep existing files', async (t) => {
  const f = await fixture(t);
  const first = await managePlugin({ ...f.options, action: 'install' });
  const updatedBytes = gzipSync(Buffer.from('ffmpeg version two'));
  f.files.set('https://tools.example/ffmpeg.gz', updatedBytes);
  const spec = f.tools.ffmpeg.platforms[platform].downloads[0];
  spec.sha256 = createHash('sha256').update(updatedBytes).digest('hex');
  f.tools.ffmpeg.version = '2';
  await f.save();
  const updated = await managePlugin({ ...f.options, action: 'update' });
  const binary = path.join(first.directory, '.tools/ffmpeg/ffmpeg');
  assert.equal(await readFile(binary, 'utf8'), 'ffmpeg version two');
  assert.equal(await readFile(path.join(updated.backup, '.tools/ffmpeg/ffmpeg'), 'utf8'), 'ffmpeg version one');
  await managePlugin({ ...f.options, action: 'rollback' });
  assert.equal(await readFile(binary, 'utf8'), 'ffmpeg version one');
  const backupRoot = path.join(f.root, '.installed plugins-backups/media');
  const backups = await readdir(backupRoot);
  spec.sha256 = '0'.repeat(64);
  await f.save();
  await assert.rejects(managePlugin({ ...f.options, action: 'update' }), /校验失败/);
  assert.equal(await readFile(binary, 'utf8'), 'ffmpeg version one');
  assert.deepEqual(await readdir(backupRoot), backups);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(managePlugin({ ...f.options, action: 'update' }), /HTTP 503/);
  assert.equal(await readFile(binary, 'utf8'), 'ffmpeg version one');
  assert.equal((await readdir(f.root)).some((name) => /stage|lock/.test(name)), false);
});

test('tool manifests reject traversal, duplicate files, unverified downloads and unsupported platforms', async (t) => {
  const f = await fixture(t);
  for (const update of [
    (spec) => { spec.executable = '../outside'; },
    (spec) => { spec.downloads[0].files['../outside'] = 'aria2c'; },
    (spec) => { spec.downloads[0].files['bin/aria2c'] = '../outside'; },
    (spec) => { spec.downloads[0].sha256 = ''; },
    (spec) => { spec.downloads[0].url = 'http://tools.example/aria2'; },
    (spec) => { spec.downloads.push(spec.downloads[0]); }
  ]) {
    const tools = structuredClone(f.tools);
    update(tools.aria2.platforms[platform]);
    assert.throws(() => validatePluginTools(tools), /无效|缺少/);
  }
  await f.save({ aria2: { version: '1', platforms: {} } });
  await assert.rejects(managePlugin({ ...f.options, action: 'install' }), /暂不支持/);
  assert.equal(globalThis.fetch.mock.calls.length, 0);
  await assert.rejects(access(path.join(f.directory, 'media')), { code: 'ENOENT' });
});
