# lulucute

一个最小可运行的论坛资源自动化原型：使用持久化 Chrome 登录论坛，按插件规则回复并提取资源，再把文件归档到指定目录。

网站来源与网盘下载通过独立插件提供，核心保留普通 HTTP 直链的流式下载和归档能力。具体插件用法见 [私有插件文档](https://github.com/westmelon/lulucute-plugins/blob/main/docs/usage.md)。

## 目录规则

```text
下载根目录/
  论坛/
    板块/
      帖子标题/
        文件
        .resource-downloader.json
```

路径片段会清理非法字符，现有同名文件不会被覆盖。

## 安装

要求 Node.js 20+、Google Chrome 和 Git（用于下载安装插件）。

```bash
git clone https://github.com/westmelon/lulucute.git
cd lulucute
npm install
npm run build:extension
cp config.example.json config.json
```

编辑 `config.json`，把 `downloadRoot` 改为你选择的真实绝对路径。示例值 `/absolute/path/to/ResourceHub` 不能直接使用；程序会在启动浏览器和发送回复之前创建并验证该目录是否可写。浏览器登录资料保存在项目的 `.data/browser-profile`，任务状态保存在 `.data/task-queue.json`。程序不读取或保存明文密码。

示例配置不预先启用插件，可以先启动本地服务，再通过页面安装所需站点和网盘插件，见下方「插件安装与更新」。启用但未安装的插件会阻止服务启动。

## 首次登录

```bash
npm start -- \
  --config config.json \
  --login https://forum.example.com/login
```

将示例地址替换为所用插件支持的实际登录地址，在打开的 Chrome 中完成登录，然后回到终端按 `Ctrl+C`。以后运行会复用该登录态。

## 可视化界面

首次安装 Native Messaging 启动器：

```bash
npm run install:native-host
```

这个命令会在当前用户的 Chrome 配置中注册启动器。随后加载扩展：

1. 打开 `chrome://extensions/` 并启用“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 选择项目中的 `extension` 目录。
4. 点击工具栏里的 lulucute，打开侧边栏。
5. 如果之前未配置令牌，先手动启动一次服务，在连接设置中填入终端显示的访问令牌并保存：

```bash
npm run server -- --config config.json
```

以后侧边栏访问本地 API 失败时，会通过 Native Messaging 自动启动服务并重试请求。服务只监听 `127.0.0.1`；没有等待或运行中的任务达到 `server.idleShutdownMs` 后会自动退出，历史任务记录不受影响。默认空闲时间为 2 分钟，设为 `0` 可以保持服务常驻：

```json
{
  "server": {
    "idleShutdownMs": 120000
  }
}
```

项目目录或 Node.js 安装路径变化后，需要重新执行 `npm run install:native-host`。这次更新为扩展加入了固定 ID；在 `chrome://extensions/` 中确认扩展 ID 为安装命令输出的值，如果不同，需要移除旧扩展并重新加载 `extension` 目录。首次重新安装后如果连接令牌为空，需要重新填入一次。以后更新扩展只需重新加载。普通网页形式的本地仪表盘不能在服务完全退出后自行唤醒进程，这项能力只属于 Chrome 扩展。

侧边栏根据已加载插件识别当前页面，可以加入队列、查看实时阶段、暂停后续任务、重试失败任务和打开归档目录。也可以直接使用浏览器打开本地仪表盘；普通网页模式下资源 URL 可以手动编辑。

连接设置中的“后台静默运行”控制 `browser.headless`。只能在没有任务运行时切换；保存后会关闭空闲的自动化浏览器上下文，下一个任务按新模式启动，并将选择写回 `config.json`。外部下载工具的窗口由对应工具管理。

令牌保存在配置目录的 `.data/server-token`，文件权限为当前用户可读写；扩展把令牌保存在 Chrome 本地存储。API 只接受本机请求和 Chrome 扩展来源。常驻服务会持有任务队列锁，服务运行期间不要同时执行 CLI 下载命令。

## 插件安装与更新

页面顶部点击「插件安装」（拼图图标），无需填写仓库即可查看已安装插件的名称和配置启用状态，可手动刷新，安装成功后自动更新。已安装插件旁可点击「禁用」或「启用」，只保存配置，保留插件文件。安装或更改启用配置后点击「重新加载服务」，服务会读取插件配置并刷新站点识别与下载处理器，页面连接和队列暂停状态保持不变；失败时保留原运行插件。下载、登录或其他插件操作期间不能更改配置或重新加载。已安装列表和仓库列表均按「网站插件」「网盘插件」分组：`forum`、`bundle` 为网站插件，`provider` 为网盘插件。填入插件 Git 仓库地址或本地绝对路径后自动列出可安装插件。版本留空读取默认分支，也可指定标签或 commit；选择列表中的插件安装，可勾选安装后启用，重新加载服务后生效。列表显示已安装状态与 API 兼容性，已安装插件仍通过命令行更新或回滚。

官方插件仓库为 [lulucute-plugins](https://github.com/westmelon/lulucute-plugins)，安装地址使用 `https://github.com/westmelon/lulucute-plugins.git` 或 `git@github.com:westmelon/lulucute-plugins.git`，也支持本地仓库绝对路径。自动发现需要所选版本包含根目录 `repository.json`。安装固定到展示列表的 commit，不会因为默认分支更新而安装不同内容。读取或安装期间保持连接，下载与登录期间暂不能管理插件。通用结构与接口见 [插件仓库规范 v1](docs/plugin-repository.md)。

站点插件的源码、测试和具体使用说明由独立的私有 [lulucute-plugins](https://github.com/westmelon/lulucute-plugins) 仓库维护。访问需要 GitHub 仓库权限和本机 Git 凭据或 SSH 密钥；安装器不会弹出登录提示，安装前应确认 `git ls-remote <仓库地址>` 可正常执行，不要把令牌写入仓库地址。主项目的 `plugins/` 仅存放已安装的副本，不纳入主项目版本控制。

支持本地路径、HTTPS 和 SSH 仓库地址。仓库约定每个插件位于 `plugins/<id>/`；Git 获取指定版本的仓库内容，再安装选中的插件包：

```bash
npm run plugins -- install <id> --repository git@github.com:westmelon/lulucute-plugins.git --ref main --config config.json
```

首次安装必须提供仓库与 `--ref`，可以指定标签、分支或 commit；建议使用发布标签或 commit 固定版本。安装器校验 ID、API 版本、入口范围和 JavaScript 语法，拒绝符号链接，不执行插件入口、仓库脚本或依赖安装。没有新增 npm 依赖。安装记录保存仓库、ref 和实际 commit。

更新和回滚前停止服务；安装器不能替已经运行的进程刷新模块。更新时默认复用已安装版本的仓库地址；省略 `--ref` 会再次获取原 ref，固定标签不发生变化，分支可以推进。校验失败保留现有版本；替换文件失败时自动恢复旧目录。

```bash
npm run plugins -- update <id> --ref main --config config.json
npm run plugins -- rollback <id> --config config.json
```

备份在安装目录同级的 `.plugins-backups/<id>/`，不会被加载器扫描。回滚恢复最近一次备份并备份当前版本。备份不会自动删除，需要时手动清理；异常终止遗留的安装锁需确认没有安装进程后手动移除。未使用安装命令的旧插件可通过 `update <id> --repository ... --ref ...` 接入，并保留原文件作为备份。

安装目标是配置文件旁 `plugins.directories` 的第一个目录；未指定配置时安装到当前目录的 `plugins/`。安装命令不修改启用列表或其他配置。将插件目录加入 `plugins.directories`，再把 manifest 中的 `id` 加入 `plugins.enabled`：

```json
{
  "plugins": {
    "directories": ["./plugins"],
    "enabled": [],
    "options": {}
  }
}
```

服务启动时会递归查找 `plugin.json`、校验 API 版本和适配器接口，再加载启用的插件。`plugins.enabled` 的顺序决定匹配优先级；普通 HTTP 直链下载是最后的通用兜底。删除某个启用 ID 即可关闭该站点/网盘支持，已安装但未启用插件声明的域名不会被误当作直链下载。缺省启用列表为空，使用时需把已安装插件的 ID 加入 `plugins.enabled`。

网站插件可以同时提供来源解析和媒体下载，同一包的能力使用一个 ID 启用。插件还提供 URL 规范化、合集刷新策略、登录入口和界面动作，来源解析与下载适配器通过通用资源接口协作。示例位于 `examples/forum-plugin`，完整接口见 [插件 API](docs/plugin-api.md)。安装或修改启用列表后可通过页面重新加载插件配置；命令行更新、回滚插件代码或修改其他服务设置仍需重启服务。扩展从服务状态读取已加载站点及能力。Chrome 扩展使用 `tabs` 权限读取当前地址，不再把各站点域名写入扩展权限列表。

插件选项由对应插件校验，具体字段与兼容配置见插件仓库的使用说明。队列格式、完成指纹、登录资料与已归档文件由主项目维护。

插件入口在本地服务进程中运行，拥有与本程序相同的 Node.js 和浏览器自动化权限。只启用经过检查的本地代码，不要直接执行来源不明的插件。

## 预检

预检只检查帖子状态，不回复、不解析网盘、不下载：

```bash
npm start -- \
  --config config.json \
  --url https://forum.example.com/thread/123 \
  --dry-run
```

## 自动处理

```bash
npm start -- \
  --config config.json \
  --url https://forum.example.com/thread/123
```

单条任务也会写入持久化队列。已经完成的普通帖子再次提交时会跳过；是否刷新已完成来源由插件的增量同步策略决定。

成功下载的稳定资源标识会以 SHA-256 指纹记录在 `.data/task-queue.json`，不保存文件路径、提取码或带签名的资源 URL。移动已下载文件不会导致重复下载；删除任务仍保留下载索引。

## 批量队列

可以重复传入 `--url`，任务会严格串行处理：

```bash
npm start -- \
  --config config.json \
  --url https://forum.example.com/thread/123 \
  --url https://forum.example.com/thread/456
```

也可以准备一个文本文件，每行一个帖子 URL；空行和以 `#` 开头的注释会被忽略：

```text
# urls.txt
https://forum.example.com/thread/123
https://forum.example.com/thread/456
```

```bash
npm start -- --config config.json --urls-file urls.txt
```

队列记录 `pending`、`running`、`completed`、`failed` 和 `action-required` 状态，以及 `inspecting`、`replying`、`downloading` 等阶段。异常退出后，普通下载任务会在下次运行时自动恢复。若程序在公开回复提交期间中断，任务会停在 `reply-status-unknown`，避免自动重复回复。

失败或需要人工处理的任务在确认问题已解决后显式重试：

```bash
npm start -- --config config.json --retry-failed
```

同一时间只能运行一个下载器进程；第二个进程会因队列锁而停止。

当 `workflow.autoReply` 为 `true` 时，运行命令会代表当前账号公开回复。验证码、登录失效和网盘风控会中断自动流程，程序不会绕过这些检查。

## 测试

```bash
npm test
```
