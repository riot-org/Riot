---
name: extend-riot
description: 用户想加技能、斜杠命令、hook、项目约定（AGENTS.md），或要给命令配 API key、密码这类机密时用。各扩展点的目录、格式限制和优先级规则。MCP 服务器转 add-mcp，打成可分发的插件转 create-plugin。
---

# 扩展 Riot

技能、命令、hook 是普通文件，改完**下一轮对话生效**，不用重启。AGENTS.md
只在会话第一条消息注入，改完要**新开会话**才看得到。MCP 服务器在
`config.json` 里，规矩不同，用 `add-mcp` 技能。

全局的放配置目录（`<配置目录>`），项目级的放 `<项目>/.riot/`。同名时
**项目级赢**（和 git 的 local > global 同一直觉）。`<配置目录>` 是：

- 设了 `XDG_CONFIG_HOME`（任何平台，含登录 shell 里 export 的）→
  `$XDG_CONFIG_HOME/riot`
- 否则 macOS `~/Library/Application Support/riot`、Linux `~/.config/riot`、
  Windows `%APPDATA%\riot`

拿不准就 `echo $XDG_CONFIG_HOME` 看一眼，或让用户到设置 → 关于里看。

放哪一层：只给用户自己用、跨项目通用的放全局；跟这个仓库走、要提交给
团队的放项目级。用户没说就问，别替用户选。

写 `<项目>/.riot/` 下的文件会弹「修改 agent 配置」的确认，「全部放行」也
跳不过，每次写都弹。动手前跟用户说一声这是正常的，免得被当成异常点了拒绝。

插件带的技能和命令排在全局之后、内置之前，且自动带 `<插件>:` 前缀 —— 要
把这些东西打包给别人装、或从 Claude Code / Cursor 的插件里搬过来，用
`create-plugin` 技能。

## 技能 SKILL.md

```text
<配置目录>/skills/<名字>/SKILL.md     全局
<项目>/.riot/skills/<名字>/SKILL.md   项目级
```

```markdown
---
name: verify
description: 改完代码要验证时用。按分层防线依次跑。
disable-model-invocation: false
---
正文。可用 $ARGUMENTS 和 ${SKILL_DIR}。
```

限制（这些都是模型猜不到的）：

- **frontmatter 必须有**（和命令不同）：不以 `---` 开头、或正文为空，都算
  「有问题的技能」报给设置页。`name` 可省，省了取目录名。
- **`description` 必填**，缺了不静默跳过，同样报给设置页。
  它是模型决定要不要加载的唯一依据。
- **`description` 硬顶 250 字符**。超了会被截断，模型就是在残句上做判断。
  写不下就说清「什么时候用」，别写做法——做法在正文里。
- frontmatter 认 `key: value` 单行标量，和 `>-` / `|` **块标量**（description
  写成多行用这个，Cursor / Claude Code 的技能文件就是这种写法，直接拷进来
  能用）。列表、嵌套映射不认，未知的键忽略。
- 正文 64 KB 封顶。数据文件放技能目录里让模型按需 Read，不要整个贴进来。
- `allowed-tools` / `model` / `context: inline|fork` **还不支持**，写了会被
  忽略而不是报错。
- **`disable-model-invocation: true`** = 只给用户 `/` 调，不进 Skill 工具的
  清单。这时它会**就地展开**成提示词（因为模型的清单里没有它，不展开就
  谁都跑不了）；普通技能反过来，只把名字发给模型，由它用 Skill 工具按需
  加载正文——几 KB 正文不该塞进用户可见的消息。
- 只认 `true`，写 `yes` / `1` 按「没关」算。

## 斜杠命令

```text
<配置目录>/commands/**/*.md
<项目>/.riot/commands/**/*.md
```

- frontmatter **可省略**（没有 `---` 开头就整个文件当正文，description 取
  正文第一行）。可写 `description`、`argument-hint`；写 `name` 没用，命令名
  只看文件路径。
- **解析失败不报错**：frontmatter 没闭合、正文为空的文件直接跳过，设置页
  也不显示，表现就是「命令不存在」。
- 子目录变命名空间：`commands/git/pr.md` → `/git:pr`。
- `$ARGUMENTS` = 整段参数原文；`$1..$9` = 按空白拆的第 N 个（`"带 空格"`
  算一个，引号剥掉）。模板里一个占位符都没有而用户给了参数时，末尾追加
  `ARGUMENTS: <args>`——否则参数被静默扔掉，看起来像命令不认参数。
- 模板里可以写 `@路径`：展开后走普通发送那条路，`@` 引用会照常带上文件内容。
- **`` !`cmd` `` 嵌入执行不支持**，那是把「展开提示词」变成「执行任意命令」
  的口子。
- 优先级：**内置 > 项目命令 > 全局命令 > 技能**。自定义顶不掉内置
  （`/compact` 的行为要可预期），同名时命令压过技能。

技能和命令共用一条发现管道，所以**已经有一个技能了就别再写一个同名命令**
——那只是给自己制造一个优先级问题。

## Hooks

```text
<配置目录>/hooks.json
<项目>/.riot/hooks.json
```

两层**叠加**（都会跑），不是覆盖。

```json
{
  "PreToolUse":  [{ "matcher": "Bash|Write",
                    "hooks": [{ "type": "command", "command": "./check.sh", "timeout": 30 }] }],
  "PostToolUse": [{ "matcher": "Write", "hooks": [{ "type": "command", "command": "cargo fmt --check" }] }],
  "Stop":        [{ "hooks": [{ "type": "command", "command": "cargo test -q" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "./scan-secrets.sh" }] }]
}
```

只有这四个检查点。`SessionStart`、`Notification`、`PreCompact` 这些别的
事件名**静默忽略**，不报错。外面包一层 `{"hooks": {…}}`（Claude Code 的
`settings.json` 写法）也认，可以直接拷。协议：

- 用 `sh -c`（Windows `cmd /C`）跑，**工作目录是项目根，全局 hook 也是**。
  所以全局 hook 里的 `./check.sh` 是相对当前项目找的，全局脚本要写绝对路径。
- 进程继承完整环境（和 MCP 的白名单不同）。
- stdin 收一行事件 JSON（`hook_event_name`、`session_id`、`cwd`、
  `tool_name`、`tool_input`、`tool_response`、`prompt`、`stop_hook_active`…）。
- **`exit 2` = 拦下**，stderr 是给模型看的理由。各事件「拦下」的意思不同：

  | 事件 | `exit 2` | `exit 0` 的 stdout |
  | --- | --- | --- |
  | `PreToolUse` | 这次工具调用被拒 | 丢弃 |
  | `PostToolUse` | 工具已经跑完，stderr 作为「检查未通过」反馈给模型 | 补充上下文 |
  | `Stop` | 不让停，模型接着干（有熔断，不会死循环） | 丢弃 |
  | `UserPromptSubmit` | 这条消息不发，用户看到报错 | 补充上下文 |

- stdout 是 JSON 时还能给 `decision: "block"` + `reason`（等同 exit 2），
  `PreToolUse` 另认 `hookSpecificOutput.permissionDecision`（allow/deny/ask）
  和 `updatedInput`。
- **其它退出码只记日志**——检查脚本自己坏了不该拦住整条链路。
- 同事件并行跑、同命令去重，默认超时 60 秒，`timeout` 限 1–600。
- 只支持 `type: "command"`，别的类型跳过不报错。
- matcher：空或 `*` = 全匹配；只含字母数字、`_`、`|` 的（`Write`、
  `Bash|Write`）是精确匹配；其它按不锚定的正则（`mcp__github__.*`）。
  正则写错就永远不匹配，也不报错。

替用户写 hook 脚本时的坑（都因为「坏了只记日志」而**静默失效**，
用户只会觉得「hook 没生效」）：

- 脚本要有 shebang 且 `chmod +x`；
- 脚本里用到的命令（`jq`、`python3`……）先 `command -v` 确认装了，
  别假设用户机器和你想的一样；
- matcher 先松后紧：先不带 matcher 跑通，确认脚本本身对，再收紧。
  一上来就写复杂正则，分不清是没匹配上还是脚本坏了；
- 写完**真触发一次**那个事件验证，别写完就完。

一条安全边界：hook 的 `allow` 只能免掉例行询问，**压不过**安全检查（写 SSH
密钥、凭证文件、命令注入这些）和用户自己写的 ask 规则。否则 clone 一个带
`hooks.json` 的仓库就等于关掉整套防线。

## 机密：设置 → 环境变量

API key、密码、令牌这类值**不要进对话、不要写进文件**。用户在设置 →
环境变量里配（存在本机 `auth.json`，和模型 key 同一个文件），你在命令和
脚本里用 `$NAME` 引用，值由 Riot 注入。

- 缺一个变量时调 **`RequestEnv`** 工具：用户在对话里看到一张表单，填的值
  直接存进设置，你只拿到「配好了」和变量名。已经配好的不会再弹。**不要**
  让用户把 key 贴进对话，也不要让用户自己 `export`。
- 名字是 shell 能 `$NAME` 引用的形状：字母或 `_` 开头，只含字母数字和 `_`。
- 输出里冒出变量的值（`echo $KEY`、`cat .env`），交给你之前会被换成
  `[已遮蔽：$NAME]`。看到这个说明值在、注入生效了，不是出错。
- **只注入 agent 跑的命令**（Bash 等工具和子 agent）。**hook 和 MCP 服务器
  拿不到**：hook 继承的是 Riot 进程自己的环境；MCP 服务器要的 key 写在它
  自己的 `env` 里（见 `add-mcp`），两边不共享。

## 项目约定 AGENTS.md

```text
<配置目录>/AGENTS.md          全局
<项目>/AGENTS.md              项目级（回退 CLAUDE.md，只取其一）
```

注入会话首条消息（不是 system prompt），压缩后会重注。所以**改完要新开
会话**才生效，当前会话里看不到。没有设置板块，也不报错。

- 支持 `@路径` 引用，递归展开、深度 5、有循环检测，围栏和行内代码里的 `@`
  会跳过。
- `@` 后面**必须像路径**：含 `/`，或以 `.` / `~` 开头。`@style.md` 不展开，
  要写 `@./style.md`。引用的文件不存在静默跳过，末尾的标点会被剥掉。
- 64 KB 硬截、40 KB 警告。
- **不向上遍历父目录**（刻意与 Claude Code 不同）。全局只读 `AGENTS.md`，
  不回退 CLAUDE.md。

写什么：**代码里 grep 不到的东西**。「这个函数做什么」不要写，读代码就有；
「为什么不用另一条路」「这个约束破了会怎样」才值得写。

## 加完之后

你看不到设置页，自己能验证的是：

| 加了什么 | 怎么确认 |
| --- | --- |
| 技能 | 下一轮 Skill 工具的清单里有它；没有就让用户看设置 → 技能，失败原因列在那里 |
| 命令 | 让用户敲 `/` 看补全里有没有。没有多半是文件解析失败（不会报错） |
| hook | 真触发一次那个事件；没反应让用户看设置 → Hooks 的解析错误 |
| AGENTS.md | 让用户新开一个会话 |

别写完就说「好了」，确认到上面这一步再告诉用户。
