# 需要人决定时挂起回合，答完再续跑

状态：已实现（主 agent 的全部询问都挂起，含普通权限确认）。

实现时和下面方案的出入：

- 续跑轮开头发一条 `RequestStart { after: ResumedAfterUser }`：续跑先跑工具、不发请求，
  而界面和宿主都靠 turn 0 的 `RequestStart` 置忙。
- `permission.respond` 带上宿主现装的 `TurnConfig`：重启之后内存里没有上一轮的配置，
  答完最后一张卡片时要用它开续跑轮；没带就沿用上一轮。返回 `permission_responded { resumed }`，宿主据此置忙。
- 挂起和交给会话之间有一段空档（同批兄弟还在跑）：询问留在 `PendingAsks` 里但撤掉应答通道，
  这段时间的点击先存着，会话接手时取走；答案已经收齐就直接续跑。
- 已知局限：同批已经跑完的兄弟，结果存在挂起记录里，续跑时才写进对话，所以它们的工具卡片
  在续跑前一直显示"进行中"。

## 现状

- `HostGate::ask`（`crates/riot-kernel/src/gate.rs`）把询问挂进 `PendingAsks`（内存里的 oneshot），
  整轮在 `tokio::select!` 上干等：
  - `AskUserQuestion` 没有超时，一直等；
  - `SwitchMode` 等最多 1 小时；
  - 其余（包括 `RequestEnv` 表单和普通权限确认）等 `ask_timeout`（默认 60 秒），到点按拒绝处理。
- 等待期间会话一直是"忙"（`running` 是 `Some`），侧栏转圈，用户发的话只能排队。
- 等待状态只在内存里。应用重启后询问就没了，那条 tool_use 在下一轮开工时被
  `repair_tool_pairing` 补成 "Result lost"。

## 目标

要人做决定时，**回合停下，而不是干等**：

1. 会话变回空闲，显示"等你处理"，没有计时；
2. 卡片（选项卡、表单、权限确认）一直留着，应用重启后还在；
3. 用户答完，把**真实答案写成那条 tool_use 的 tool_result**，从原处接着跑。
   对模型来说只是这个工具执行得久了一点，不会多出一条"用户消息"。

## 总体做法

```
模型发出一批工具调用
  └ 调度器逐个跑；某个调用的权限闸判定"要问人"
      └ 闸返回 Suspend（不再等 oneshot）
  └ 同批其余能跑的照常跑完；排在它后面的批次不跑，一起挂起
  └ 批次以 Suspended 结束：已完成的结果 + 挂起的调用，打包成一条挂起记录
      ├ 记录写进 transcript，并存进 Session.suspended
      └ 本轮以 Done { AwaitingUser } 收场，running 释放
用户在卡片上作答（PermissionRespond）
  └ 答案记进挂起记录（落盘）；挂起的询问全部答完时，开一个 Resume 回合
Resume 回合
  └ 用答案把挂起的调用跑完（闸不再问，直接用答案）
  └ 已完成的结果 + 新结果按原顺序拼成一条 tool_result 消息
  └ 进入正常的模型循环
```

## 分项设计

### 1. 闸：多一种结果 `Suspend`

- `riot-protocol`：`GateOutcome` 加 `Suspend { request_id, detail: PermissionAsk, input }`。
  `input` 是 hook 改写之后的最终输入，续跑时就按它执行，不能退回原输入（不然等于按 A 授权、去执行 B）。
- `HostGate` 加 `suspendable: bool`：
  - 主 agent 的闸为 `true`，见第 6 节；
  - `ask()` 在 `suspendable` 时：
    1. 先照旧跑 Auto 模式的判危竞速。判危时间短，判定安全就直接放行，不挂起；
    2. 判危没有结论时，发 `PermissionRequest` 事件、返回 `Suspend`，不进 `PendingAsks`，也不计时。
- 续跑时要用答案，把现在 `ask()` 末尾那段"答案 → `GateOutcome`"的逻辑提成函数 `apply_answer(tool, input, answer)`。
  这段负责三件事：`remember`、`inject_choice`、按工具定制拒绝措辞。
  即时等待和续跑共用这一份，措辞不会分叉。

### 2. 调度器：同批照跑，后续批次推迟

`crates/riot-tools/src/scheduler.rs`：

- `run_one` 收到 `Suspend` 时，返回 `Done { suspended: Some(..) }`，不执行这个工具。
- **同一批的兄弟照常跑完。** 同批本来就是并发安全的只读调用，结果模型用得上，没理由丢掉。
- **后面的批次一个都不跑，原样记成"推迟"。** 批次之间是有先后依赖的，比如先读再写；
  中间那个调用没定下来就跑后面的，会打乱模型预期的执行顺序。
- `BatchOutcome` 加 `suspended: Option<Suspension>`，其中包括：
  - 有序的槽位列表，每个槽位是三种之一：
    - `Done(tool_result)`：已经跑完的；
    - `Asked { request_id, tool_use_id, name, input, detail }`：等用户回答的；
    - `Deferred(ToolCall)`：排在后面没跑的；
  - `side_messages`：hook 反馈等，续跑时一起发出去。
- 这时不输出 tool_result 消息。原因是同一条 assistant 消息的全部 tool_result，必须作为下一条消息一次给全，
  不能先给一半、过后再补；Anthropic 和 OpenAI 两边的协议都这样要求。

### 3. 主循环：以 `AwaitingUser` 收场

`crates/riot-core/src/agent_loop.rs` 第 6 步：

- 批次带 `suspended` 时，把记录交给宿主，然后 `Done { reason: TerminalReason::AwaitingUser { asks } }`，不写 tool_result。
- 交给宿主的方式：`AgentEvent` 加 `Suspended(Box<Suspension>)` 事件，紧挨在 `Done` 之前发出。
- `invariants::check_tool_pairing` 对挂起的 tool_use 放行。挂起只出现在收场时，所以只需要放宽收场前的那一处检查。

### 4. 持久化

- `riot-store` 的 `Record` 加两种记录：
  - `Suspend { record: Suspension }`
  - `SuspendAnswer { request_id, response }`

  "答完续跑"不需要单独的记录：续跑那一轮写出的 tool_result 消息本身就证明挂起已经结束。
- `Session` 加 `suspended: Mutex<Option<SuspendState>>`。`SuspendState` 是挂起记录加上已收到的答案。
  - `hydrate` / `restored` 时从 transcript 重建：最后一条 `Suspend` 之后，如果没有出现那些 tool_use_id 的 tool_result，就还原它。
- **`repair_tool_pairing` 要跳过挂起中的 tool_use**，不然下一次组请求就把它补成 "Result lost"。
  在 `run_inner` 调 repair 之前，先处理挂起：Resume 回合把结果补上；其他起点（用户新消息、重新生成）先按第 5 节收掉挂起。
  这样 repair 本身不用改，它的语义仍然是"历史里不该有孤儿"。
- 快照：`PendingAsks::snapshot()` 之外，把挂起中、还没回答的询问也并进 `pending_asks`，
  前端的 `reconcileAsks` 不用改就能重建卡片。

### 5. 用户的几种动作

| 动作 | 处理 |
|---|---|
| 在卡片上作答 | `manager.respond_permission`：先查 `PendingAsks`（子 agent 的即时等待），再查各会话的挂起记录。命中挂起记录时落一条 `SuspendAnswer`，回 `PermissionResolved` 让卡片收起；全部答完就起 Resume 回合（用 `last_turn` 里的模型和能力，和唤醒轮同一套）。 |
| 没答，直接发了一条新消息 | `submit` 发现有挂起：未回答的询问一律按"跳过"收掉，tool_result 写明"用户没有回答，而是发了一条新消息（见下一条）"；推迟的调用补"已跳过，没有执行"；已完成的结果原样保留。拼成一条 tool_result 消息之后，再接上用户这句话，正常开轮。卡片发 `PermissionResolved` 收起。 |
| 按停止 | 会话本来就空闲，停止键只需要清掉挂起：全部补成"用户已中断，本次操作未执行"，不开新轮。 |
| 重新生成、编辑、回滚 | 走 `after_history_cut`，挂起和 `PendingAsks` 一起清掉；那条 assistant 消息被截掉，记录也就没有意义了。 |
| 部分作答 | 答案逐条落盘，卡片逐张收起；剩下的继续挂着，重启后也还在。 |

"跳过"的措辞沿用现有那几句（`RequestEnv` 别在对话里要变量、`SwitchMode` 别再建议切换……），
它们都在 `apply_answer` 里，见第 1 节。

### 6. 子 agent

- 前台 `Task` 子 agent 和后台任务，都跑在父工具的 `call()` 里面。
  它们的循环状态只在内存里，要挂起就得把子 agent 的整个状态也持久化，这次不做。
- 做法：子 agent 拿一个 `suspendable: false` 的闸。在 `run_inner` 里建一份共享同一套规则和模式的副本，
  交给 `SubagentDeps.gate` 和分叉种子。它们继续走现在的"挂 `PendingAsks` 即时等待"，**超时配置照旧保留**。
  按记录里的要求，已有的产品行为不能删。
- 前台子 agent 等待期间，主回合仍然是"忙"。这是这次的已知局限，以后要做就做"子 agent 挂起 → 父工具挂起"的级联。

### 7. 定时任务

- 到点发出的消息走的是同一个 `submit`，挂起照样生效：会话停在"等你处理"。
  挂起时什么都没执行，所以比"超时按拒绝"更安全，也不会白白丢掉一次运行。
- `src-tauri/src/schedule.rs` 以 `Done` 作为一次运行结束的标志。新增的 `AwaitingUser`：
  - 运行记录标成"等待处理"（`waiting: true`，不算失败）；
  - 发一条系统通知，让人知道该去处理；
  - Resume 回合结束时，再按正常流程收尾这次运行。
- 下一次到点时如果会话还挂着，按第 5 节"直接发了一条新消息"处理：先收掉旧挂起，再开新的一轮。

### 8. 超时配置

- `ask_timeout`、`ASK_TIMEOUT_RANGE` 和设置项都保留，只在不能挂起的地方使用，也就是子 agent 的即时等待。
- 设置页说明改成"子 agent 的权限询问等待多久"。

### 9. 前端

- `TerminalReason::AwaitingUser`：结束转圈，会话状态显示"等你处理"，侧栏加标记，发系统通知。
- 卡片的渲染和作答都不变，仍然是 `PermissionRequest`、`permission.respond`、`PermissionResolved` 这一套。
- 输入框上方提示：直接发消息会跳过未回答的卡片。
- i18n：五种语言都要补新的文案键。

## 要改的文件

- `crates/riot-protocol`：`GateOutcome::Suspend`、`TerminalReason::AwaitingUser`、`AgentEvent::Suspended`、`Suspension` 类型；重新生成 `schemas/` 和 `src/bridge/generated.ts`
- `crates/riot-tools/src/scheduler.rs`：挂起和推迟
- `crates/riot-core/src/agent_loop.rs`、`invariants.rs`：以挂起收场
- `crates/riot-kernel/src/gate.rs`：`suspendable`、`apply_answer`
- `crates/riot-kernel/src/session.rs`：`suspended` 状态、`TurnStart::Resume`、`submit` / 停止 / `after_history_cut` 的处理、快照
- `crates/riot-kernel/src/manager.rs`：`respond_permission` 命中挂起记录
- `crates/riot-store`：`Suspend` / `SuspendAnswer` 记录和重建
- `src-tauri/src/schedule.rs`：等待处理状态和通知
- `src/`：会话状态、侧栏、输入框提示、i18n

## 测试

- 闸：可挂起时返回 Suspend、不计时；Auto 判危安全时直接放行，不挂起；子 agent 的闸仍然即时等待，到点拒绝。
- 调度器：同批兄弟跑完、后续批次推迟、槽位顺序和调用顺序一致。
- 主循环：挂起收场时不写 tool_result，配对检查不误报。
- 会话（用测试 provider 做端到端）：
  - 作答 → 续跑，模型收到的 tool_result 是真实答案，并且和兄弟的结果在同一条消息里；
  - 部分作答 → 重启 → 补答 → 续跑；
  - 直接发新消息 → 挂起被收掉，消息序列合法；
  - 按停止 → 补成中断结果，不开新轮；
  - 重新生成 → 挂起被清掉；
  - 推迟的写操作在续跑时才执行，并且照常过闸，还可以再次挂起；
  - `RequestEnv` 跳过时措辞不变，值仍然不进 transcript。
- 存储：记录读写往返；带挂起的 transcript 重建后，`repair_tool_pairing` 不会去补挂起中的 tool_use。
- 定时任务：`AwaitingUser` 不算失败；续跑结束才收尾这次运行。
