---
name: create-plugin
description: 用户想写一个 Riot 插件、把已有的技能/命令/hooks/MCP 打包分发、或把 Claude Code / Cursor 插件搬到 Riot 时用。目录布局、三种清单格式、dev.riot 扩展字段、本地链接调试流程和市场发布。
---

# 写一个 Riot 插件

插件 = 一个目录。Riot **读现成的三种格式**，不自造：

| 格式 | 清单位置 | 何时选 |
| --- | --- | --- |
| Agent Plugins 开放标准 | `plugin.json` | 新写的插件，只有技能和 MCP，想同时被 Cursor / 别的客户端认 |
| Claude Code | `.claude-plugin/plugin.json` | 要带 `commands/`、`hooks/`；或本来就是 CC 插件 |
| Cursor | `.cursor-plugin/plugin.json` | 本来就是 Cursor 插件 |

三种可以并存：身份取 标准 > CC > Cursor 的第一份，组件位置的覆盖从每一份
收。**推荐**：新插件写标准 `plugin.json`，需要 hooks / commands 时再加一份
`.claude-plugin/plugin.json`（只写 `name` 和那几个字段）。

## 目录布局（固定位置，不用在清单里声明）

```text
my-plugin/
├── plugin.json                  标准清单（见下）
├── skills/<名>/SKILL.md         技能。格式同 extend-riot 技能里说的
├── commands/**/*.md             斜杠命令。子目录是命名空间
├── hooks/hooks.json             hooks。格式同 <配置目录>/hooks.json
├── mcp.json                     MCP 服务器（标准格式，见下）
├── bin/                         进 Bash 的 PATH（有就进，不用声明）
└── scripts/                     自带脚本，hooks / 命令里用 ${PLUGIN_ROOT}/scripts/x 引用
```

`agents/`、`rules/` Riot 暂不支持：装上会在设置页标成「不支持的组件」，
不静默丢，也不报错。

## plugin.json（标准）

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "一句话说它干什么",
  "author": { "name": "你" },
  "extensions": {
    "dev.riot": {
      "env": { "MY_TOOL_HOME": "${PLUGIN_ROOT}/tool" },
      "pathPrepend": ["./tool/bin"],
      "selfCheck": [{ "command": "./tool/bin/mytool", "args": ["--version"] }],
      "platforms": ["darwin-arm64", "win-x64"]
    }
  }
}
```

模型猜不到的限制：

- **`$schema` 必填**，且只能是 `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
  （`1.x` 都认）。缺了整个插件被拒。
- **`name` 只能是小写字母、数字、`-`、`.`**，首尾是字母数字，不能有 `--`
  或 `..`，1–64 字符。它同时是插件 id、技能和命令的前缀、安装目录名。
- 顶层只允许 `$schema` `name` `version` `description` `author` `homepage`
  `repository` `license` `keywords` `extensions`。**别的字段被忽略并报告**，
  想写组件位置只能写在 CC 那份清单里。`author` 是对象，只能有 `name` /
  `email` / `url`。
- `extensions["dev.riot"]` 是 Riot 私有的，四个字段都可选：
  - `env`：注入工具子进程的环境变量。值里可写 `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`；
    `./` 开头的按插件根解析成绝对路径。不许设 `PLUGIN_ROOT` / `PLUGIN_DATA`。
  - `pathPrepend`：进 PATH 的目录，`./` 开头、必须存在。**别把 `python` /
    `node` 放进 PATH** —— 会盖掉用户项目的虚拟环境；要用就写 `$MY_BIN/python3`。
  - `selfCheck`：装完实跑一遍的命令，跑不通整个安装回滚。带原生二进制的
    插件必须写，纯 Markdown 插件不需要。
  - `platforms`：`darwin-arm64` / `darwin-x64` / `win-x64` / `win-arm64` /
    `linux-x64` / `linux-arm64`。写了就只能装到这些平台。纯 Markdown 插件不写。

## mcp.json（标准）

本机自己用、不打包的走 `add-mcp` 技能（设置页只起
stdio；远程用 `mcp-remote` 桥）。这里是打进插件的格式，多了原生 HTTP
和占位符。

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "db": {
      "type": "stdio",
      "command": "./bin/server",
      "args": ["--data", "${PLUGIN_DATA}/db"],
      "env": { "LOG": "info" },
      "cwd": "${PLUGIN_ROOT}"
    },
    "remote": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

- `type` 必填：`stdio` / `streamable-http`（`http` 同义）/ `sse`（旧协议）。HTTP 的字段
  只有 `url` + `headers`；非回环必须 https，不许 userinfo / fragment。
- stdio 的 `command` 是**单个 token**：裸命令名（`npx`、`uvx`，走 PATH）或
  `./` 开头的包内路径。**不能写 `${PLUGIN_ROOT}`**，不能带空格拼参数。
- `args` / `env` 的值 / `cwd` 里可写 `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`。
  `cwd` 缺省是插件根。
- 包内路径解析后必须仍在插件目录内：`../` 逃出去的整条服务器作废。
- 对外的服务器 id 是 `<插件>--<名字>`，工具名是 `mcp__<插件>--<名字>__<工具>`。
- CC 形态的 `.mcp.json`（没有 `$schema`、`command` 里写 `${CLAUDE_PLUGIN_ROOT}`）
  也认。

## hooks

格式同 extend-riot 技能里的 `hooks.json`。命令里写
`${PLUGIN_ROOT}/scripts/check.sh`（CC 的 `${CLAUDE_PLUGIN_ROOT}` 同义）；
脚本运行时环境里有 `PLUGIN_ROOT` `PLUGIN_DATA` `CLAUDE_PLUGIN_ROOT`
`CLAUDE_PLUGIN_DATA`。只有 `PreToolUse` `PostToolUse` `Stop`
`UserPromptSubmit` 四个事件生效，别的事件会被标成不支持。

## 调试流程（照这个顺序，别跳）

1. 设置 → 插件 → **链接本地目录**，指向正在写的目录。不拷贝，改完**下一轮对话**
   直接生效。确认页会列出它读到的全部组件 —— 少了哪个就是那个文件没放对位置
   或 frontmatter 写错了；问题和"不支持的组件"也列在这里。
2. 技能 / 命令的名字看设置页对应板块：它们带 `<插件>:` 前缀，`/` 菜单里敲
   `<插件>:` 就能筛出来。
3. hooks 写完**真触发一次**那个事件（`PostToolUse` 就让 Riot 改一个文件）。
   hook 坏了只记日志、不拦链路，所以不触发一次永远不知道它有没有跑。
4. 带二进制的插件写 `selfCheck`，本地链接时点「详情」看装完自检那一栏。
5. 写好后推到 Git 仓库。别人在 设置 → 插件 → **从 Git 安装** 填仓库地址
   （`owner/repo` 也行）就能装；子目录用「子目录」字段（一个仓库多个插件）。

## 发到市场

市场 = 一个含 `marketplace.json` 的 Git 仓库（形状同 Claude Code / Cursor
的市场清单）：

```json
{
  "name": "acme",
  "owner": { "name": "Acme" },
  "plugins": [
    { "name": "my-plugin", "description": "…", "version": "0.1.0", "source": "./plugins/my-plugin" },
    { "name": "other", "source": { "source": "github", "repo": "acme/other" } }
  ]
}
```

`source` 认：相对路径（市场仓库里的子目录）、`{ "source": "github", "repo": "o/r" }`、
`{ "source": "git", "url": … }`、`{ "source": "git-subdir", "url", "path" }`，以及
Riot 专有的 `{ "source": "archive", "platforms": { "<平台>": { "url", "sha256", "size" } } }`
（几百 MB 二进制走 Releases 时用）。用户在 设置 → 插件 → 市场列表 里加
`owner/repo` 就能看到。放在 `.claude-plugin/marketplace.json` 或
`.cursor-plugin/marketplace.json` 的也能读，所以一份市场三家通用。

官方目录是 [`riot-org/riot-marketplace`](https://github.com/riot-org/riot-marketplace)：
只改那份 `marketplace.json` 加一行，插件代码放你自己的仓库。带大体积二进制
的用 `archive`，`url` 指插件仓库的 Release。

## 把 Claude Code / Cursor 插件搬过来

不用改：直接「从 Git 安装」或链接目录。装完看设置页：`agents/`、`rules/`、
不认识的 hook 事件会列在「不支持的组件」，其余照常。想加 Riot 私有的接线
就在它的清单里加 `extensions["dev.riot"]`（CC / Cursor 的清单不是闭合
schema，多一个字段无害）。
