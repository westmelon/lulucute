# lulucute 本地插件 API

本地插件由一个 `plugin.json` 和一个 JavaScript 入口组成。服务只执行配置中明确启用的插件；插件代码属于可信本地代码，不在沙箱中运行。

## Manifest

```json
{
  "id": "my-forum",
  "name": "My Forum",
  "type": "forum",
  "apiVersion": 1,
  "entry": "./index.mjs",
  "hosts": ["forum.example.com", "*.mirror.example.com"]
}
```

- `id`：全局唯一的小写 ID，只能包含字母、数字和连字符。
- `name`：可选的界面显示名称。
- `type`：`forum`（网站来源）、`provider`（网盘/媒体下载）或 `bundle`（同一包提供多个适配器）。
- `apiVersion`：当前固定为 `1`。
- `entry`：插件目录内的 `.mjs` 或 `.js` 入口，不允许指向目录外。
- `hosts`：插件声明支持的域名，支持 `*.example.com`。侧边栏用网站插件的域名识别当前页面，后端仍以适配器的 `match()` 结果为准。已安装但未启用的插件域名会阻止通用直链兜底，避免下载分享网页。
- `loginUrl`：可选的 HTTP(S) 登录地址，由核心打开复用现有资料目录的登录窗口。
- `actions`：可选的界面动作数组，见下文。

单适配器入口导出 `createAdapter()`，也可以使用默认导出。工厂接收已经解析的应用配置、只读 manifest 和通用服务：

```js
export function createAdapter({ config, manifest, services }) {
  return new MyAdapter(config, manifest);
}
```

`services` 提供 `Aria2Downloader`、`ExternalDownloadMonitor`、`allocateAvailablePath` 与 `sanitizeSegment`，插件通过工厂注入这些工具，无需引用核心源码的相对路径。插件专属配置放在 `config.plugins.options[manifest.id]`，由插件工厂自行校验。未启用插件的入口不会执行，但安装目录中的 manifest 仍会读取并校验。

`bundle` 的入口导出 `createAdapters()`（或默认工厂），返回 `forums` 和/或 `providers` 数组；至少提供一个适配器。原有 API 版本 1 的单适配器插件保持兼容。

```js
export function createAdapters({ config, services }) {
  return {
    forums: [new MySiteAdapter()],
    providers: [new MyMediaAdapter(config, services)]
  };
}
```

## 论坛适配器

论坛适配器必须实现：

```js
class MyForumAdapter {
  match(url) {}
  async inspect(page, url, { navigate = true } = {}) {}
  async reply(page, message) {}
  async extractResources(page, source) {}
}
```

`inspect()` 返回帖子是否锁定及归档元数据：

```js
{
  locked: true,
  source: {
    forum: "My Forum",
    section: "Music",
    threadId: "123",
    threadTitle: "Album"
  }
}
```

`reply()` 需要等待论坛确认回帖成功或抛出包含站点原因的错误。`extractResources()` 返回资源数组：

```js
[
  {
    url: "https://cloud.example.com/share/example",
    code: "abcd",
    source
  }
]
```

`provider` 可以省略，由启用的下载插件按 URL 匹配；网站插件只解析链接和提取码，不维护网盘域名列表。有特定媒体标识时仍可显式提供 `provider`，例如使用稳定媒体 ID 的资源。下载插件依启用顺序匹配，最后才使用普通 HTTP 直链兜底。

来源适配器可提供两个同步可选方法：

```js
normalizeUrl(value) { /* 返回站点规范 URL；不处理的链接返回 null */ }
shouldRefresh(url) { /* 完成任务再次提交时是否进行增量同步 */ }
```

核心对任务 URL 和资源指纹使用同一规范化规则。方法不应执行网络操作；规则变化可能改变既有资源指纹，应保证兼容性。核心会继续校验返回 URL 的协议与凭据，并排序查询参数。

## 登录与界面动作

下面的 manifest 字段会自动驱动侧边栏，无需新增站点专属界面代码：

```json
{
  "loginUrl": "https://example.com/login",
  "actions": [{
    "id": "all-items",
    "label": "下载合集全部内容（一个任务）",
    "pathPattern": "^/collection/[^/]+/?$",
    "query": { "scope": "all" },
    "taskLabel": "合集全部内容"
  }]
}
```

动作按 `pathPattern` 匹配当前 URL 路径，点击后设置 `query` 中的查询参数并提交一个任务。`taskLabel` 可选，用于标识满足同样路径与参数的任务。多个动作可以并列显示。

登录接口为 `POST /api/plugins/<id>/login` 和 `POST /api/plugins/<id>/login/finish`，仍需要本地服务令牌。旧的 `/api/<id>/login` 路径兼容。只有已启用且声明了登录地址的插件可打开窗口，运行任务时不能打开；状态包含 `browser.loginStatus` 和 `browser.loginPluginId`，关闭最后一个登录标签会释放资料目录并恢复队列。

## 网盘适配器

网盘适配器必须实现：

```js
class MyProviderAdapter {
  match(resource) {}
  async resolve(context, resource, { directory, signal } = {}) {}
}
```

如果得到浏览器可直接下载的地址，`resolve()` 返回：

```js
{
  ...resource,
  directUrl: "https://download.example.com/file.zip",
  filename: "file.zip",
  headers: { Referer: resource.url }
}
```

如果插件已经自行完成下载，返回 `status: "downloaded"` 和最终文件路径；需要人工处理时返回 `status: "action-required"` 及原因。所有长时间操作都应定期调用 `signal?.throwIfAborted()`。

## 安装

需要页面自动发现时，仓库根目录提供 `repository.json`，规范见 [插件仓库规范 v1](plugin-repository.md)。包内 manifest 仍是能力定义的唯一来源，原 API 版本不变。

站点插件在独立 Git 仓库的 `plugins/<id>/` 中维护，可使用主项目的安装器：

```bash
npm run plugins -- install my-forum --repository <仓库地址或本地路径> --ref <分支、标签或commit> --config config.json
npm run plugins -- update my-forum --ref <新版本> --config config.json
npm run plugins -- rollback my-forum --config config.json
```

安装器仅校验包结构与语法，不执行入口。API 版本相同不代表代码可信；插件接口完整性和工厂配置仍在服务启动时验证。安装记录含来源、ref、commit；更新保留旧版本供回滚。更新和回滚前停止服务，重启后生效。

1. 使用安装命令，或将插件目录复制到 `plugins/`，或把它的父目录加入 `plugins.directories`。
2. 将插件 `id` 加入 `plugins.enabled`。
3. 重启 `npm run server -- --config config.json`。
4. 在启动日志中确认出现 `Loaded forum plugin`、`Loaded provider plugin` 或 `Loaded bundle plugin`。

`plugins.enabled` 的顺序就是插件的匹配优先级。各网站与网盘均通过插件提供，核心仅保留通用直链兜底。移除启用 ID 后重启即可禁用对应插件；缺省不启用任何插件。

可以复制 `examples/forum-plugin` 作为新论坛适配器的起点。
