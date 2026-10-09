import path from 'node:path';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const commitPattern = /^[a-f0-9]{40}$/i;

export function normalizeRepository(repository) {
  if (typeof repository !== 'string' || !repository.trim() || repository.startsWith('-')) {
    throw new Error('请指定公开 GitHub 仓库、raw 索引地址或本地目录');
  }
  if (/^[\w.-]+@[\w.-]+:/.test(repository)) throw new Error('仓库仅支持公开 GitHub HTTPS、raw 索引地址或本地目录');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(repository) || /^[A-Za-z]:[\\/]/.test(repository)) {
    return path.resolve(repository);
  }
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('仓库仅支持公开 GitHub HTTPS、raw 索引地址或本地目录，不能包含凭据');
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!['github.com', 'raw.githubusercontent.com'].includes(url.hostname)
    || segments.length < 2 || segments.some((part) => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error('仓库仅支持公开 GitHub HTTPS、raw 索引地址或本地目录');
  }
  if (url.hostname === 'github.com') {
    if (segments.length !== 2) throw new Error('请填写 GitHub 仓库根地址，版本填写到版本栏');
    return `https://github.com/${segments[0]}/${segments[1].replace(/\.git$/, '')}`;
  }
  if (segments.length < 4 || segments.at(-1) !== 'repository.json') {
    throw new Error('raw 地址必须指向 repository.json；含斜杠的分支请改用仓库地址和版本栏');
  }
  return url.href;
}

async function request(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'lulucute' }, redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new Error('插件下载失败，请检查网络及 GitHub/raw 域名访问', { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error('插件仓库或版本不存在，请确认仓库已公开');
    if ([403, 429].includes(response.status)) throw new Error('GitHub 访问受限或请求次数已用完，请稍后重试');
    throw new Error(`插件下载失败：HTTP ${response.status}`);
  }
  return response;
}

async function localDigest(directory) {
  const hash = createHash('sha1');
  async function walk(current, relative = '') {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const name = `${relative}${entry.name}`;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target, `${name}/`);
      else if (entry.isFile()) {
        hash.update(`${name}\0`);
        hash.update(createHash('sha1').update(await readFile(target)).digest());
      } else throw new Error('插件目录不能包含符号链接或特殊文件');
    }
  }
  await walk(directory);
  return hash.digest('hex');
}

export async function checkoutRepository(checkout, repository, ref) {
  await mkdir(checkout);
  if (!repository.startsWith('https://')) {
    // 安装读取本地目录当前内容；内容指纹防止列表读取后目录变化。
    await cp(repository, checkout, { recursive: true, filter: (source) => path.basename(source) !== '.git' });
    const digest = await localDigest(checkout);
    if (ref !== 'HEAD' && ref !== digest) throw new Error('本地目录内容已变化或指定了 Git 版本，请重新读取目录；本地目录只支持 HEAD 或内容指纹');
    return digest;
  }

  const url = new URL(repository);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [owner, repo] = segments;
  const raw = url.hostname === 'raw.githubusercontent.com';
  const prefix = raw ? segments.slice(3, -1).join('/') : '';
  const version = ref === 'HEAD' && raw ? segments[2] : ref;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  let commit = version;
  if (!commitPattern.test(commit)) {
    const endpoint = version === 'HEAD' ? `${api}/commits?per_page=1` : `${api}/commits/${encodeURIComponent(version)}`;
    const info = await (await request(endpoint)).json();
    commit = version === 'HEAD' ? info[0]?.sha : info.sha;
  }
  if (!commitPattern.test(commit)) throw new Error('GitHub 未返回有效 commit');
  const tree = await (await request(`${api}/git/trees/${commit}?recursive=1`)).json();
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('GitHub 文件列表不完整，无法安装插件');
  const root = prefix ? `${prefix}/` : '';
  const files = tree.tree.filter((file) => file.path === `${root}repository.json` || file.path.startsWith(`${root}plugins/`));
  let total = 0;
  for (const file of files) {
    const relative = file.path.slice(root.length);
    const parts = relative.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part)
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error('插件文件路径无效');
    }
    if (file.type === 'tree' && file.mode === '040000') continue;
    if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) throw new Error('插件包不能包含符号链接或子模块');
    if (!Number.isInteger(file.size) || file.size < 0 || (total += file.size) > 50 * 1024 * 1024) throw new Error('插件仓库文件超过 50 MB');
    const response = await request(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${file.path.split('/').map(encodeURIComponent).join('/')}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (bytes.length !== file.size || digest !== file.sha) throw new Error(`插件文件校验失败：${relative}`);
    const target = path.join(checkout, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return commit;
}
