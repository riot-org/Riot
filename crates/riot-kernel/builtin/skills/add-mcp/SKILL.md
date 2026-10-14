---
name: add-mcp
description: 用户想加、改、排查 MCP 服务器，或从 Cursor / Claude Desktop / VS Code 搬 MCP 配置过来时用。用户级只认 stdio（远程走 mcp-remote 桥）、config.json 的形状、ReloadConfig 验证和常见连不上的原因。
---

# MCP 服务器

MCP 不是 `.riot/` 下的文件，也没有项目级。配置在**设置 → MCP**，落在
`<配置目录>/config.json` 的 `mcpServers` 数组。应用只在启动和设置页保存
时读这个文件：你直接改了它，**必须调 `ReloadConfig` 工具**才会生效，否则
要等重启，而且用户下次在设置页保存时会被旧配置整份覆盖掉。连接是应用级
的（所有会话共用同一批进程），工具每轮快照，连上之后的下一轮才进清单。
`ReloadConfig` 连上了新工具时，结果里会让你收尾：照做，用一句话结束本轮，
Riot 会自动用新清单续一轮，不用请用户再发「继续」。

设置页 JSON 视图认 Claude Desktop / Cursor / Cline / VS Code 的通用形状，
保存是**整体替换**当前列表。根形状认三种：`{"mcpServers":{…}}`、
`{"servers":{…}}`（VS Code）、不带包装的裸映射。只贴内层
`{"command":"npx"}` 会报「每个服务器要有名字」。

## 参数（用户级只认这些）

| 字段 | 要不要 | 含义 |
| --- | --- | --- |
| （对象的键） | 必填 | 变成服务器 id。字母数字、`-`、`_` 以外的字符导入时换成 `-` |
| `command` | 必填 | **单个 token**：`npx` / `uvx` / 可执行文件路径。别把参数写进来 |
| `args` | 可选 | 字符串数组，每个元素一个参数 |
| `env` | 可选 | 对象。密钥和服务器要读的变量写这里，进 `config.json`（不是 `auth.json`）。设置 → 环境变量里的值**不会**传给 MCP 服务器 |
| `disabled` | 可选 | `true` = 不启动。表单里对应「启用」开关（`enabled`） |

表单比 JSON 多两个 Riot 自己的字段：`name`（显示名，空 = 显示 id；标准
格式没有，导出丢、导入按 id 捡回）、`enabled`（和 `disabled` 反着）。
表单里 `args` 一行一个、`env` 一行一个 `KEY=VALUE`。

不认、写了会怎样：

- **`url` / `serverUrl`，或 `type` / `transport` 为 `http` / `sse` /
  `streamable-http`** → 整段拒掉，报「暂不支持远程」。Cursor 那种
  `{"url":"https://…","headers":{…}}` 不能原样贴，见下面「远程」。
- `type: "stdio"` 可以写，等于没写。
- `cwd`、`headers`（顶层）、`autoApprove`、`timeout`、`envFile` →
  **忽略不报错**。用户级没有工作目录字段，进程 cwd 继承宿主。
- 空 `command` 能保存但不会启动（设置页「刚点了添加」的中间态）。

## stdio（本机进程）

Riot 用户级**只起 stdio 子进程**。三种常见写法：

```json
{
  "mcpServers": {
    "npm-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-package"]
    },
    "local-python": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/my-mcp",
               "my-mcp", "--transport", "stdio"],
      "env": { "MY_MCP_API_KEY": "<key>" }
    },
    "offline": {
      "command": "npx",
      "args": ["-y", "another-mcp"],
      "disabled": true
    }
  }
}
```

- npm 包：`command` 是 `npx`，`args` 从 `-y` 起拆开。`-y` 跳过 npm 询问，
  第一次跑要能上网。
- 本地 Python：`--directory` 是 uv 的参数，不是 Riot 的 `cwd`。
- `command` 里不许有空格拼参数：`"npx -y some-mcp-package"` 会当成一个叫
  这个名字的可执行文件，起不来。
- 裸命令名（`npx`、`uv`）一般能找到：Riot 启动时吸入登录 shell 的 PATH，
  并补上 `~/.local/bin`、Homebrew、nvm、volta、cargo 的目录。状态报
  `os error 2`（找不到命令）时再改成绝对路径（`which uv` 的结果）。
- **子进程不继承完整环境**，只放行白名单（`PATH`、`HOME`、`USER`、`SHELL`、
  `LANG` / `LC_*`、`TZ`、`TMPDIR`、`HTTP(S)_PROXY` / `NO_PROXY`；Windows 另有
  一套系统变量）。用户 shell 里 export 的 `GITHUB_TOKEN` 之类**读不到**，
  服务器要的变量必须写进 `env`。「终端里能跑、Riot 里报缺 key」就是这个。

## 远程（HTTP / SSE）

用户级**没有** `url` / `headers` 字段。远程有两条路，别走错：

**1. 设置页：用 `mcp-remote` 桥成 stdio**（Cursor 里最常见的那种）。
这是 stdio，能直接粘：

```json
{
  "mcpServers": {
    "local-bridge": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8080/mcp",
               "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    },
    "cloud": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.example.com/path",
               "--header", "X-api-key:${API_KEY}"],
      "env": { "API_KEY": "<key>" }
    }
  }
}
```

- `--header` 和 `Name:value` 必须是 `args` 里**两个元素**，冒号两边别加
  空格。多个头就再写一对 `--header` / `Name:value`。
- **token 放 `env`，args 里写 `${变量}`**，由 `mcp-remote` 自己替换（Riot
  不展开 args）。直接把 token 写进 args 也能跑，但它会出现在进程列表里，
  值里带空格（`Bearer xxx`）时还容易被拆坏。要彻底不进参数，用
  `--header-file <路径>`，文件里每行一个 `Name: value`。
- 用户原配置里 token 已经直接写在 args 的，能用就原样保留，顺带提一句
  可以改成 `env` 的写法。
- 本机回环（`localhost` / `127.0.0.1`）和公网一样走桥，不要改写成
  `{"url":"…"}`。内网非本机的 `http://` 地址要加 `--allow-http`。
- 走代理要加 `--enable-proxy`：Riot 会放行 `HTTPS_PROXY` 这些变量，但
  `mcp-remote` 不加这个参数就不读。
- 要 OAuth 的服务器不用填头：第一次连接 `mcp-remote` 会打开浏览器授权，
  令牌缓存在 `~/.mcp-auth`（授权反复失败时删掉它重来）。授权回调默认等
  30 秒，慢了加 `--auth-timeout <秒>`。

**2. 原生 HTTP**：`{"type":"streamable-http","url":"…","headers":{…}}`
设置页不收。要这条路，打进插件，见 `create-plugin`。

替用户从 Cursor / Claude Desktop 搬家时：有 `command` 的原样留；只有
`url` 的改写成上面的 `mcp-remote` 桥，**不要**告诉用户「Riot 不支持远程」。

## 替用户加的时候

两条路，能自己改就走第一条。

**1. 直接 Edit `<配置目录>/config.json`，然后调 `ReloadConfig`。** 这个
文件里还有模型、密钥环境变量名、权限这些全部设置，所以：

- 用 Edit **只改 `mcpServers` 那一段**，别用 Write 整个重写。
- 那里是**对象数组**，不是上面的映射：
  `{"id": "github", "command": "npx", "args": [...], "env": {...}, "enabled": true}`。
  `id` 必须已经合规（字母数字、`-`、`_`，且不重复）——直接写文件不会替你
  消毒，不合规整份配置都不采纳。`name` 可省，`enabled` 省了算 `true`。
- 改完调 **`ReloadConfig`**（无参数）。它会重读文件、同步设置页、连接
  MCP，并等握手出结果，返回每个服务器的状态：已连接几个工具、失败原因、
  或还在连接。照着结果告诉用户，失败就按原因改了再调。
- 文件写坏（JSON 不合法）或校验不过（id 不合规、重复……），`ReloadConfig`
  会失败并说明原因，应用**不采纳**、照旧用原来的配置。但坏文件留在盘上：
  用户下次重启时它会被挪成 `config.json.bak`、用默认值启动，全部设置都
  没了。所以失败了必须当场修好，再调一次直到成功。
- `ReloadConfig` 不是只读操作（会启动 MCP 进程），默认模式下会弹确认；
  规划模式里用不了。

**2. 给用户一份 JSON 让用户粘。** 用户不想让你动配置文件、或者是从别处搬
一大批过来时用：

1. 先 Read `config.json`，把现有的 `mcpServers` 数组转成上面的映射：
   `id` 做键，`enabled: false` 写成 `"disabled": true`，`name` 不用带。
2. 把新条目合进去，给用户**一整份** `{"mcpServers": {…}}`，请用户在设置 →
   MCP 的 JSON 视图里全选替换、保存。JSON 视图是整体替换，只给新的那
   一条会把旧的冲掉。列表本来是空的才可以只给新的。

表单的「添加服务器」也能加一条而不碰别的，但 id 固定是 `server-N`、表单
里改不了，工具名会变成 `mcp__server-1__…`。

- 不要写 `<项目>/.riot/mcp.json` 或 `<配置目录>/mcp.json` —— 用户级不读
  这两个位置。插件的 `mcp.json` 转 `create-plugin`。

其余限制：

- **id 只允许字母数字、`-`、`_`**。JSON 导入时键里别的字符换成 `-`，原名
  进显示名；两个键消毒后撞名会拒整段（`my.server` 和 `my-server` 不能
  共存）。id 进工具名和权限规则，**改了等于换一批工具**，用户点过的「总是允许」全部失配。
- 工具名是 `mcp__<id>__<远端工具名>`。权限按**全名**匹配，所以服务器起一个
  叫 `Write` 的工具顶不掉内置 Write。
- 远端自称 `readOnlyHint` **换不来放行**：每个工具第一次调用都会问。
  「总是允许」默认只是本会话。规划模式下没自称只读的直接拒。
- 优先级：用户自己配的同 id **压过**插件带的。插件的 id 形状是
  `<插件>--<名字>`，别故意撞。
- 关掉 = 进程停、工具下一轮消失，配置还在。要停插件带的服务器，去插件页
  停用那个插件，MCP 页改不了它。

验证：你自己改的看 `ReloadConfig` 的返回；用户在设置页粘的，调一次
`ReloadConfig`（配置没变也会报各服务器状态）或看下一轮工具清单（或
ToolSearch）里有没有 `mcp__<id>__*`。连失败多半是：命令找不到
（`os error 2`，改绝对路径）、包第一次要下超时（返回「还在连接」就过一会儿
再调）、服务器要的变量没写进 `env`、或远程的 token / 代理参数不对。修好后
再调 `ReloadConfig`（或用户在设置页再保存一次），失败的服务器会重连，不用
重启。
