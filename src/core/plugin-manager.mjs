import { randomUUID } from 'node:crypto';
import { enablePlugin } from '../config.mjs';
import { listInstalledPlugins, managePlugin, readPluginRepository } from './plugin-installer.mjs';

export class PluginManager {
  constructor({ config, configPath }) {
    this.config = config;
    this.configPath = configPath;
    this.catalogs = new Map();
  }

  async browse({ repository, ref }) {
    const catalog = await readPluginRepository({ repository, ref: ref || 'HEAD' });
    const installed = await listInstalledPlugins(this.config.plugins.directories);
    const catalogId = randomUUID();
    this.catalogs.set(catalogId, catalog);
    if (this.catalogs.size > 8) this.catalogs.delete(this.catalogs.keys().next().value);
    return { ...catalog, catalogId, plugins: catalog.plugins.map((plugin) => ({ ...plugin,
      installed: installed.some((item) => item.id === plugin.id),
      enabled: this.config.plugins.enabled.includes(plugin.id) })) };
  }

  async install({ catalogId, id, enable = false }) {
    if (typeof enable !== 'boolean') throw new Error('enable 必须为布尔值');
    const catalog = this.catalogs.get(catalogId);
    const plugin = catalog?.plugins.find((item) => item.id === id);
    if (!plugin) throw new Error('插件列表已失效或所选插件不在列表中，请重新读取仓库');
    if (!plugin.compatible) throw new Error('插件 API 版本不兼容');
    const directory = this.config.plugins.directories[0];
    if (!directory) throw new Error('未配置插件安装目录');
    const installed = await listInstalledPlugins(this.config.plugins.directories);
    if (installed.some((item) => item.id === id)) throw new Error('插件已安装；更新请使用插件管理命令');
    const result = await managePlugin({ action: 'install', id, directory,
      repository: catalog.repository, ref: catalog.commit });
    let warning;
    let enabled = this.config.plugins.enabled.includes(id);
    if (enable && !enabled) {
      try {
        await enablePlugin(this.configPath, id);
        this.config.plugins.enabled.push(id);
        enabled = true;
      } catch {
        warning = '插件已安装，但启用配置保存失败；请检查配置文件权限并手动启用';
      }
    }
    return { ...result, enabled, warning, restartRequired: true };
  }
}
