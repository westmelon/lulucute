# 插件仓库规范 v1

本规范用于 lulucute 自动发现并安装 Git 仓库中的网站、媒体和网盘插件。

## 仓库结构

```text
repository.json
plugins/
  <id>/
    plugin.json
    index.mjs
    ...插件内部文件
```

仓库根目录必须有 `repository.json`。每个列出的插件必须是 `plugins/<id>/` 中的完整独立包，目录 ID 与 `plugin.json.id` 一致。插件无需全部安装，顺序按仓库索引显示。

```json
{
  "schemaVersion": 1,
  "name": "lulucute 插件仓库",
  "plugins": [
    { "id": "my-forum", "description": "网站来源解析" },
    { "id": "my-cloud", "description": "分享链接与文件下载" }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 必填整数，当前为 `1`；仓库索引版本与插件 API 版本独立 |
| `name` | 必填非空字符串，页面展示仓库名称 |
| `plugins` | 必填数组，1–100 项 |
| `plugins[].id` | 必填且唯一；小写字母、数字、连字符，首字符为字母或数字 |
| `plugins[].description` | 可选字符串，插件用途说明 |

其他字段预留扩展，当前忽略。机器可读校验规则见 [repository.schema.json](repository.schema.json)。插件名称、类型、域名、API 版本、入口、登录和界面动作以包内 `plugin.json` 为准，见 [插件 API](plugin-api.md)，不在仓库索引重复定义。

## 发现与安装

1. 用户填写本地路径、HTTPS 或 SSH Git 地址；本地相对路径以服务启动目录为基准，建议填绝对路径。访问令牌、密码不能嵌入仓库 URL。私有仓库使用本机已有 Git 凭据，页面不收集凭据。
2. 版本留空读取 Git `HEAD`（默认分支），也可填标签、分支或 commit。只有 Git 已提交内容可见，工作区未提交文件不会进入列表。
3. 服务获取指定版本，校验仓库索引、插件 ID、清单和目录边界。文件和目录禁止符号链接；所有列出的插件需结构有效，单个非法项会拒绝整个列表。未列出的目录不会展示。
4. API 版本不受支持的插件仍展示，标记不兼容并禁止安装。读取列表不导入插件、不执行工厂、不安装 npm 依赖。
5. 列表返回实际 commit 和短期列表标识；安装提交插件 ID 和列表标识，由服务使用该列表的来源及 commit，不重新解析可变分支。重启或列表失效后需要重新读取。
6. 安装时继续检查 JavaScript 语法并记录来源和 commit。API 相同和语法有效不能保证代码可信，插件运行权限与主项目相同。

网页接口沿用本地服务的令牌与来源校验：

- `POST /api/plugins/repository`：`{ "repository": "...", "ref": "可选版本" }`，返回 `name`、`repository`、`ref`、`commit`、`catalogId` 和带 `compatible`、`installed`、`enabled` 状态的插件清单。
- `POST /api/plugins/install`：`{ "catalogId": "...", "id": "...", "enable": true }`，只允许安装列表内兼容且未安装的插件；返回安装结果和 `restartRequired`。不接受任意安装目录，使用配置的首个插件目录。

下载、登录或其他插件操作期间不能读取或安装；安装期间队列暂缓启动，结束后恢复原暂停状态。服务关闭会等待插件操作结束，空闲自动退出不会打断插件操作。安装结果显示后仍需重启本地服务，未实现热加载。

可选择安装后启用；配置只追加 ID，保留原优先级与其他设置。安装成功但配置保存失败时保留已安装文件，并显示明确提示。已安装插件在页面不能覆盖更新，更新及回滚继续使用命令行。

## 兼容与发布

原 API v1 的 `forum`、`provider` 和 `bundle` 及其工厂契约保持不变。旧仓库没有 `repository.json` 时不能自动列出插件，但现有按 ID 的命令行安装仍可用。

插件版本由 Git ref/commit 统一确定，不维护另一套包版本号。发布时创建新标签，不移动旧标签。仓库只包含代码、文档与测试，不包含 Cookie、账号令牌、本地配置或归档文件。采用此规范的第三方仓库无需修改核心站点名单即可被发现。
