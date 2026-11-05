# 从这里分叉为新会话

状态：P0、P1、P2 都已实现，正文已按实现改写。界面部分还没在运行中的应用里逐项手动走过
（见文末「测试」）。

## 和最初方案的出入

P0：

- 分叉来源不进 `TranscriptMeta`，单独一行 `Record::ForkOrigin` 紧跟在 Meta 后面。Meta 在几十处
  构造，血缘只有一处写、两处读（水合、索引重建）；旧加载器跳过这行，只丢"从哪来"。
- 物化 transcript 时压缩边界的 token 数写 0：这两个数只用于诊断，`load_parts` 也不带它们。
- 新会话标题沿用原会话的（宿主不造文案），侧栏靠分叉记号区分。
- `/fork` 不调模型，没配服务方也能用（输入框原先在没有模型时一律不提交）。
- 首轮提醒只在新会话还停在分叉点时注入（水合时历史最后一条等于来源记下的那条），
  回忆开着时带上新旧会话 id。

P1：

- `session.fork` 不带 `target_root` + `relocate`，改带宿主建好的 `worktree: Option<ForkWorktree>`。
  新根由它从原根算出来（原根可以是仓库的子目录）；路径改写只认它的 `repo_root` 前缀，
  仓库之外的路径不搬、也不写回。
- 没有单独的 `ForkInfo`：血缘只有 `ForkOrigin` 一份，transcript 里那一行和宿主索引里都是它。
  worktree 信息和侧栏分组用的 `project_root` 挂在 `ForkOrigin.worktree` 里。
- 未提交状态逐个拷文件，不走 `git diff --binary | git apply`：二进制、换行符和 filter、补丁打不上
  这些情况都不用操心，拷过去的和原工作区逐字节相同。
- 确认框所有入口都弹，共用模式也弹（P0 时共用模式点了直接分叉）。
- 「在终端打开」开的是应用自己的终端面板（新开的终端就在 worktree 里），不是系统终端。

P2：

- 不做「旧版本 N」（被重新生成、回退、改了重发换掉的那一版能分叉出来看；做过一版，删了），
  对齐 Claude Desktop：它的消息上只有「从这里分叉」和「回退到这里」，没有旧版本列表。想留着
  原来那条线，就在换掉之前先分叉；刚换掉的还能 Redo 接回。截掉的消息其实还在 transcript 里
  （`Rewind` 只改加载），只是界面不再给入口。为它要多一个请求、内核里一份跟着截断压弹的登记、
  store 里一套"重放到截断之前一刻"的加载，记号还得分提问、回答两种挂法，不划算。
- 不做编辑框里的「在新会话发送」（做过一版，删了）。想改个问法又留着原来那条线，在上一条回答上
  「分叉到新会话」再输入就是同一件事。为它多一个键会挤掉编辑栏的说明，还要一套"新会话就绪后
  自动发出那句话、发不出去放回输入框"的链路，不划算。
- 原会话上的「已分叉 N 次」挂在分叉点（`ForkOrigin.message`，那一轮的结尾）那一轮带操作栏的
  回答上。分叉会话的分隔线点回去也定位到这条。

## 现状

Riot 的历史是一条线，所有"换条路走"的操作都是截断：

- 重新生成（`turn.regenerate`）、编辑后发送（`turn.resend`）：截到那条提问，文件回到当时，再跑一轮。
  截掉的部分界面上找不回来，Redo 栈也被清掉。
- 回退到这里（`history.restore`）+ Redo：截掉的部分进 Redo 栈，但新提问、重新生成、重发、压缩
  都会让它作废 —— 用户在新的那条线上问过一句，就回不去了。
- transcript 其实没删数据（`Rewind` 只改加载，不删行），每条提问也都有文件切片
  （`sessions/<id>.checkpoints/<msgId>.json`）。缺的是一个"保留原线、另开一条"的入口。

想"换个思路试试，但原来那条先留着"，现在只能新开会话手工重述背景。

## 目标

1. 在任意一轮结束处**分叉成一个新会话**：新会话带着到这一轮为止的完整对话（含压缩归档），
   和原会话从此各走各的，互不影响。
2. 两条线都要改代码时，能给新会话一个**独立的 git worktree**，文件落在分叉点那一刻的样子。
3. 原会话一个字节都不动：不截断、不回退文件、不清 Redo。

### 非目标

- **版本树 / `< 1/2 >` 切换**：要先解决"切分支时磁盘怎么跟着切"和"压缩只对一条线成立"，
  代价大得多。分叉做顺了再考虑。
- **把分叉合并回原会话**：对话没有合并语义；代码层面的合并交给 git。
- **跨项目分叉**：新会话的项目根要么和原来一样，要么是原仓库的 worktree。
- **复制网络授权（`scope`）**：授权是对一个会话的信任，不跟着复制，新会话里重新问。

## 用户看到的

### 入口

| 入口 | 分叉点 | 阶段 |
|---|---|---|
| 助手回复操作栏（和"重新生成"同一批按钮）上的「分叉到新会话」 | 这条回复所在的一轮结束处 | P0 |
| `/fork` 内置命令 | 最近一轮完整结束处 | P0 |

"一轮结束处" = 这条回复之后、下一条用户提问之前的最后一条消息。分叉点必须落在轮边界上，
不然新会话会继承一个没配对的 tool_use。

### 确认框

```
分叉到新会话
新会话带上到这里为止的 12 轮对话，原会话不动。

○ 共用当前工作区
  文件不动，两个会话改的是同一份文件。
  ⚠ 分叉点之后原会话又改过 3 个文件，新会话一开始看到的就是改过的样子。

● 新的 worktree（riot/fork-登录重构）
  在单独的目录里检出一份，会话动过的文件回到分叉点那一刻。改动落在自己的分支上，不碰当前工作区。
  被 git 忽略的文件（node_modules、.env 等）不会带过去；分叉点之后的提交也不会退回去。

                                         [取消]  [分叉]
```

- 所有入口都先弹这个框。摘要说带几轮。
- 数字来自 `session.fork_preview`（带几轮、是不是最新一轮、之后改过几个文件、有没有分叉点切片），
  宿主再补上 worktree 会建的分支名。
- 默认选哪个：是 git 仓库且分叉点不是最新一轮 → worktree；否则共用。
- 不是 git 仓库（或者还没有任何提交）：worktree 那项置灰，旁边写"不是 git 仓库"。
- ⚠ 那行只在共用那项下、且分叉点之后还有轮次改过文件时出现，数字取自切片对比（见下文"预览"）。
- 没有分叉点那一刻的切片（老会话）：worktree 那项多一行 ⚠"worktree 会是当前工作区的样子"。
- 分叉做成了但有要留意的（有文件没能退回分叉点、有未跟踪文件太大或太多没带过去）：
  切到新会话之后弹一条提示列出来。

### 分叉之后

- 立刻切到新会话。标题沿用原会话的，自动标题照常可以改。
- 新会话对话流顶部（分叉点位置）一条分隔线：「从『原标题』分叉」，点击跳回原会话，
  定位到分叉点那条消息并闪一下。原会话已删时写「原会话已删除」，不可点。
- 侧栏：新会话和原会话放在**同一个项目分组**里（即使用了 worktree，项目根变了），
  前面画分叉图标；worktree 会话再带一个分支名小标签（去掉 `riot/` 前缀，悬停显示 worktree 路径）。
- worktree 会话的头部，标题后面也有分支标签，点开是「在 Finder 中显示」「在终端打开」
  「复制 worktree 路径」。会话的右键菜单里也有这三项。
- worktree 目录被手动删掉：打开会话时提示"worktree 不见了"，可以删会话，或者从原会话重新分叉。
  不把人引去"移除项目"。
- 原会话：分叉点那一轮的回答标「已分叉 N 次」，点开列出这些分叉（标题，时刻 · 分支），
  点一个切过去。记号常显，和操作栏排在同一行的最左边；操作栏照旧悬停才出来。

## 数据怎么分

分叉 = 一份**物化**的新 transcript + 按需复制的旁路文件。新会话不引用原会话的任何文件，
原会话删了它照样能用。

### 1. transcript：物化，不引用

```
原会话 jsonl（Meta, Message…, CompactBoundary, Message…, Rewind, Edit, Delete, …）
   └ load_parts → archived + live
        └ 在 live 里找到分叉点 at
新会话 jsonl：
   Meta { id: 新, root: 新根, created_at_ms }
   ForkOrigin { session, message: 分叉点, worktree? }
   Message × archived
   CompactBoundary { before/after_tokens: 0, keep_from: None }   ← 仅当 archived 非空
   Message × live[..=at]
```

- 用 `load_parts` 的结果来写，而不是逐行复制原文件：Rewind / Edit / Delete / Withdraw
  都已经应用好了，新文件里没有一条需要重放的编辑记录，加载结果和原会话分叉点那一刻
  逐字相同。`keep_from: None` 的边界会把前面写的消息整段收进归档，正是想要的形状。
- 多次压缩会被合成一个边界。`load_parts` 本来就把所有归档并成一份，界面上只画一条分割线，
  看起来没区别。
- **消息 id 原样保留**。切片按用户消息 id 命名，id 不变才能直接复制；
  前缀完全相同，服务方的提示词缓存还能命中。
- 分叉来源放在 transcript 里而不只是 index.json：索引损坏重建时血缘关系不会丢。
- 写入走临时文件 + rename，不经过 `SessionLog`：新会话此刻还没有句柄，不存在两个写者。
  目标已存在就报错，分叉绝不盖掉一个会话。transcript 最后写 —— 它在盘上就等于会话存在，
  前面哪步没做成都还能收拾干净。

分叉点只能在 **live** 里。落在压缩归档里的消息（界面上分割线以上）不提供分叉入口，
和 `history.restore` / `turn.resend` 一致。压缩时保留的最后一轮在 live 里，所以最近一轮总能分叉。

### 2. 文件切片（`<id>.checkpoints/`）

| 文件 | 处理 |
|---|---|
| `<msgId>.json` | 只复制留下的那些提问的切片。worktree 模式下 `SnapFile.path` 做前缀改写（仓库根 → worktree），仓库之外的不动 |
| `blobs/` | 只复制被复制的切片引用到的 blob。先试硬链接（blob 只增不改、按哈希命名），跨文件系统再拷贝 |
| `head.json` | 不复制。分叉完成后对新根重新拍一份 —— 它是脏检查的对照，必须是新会话自己看到的磁盘 |
| `redo.json` | 不复制。Redo 是原会话的操作历史 |

这样新会话里"回退到这里"对分叉点之前的每条提问都能用。

### 3. 改动基线（`<id>.baselines.json`）

会话改动条显示的是"相对会话开始时"的净改动，基线是每个文件被会话第一次碰到之前的内容。

- 只带**分叉点之前已经登记过**的路径：分叉点后面那条提问的切片里列着的路径就是当时的基线集合；
  分叉点就是最新一轮、或者没有那张切片（老会话）时全带 —— 多显示几个文件，好过漏掉。
  分叉点之后原会话才碰到的文件不属于新会话。
- 基线内容（v0）不变：新会话是原会话的延续，改动条应该包括继承下来的那些改动。
- worktree 模式同样做路径前缀改写。

### 4. 子 agent（`subagents/<id>/`）

- 只复制留下的历史里那些 Task 调用开出来的子 agent（连同它们再派的）的 transcript，
  `tasks.json` 按同一集合过滤。
- 分叉时还在后台跑的照样复制，新会话水合时标成已中断。它往后的进展和完成通知只回到原会话。

### 5. 工件目录（`artifacts/<id>/`）

存的是截图原图、过大的工具结果，**消息里用绝对路径引用**它们（模型被告知去 Read 那个路径）。

- 目录整体硬链接复制到 `artifacts/<新 id>/`。
- 物化 transcript 时，对序列化后的每一行把 `artifacts/<原 id>/` 前缀替换成 `artifacts/<新 id>/`。
  只动工件路径，不碰别的文本。不改写的话，原会话一删，新会话历史里的这些路径就全断了。
- 被改写的消息会让那一段提示词缓存失效，影响很小。

### 6. 宿主索引（index.json）

复制：`provider`、`model`、`mode`、`sampling`、`thinking`、`multitask`、`python_venv`、`system_prompt`、
标题（自定义的和自动的）。新增 `forked_from` 和 `created_at_ms`（原会话列出分叉时显示）。
`forked_from` 就是 transcript 里那一行：

```rust
pub struct ForkOrigin {
    pub session: SessionId,
    /// 分叉点：新会话历史的最后一条。
    pub message: String,
    pub worktree: Option<ForkWorktree>,
}

pub struct ForkWorktree {
    pub path: PathBuf,         // worktree 目录（检出的仓库根）
    pub repo_root: PathBuf,    // 原工作区的仓库根，写法跟着原会话的根走
    pub branch: String,        // riot/fork-…
    pub base: String,          // 建 worktree 时的提交，删会话时判断分支上有没有新提交
    pub project_root: PathBuf, // 原项目根，侧栏按它分组；分叉的分叉沿用来源记下的
}
```

`SessionInfo.forkedFrom` 带上它，侧栏按 `forkedFrom.worktree.projectRoot ?? root` 分组
（前端 `projectRootOf`）。

### 7. 不带过去的

终端、浏览器标签页、排队插话、挂起的询问、网络授权、Redo 栈。
终端和浏览器的变化，新会话第一轮的环境快照会如实告诉模型（指纹和历史里最后一份不同，必然重注）。

## 工作区

### 共用模式

不碰任何文件。要处理的只有一点：分叉点不是最新一轮时，磁盘上有新会话的模型看不到的改动。

- 新会话的 `FileStateCache` 是空的，改文件之前必须先读，不会拿旧印象去盖新内容。这是现有机制，不用新做。
- 首轮额外注入一条一次性提醒（system reminder 附件）：这是从别的会话分叉出来的，两个会话共用工作区，
  分叉点之后文件可能变了，改之前重读。
- 确认框里的 ⚠ 预览：拿分叉点后面那条提问的切片和当前磁盘对比，数出变了几个文件。
  和 `history.restore_preview` 同一套（`checkpoint::preview`）。

### worktree 模式

宿主做（git 命令和目录都在宿主那边，`src-tauri/src/worktree.rs`）：

1. 位置：`<应用配置目录>/worktrees/<项目名>-<项目根路径哈希前 8 位>/<新会话 id>`。
   不放在用户仓库旁边或里面：仓库里的嵌套 worktree 会在 `git status` 里显示成未跟踪目录，
   放在旁边会往用户的文件夹里塞东西。代价是不好找，所以会话头部的分支标签给了
   「在 Finder 中显示」「在终端打开」「复制路径」。
2. 仓库顶层从会话根往上数（`rev-parse --show-prefix`），不用 `--show-toplevel`：它给的是 realpath，
   和会话根的写法对不上的话，切片和基线里的路径前缀就改写不到。worktree 的父目录先规范化 ——
   工具记基线用的是规范路径，新会话的根、改写后的路径都得和它一个写法。
   没有任何提交（没有 HEAD 可开分支）按不是 git 仓库算。
3. `git worktree add -b riot/fork-<标题 slug> <路径> HEAD`。slug 取标题里的字母数字（最多 24 个），
   别的换成 `-`；没有标题或换完不合法用 `riot/fork-session`；撞名加 `-2`、`-3`……
4. 把原工作区**当前**的未提交状态带过去：`git status --porcelain -z --untracked-files=all` 列出来的
   逐个拷（符号链接照样建链接），原工作区里删掉的、改名前的旧路径，worktree 里跟着删。
   未跟踪文件单个超过 `MAX_SNAPSHOT_BYTES`、第 2000 个以后的、嵌套仓库不带，结果里列出前 20 个。
5. 内核把文件落到分叉点（见下文"内核接口"）：分叉点是最新一轮就不用动；否则拿分叉点后面那条提问的
   切片，路径改写后对 worktree 执行和 `history.restore` 相同的写回。切片缺失 → 不中断，
   结果里标出 `stale`："文件没能回到分叉点，worktree 是当前工作区的副本"。
6. 任何一步失败：删掉 worktree 和分支，新会话不登记，报错。

已知局限（第一条和第三条写在确认框 worktree 那项的说明里）：

- **被忽略的文件不会带过去**（`node_modules`、`target`、`.env`）。worktree 里要重新装依赖，
  `.env` 要自己拷。以后可以加一个"随 worktree 复制的忽略文件"设置。
- 和回退一样，切片只认识会话自己改过的文件。终端命令、生成器改的文件不会回到分叉点。
- 原会话在分叉点之后提交过（`HEAD` 动了）：worktree 从**现在**的 HEAD 出发，
  已提交的内容不会退回去。这和回退的行为一致。

历史里的路径不改写：工具调用里的 `原根/src/foo.rs` 就是当时发生过的事。为了防止模型照着旧路径
去改原工作区：

- 系统提示词里的工作目录本来就跟着会话根走，第一轮的 git 快照也会显示新分支名；
- 首轮一次性提醒写明：工作目录换成了 worktree（带分支名），历史里原仓库根下的路径对应这里的
  同一批文件，不要去改原仓库；
- 围栏兜底：新会话的根是 worktree，写 `原根` 下的文件属于越界，要走权限确认。

### 删除 worktree 会话

- 删之前界面先问宿主 `worktree_status`：目录还在不在、有几处没提交的改动（含未跟踪文件）、
  分支上有几个没合进别的分支的提交（`base..branch`，有别的分支包含它就算 0）。改动查不出来按有算。
- 目录已经不在：照普通会话删。
- 干净：确认框里多一句"会和分支一起删掉"，确认后连 worktree 带分支删。
- 否则确认框多一组单选：「保留 worktree 和分支」（默认）/「一起删掉」（没提交的改动和分支都丢掉）。
- 宿主 `delete_session(discardWorktree)`：`true` 删、`false` 留、不给（老调用方、远程）干净才删。
  删 worktree 要在内核侧停掉轮子之后：工具可能还在往里写。
- 只删应用 worktrees 目录下面的路径：路径来自索引，索引坏了也不能删到用户的项目。

### 没有会话的 worktree

- 界面启动后（以及删了 worktree 会话、移除项目之后）调 `orphan_worktrees`：先对目录已经不在的
  worktree 所在仓库跑 `git worktree prune`，再列出 worktrees 目录下没有对应会话的目录。
  只列，不自动删 —— 里面可能有没提交的东西。
- 有的话侧栏底部出一行「N 个没有会话的 worktree」，点开列出分支和路径，能在 Finder 里看，
  删要点两次。删的时候分支只在上面没有别处没有的提交时一起删。

## 内核接口

```rust
/// 把这个会话到分叉点为止的对话复制成新会话 `target`。原会话不动；
/// 它跑轮中也能分叉已经结束的轮。
#[serde(rename = "session.fork")]
SessionFork {
    session_id: SessionId,
    /// 内核消息 id。分叉点是它所在那一轮的结尾。
    message_id: String,
    /// 宿主分配好的新 id。
    target: SessionId,
    /// 宿主建好的 worktree。新会话的根换到它里面，文件落到分叉点。
    worktree: Option<ForkWorktree>,
}
// → SessionForked { message_id: 实际分叉点, files: Option<ForkFiles> }

/// 确认框要的数字。只读。
#[serde(rename = "session.fork_preview")]
SessionForkPreview { session_id, message_id }
// → ForkPreviewed(ForkPreview { message_id, turns, latest, changed_after, has_slice })
```

`session.fork` 内核里的步骤：

1. 原会话在内存里就先 `flush` 它的日志。**不要求空闲**：
   分叉点必须在已经完整结束的轮里，而跑轮期间不会有 Rewind，文件里已经写下的前缀是稳定的。
   正在跑的那一轮、挂起等用户的那一轮不能作为分叉点。
2. 算分叉点（那条消息所在一轮的结尾），校验轮边界。
3. 复制切片；有 worktree 时把文件落到分叉点；写基线，对新根拍 `head.json`；复制子 agent、工件；
   最后写 transcript。
4. 返回。新会话**不水合**，宿主切过去时照常走 `session.resume`。

宿主命令：

| 命令 | 做什么 |
|---|---|
| `fork_session(sessionId, messageId, worktree?)` | 分配 id →（worktree）建 worktree（目录名就是新 id）、带未提交状态 → `session.fork` → 登记索引 → `ForkOut { session, files, carried }`。内核不在就报错，不自己拼文件 —— 物化逻辑只有内核那一份 |
| `fork_preview(sessionId, messageId)` | `session.fork_preview` + worktree 会建的分支名（不是 git 仓库为 null） |
| `worktree_status(sessionId)` | 删之前查 worktree 干不干净；不是 worktree 会话为 null |
| `orphan_worktrees()` / `discard_orphan_worktree(path)` | 列 / 删没有会话的 worktree |
| `delete_session(sessionId, discardWorktree?)` | 见"删除 worktree 会话" |

## 改了哪些文件

| 位置 | 改动 |
|---|---|
| `crates/riot-store/src/lib.rs` | `Record::ForkOrigin`；`Transcripts::write_fork`（原子写一份物化 transcript，带工件路径改写） |
| `crates/riot-protocol/src/fork.rs`（新）、`rpc.rs` | `ForkWorktree`、`ForkPreview`、`ForkFiles`；两个请求和应答。`pnpm gen` 重新生成 `schemas/protocol.json` 和 `src/bridge/generated.ts` |
| `crates/riot-kernel/src/checkpoint.rs` | `copy_slices`（按 id 复制切片 + 引用到的 blob，硬链接优先，可选路径改写）；`FileSnapshot::relocated` |
| `crates/riot-kernel/src/tasks.rs` | `copy_for_fork`：按调用 id 复制子 agent transcript 和 `tasks.json` |
| `crates/riot-kernel/src/session.rs`、`manager.rs`、`lib.rs`、`slash.rs` | 分叉点、预览、物化、落文件；首轮一次性提醒；`/fork` |
| `src-tauri/src/worktree.rs`（新） | 建（带未提交状态）、查状态、删、列孤儿 |
| `src-tauri/src/state.rs`、`persist.rs`、`lib.rs`、`remote/dispatch.rs`、`build.rs`、`capabilities/` | 上面那些宿主命令；`forked_from` 进索引和 `SessionInfo`；删除时的 worktree 收尾 |
| `src/bridge/index.ts`、`src/lib/sessionList.ts` | 命令封装、`projectRootOf`；会话列表比对带上分叉来源 |
| `src/App.tsx` | 确认框调度、分叉后切换和提示、删除确认里的 worktree 选择、孤儿清单、worktree 菜单、每个会话的分叉列表 |
| `src/components/ForkDialog.tsx`、`OrphanWorktreesDialog.tsx`（新） | 分叉确认框；没有会话的 worktree 清单 |
| `src/components/Transcript.tsx`、`Chat.tsx`、`hooks/session/history.ts` | 操作栏按钮、分叉点分隔线、「已分叉 N 次」 |
| `src/components/composer/ComposerDock.tsx` | `/fork` |
| `src/components/Sidebar.tsx`、`chrome.tsx`、`ConfirmDialog.tsx` | 按原项目分组、分叉图标、分支标签、孤儿入口；头部分支标签；确认框带单选 |
| `src/i18n/messages/*/` | 文案 |

## 分期

- **P0**（已实现）：内核 `session.fork` + 共用模式 + 助手回复上的入口 + `/fork` + 分隔线和侧栏标记。
  单这一步就解决了"保留原线、另开一条聊"。
- **P1**（已实现）：worktree 模式（建、带未提交状态、落到分叉点、路径改写、删除收尾、孤儿清理）、
  确认框、侧栏按原项目分组和分支标签、会话头部的 worktree 入口。
- **P2**（已实现）：原会话上的「已分叉 N 次」。「旧版本 N」和编辑框「在新会话发送」做过又删了
  （见开头「和最初方案的出入」）。

## 测试

自动化测试已覆盖：

- store：物化写出的加载结果和传进去的一样；没有归档不写边界；分叉之后照常追加；不覆盖已有会话；
  工件路径改写只命中给定文本。
- 内核：切片和基线只带分叉点之前的；正在跑的那一轮拒绝、之前结束的可以；压缩前的、不认识的消息拒绝；
  首轮提醒只说一次；工件路径换成新会话的；
  worktree 里文件落回分叉点、切片和基线搬到新根、最新一轮不动文件；预览数出分叉点之后改过的文件；
  子 agent 只复制留下的调用开出的。
- 宿主：分支名（撞名加后缀、不合法退回）；建 worktree 带上未提交状态、删掉不留痕迹；
  提交过没合并的不干净、合进别的分支就干净；不在 worktrees 目录下的不删；重建索引认得出分叉的会话。
  端到端（真内核进程 + 真 git）：分叉进 worktree、分叉没做成不留 worktree 和分支、
  删会话默认留着有改动的 worktree 并列成孤儿、选了丢弃就连分支一起删、原工作区始终不动。
- 界面：「已分叉 N 次」挂在哪条回答上。

还没做（界面，手动）：

- 分叉后侧栏两个会话在同一分组；分隔线点回原会话能定位到那条消息。
- 确认框的文案和默认选项；worktree 会话头部分支标签的三个入口。
- 删除 worktree 会话：干净的直接删；有改动时默认保留，之后出现在侧栏底部的孤儿清单里。
- 删除原会话后，分叉会话的历史、回退、工件链接、子 agent 视图都还在。
- worktree 会话里让模型改一个历史里出现过的原根路径：改到 worktree 里那份，或者触发越界确认。
