import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { managePlugin } from '../src/core/plugin-installer.mjs';

const help = `lulucute 插件管理

用法：
  npm run plugins -- install <id> --repository <仓库地址或本地路径> --ref <版本> --config config.json
  npm run plugins -- update <id> --ref <新版本> --config config.json
  npm run plugins -- rollback <id> --config config.json
  npm run plugins -- uninstall <id> --config config.json

安装到配置 plugins.directories 的第一个目录；未指定配置时使用当前目录下的 plugins/。
安装不改变启用列表。将 ID 加入 plugins.enabled 后重启服务。
更新、回滚和卸载前请先停止服务。卸载同时清理插件工具和更新备份，并移除启用配置。
插件必须来自可信仓库，执行权限与本地服务相同。
`;

async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  const [action, id, ...options] = argv;
  const args = { action, id };
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    if (!['--config', '--repository', '--ref'].includes(option)) throw new Error(`未知参数：${option}`);
    const value = options[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} 需要一个值`);
    if (Object.hasOwn(args, option.slice(2))) throw new Error(`重复参数：${option}`);
    args[option.slice(2)] = value;
  }
  let directory = path.resolve('plugins');
  if (args.config) {
    const configPath = path.resolve(args.config);
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    const directories = raw.plugins?.directories ?? ['./plugins'];
    if (!Array.isArray(directories) || !directories.length || typeof directories[0] !== 'string' || !directories[0]) {
      throw new Error('配置 plugins.directories 必须至少包含一个安装目录');
    }
    directory = path.resolve(path.dirname(configPath), directories[0]);
  }
  const result = await managePlugin({ ...args, directory, configPath: args.config });
  console.log(JSON.stringify(result, null, 2));
  console.log(action === 'uninstall' ? '插件及附带工具、更新备份已卸载。' : '插件文件已就绪；确认 plugins.enabled 后重启服务生效。');
}

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
