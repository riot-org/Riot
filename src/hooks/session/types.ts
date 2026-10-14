import type { BackgroundTaskStatus, BackgroundTaskView, HistorySnapshot, ImageInput, Nudge, PermissionAsk, PermissionMode } from "../../bridge";

/**
 * 界面上的一条内容。
 *
 * 这不是消息的镜像 —— 一条 assistant 消息里可能同时有思考、正文和三个
 * 工具调用，它们在界面上是分开的四块。事件流到 UI 模型的这层翻译放在
 * 这里，组件就只管画。
 */
export type Item =
  /**
   * `images` 是 data URL，只给界面回显自己发过什么用。
   * `files` 是消息里 `@` 引用过的文件路径（内容进了模型，界面只列路径）。
   * `at` 是消息产生的时刻（Unix 毫秒，见 MessageMeta.created_at_ms）；
   * undefined = 本字段之前的老记录，界面那里不显示时间。
   * `nudge` = 这条是「构建」/「并行构建」按钮发的（MessageMeta.nudge），
   * 画成构建卡而不是气泡；`planName` 是它构建的那份计划的标题。
   */
  | {
      kind: "user";
      id: string;
      text: string;
      images?: string[];
      files?: string[];
      at?: number;
      nudge?: Nudge;
      planName?: string;
    }
  /** `stopped` = 用户按停止截断的半截回答（内核定稿的，见 finalize_partial）。 */
  | { kind: "assistant"; id: string; text: string; stopped?: boolean; at?: number }
  /** `durationMs`：这段思考花了多久（内核量的，见 riot-core 的 think_timer）。旧会话没有。 */
  | { kind: "thinking"; id: string; text: string; durationMs?: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      status: "running" | "ok" | "error";
      result?: string;
      /**
       * 结果里的图片（截图、读图），data URL。这是消息里自带的**压缩图**
       * （给模型的那份），先显示它，原图到了再换。
       */
      resultImage?: string;
      /**
       * 原图的磁盘路径（截图落盘的文件、或被读的图片本身）。
       * 界面优先按它加载原图 —— 压缩图看布局够，看文字不行。
       */
      resultImagePath?: string;
      output: string[];
    }
  /**
   * 出错。`text` 是给人看的一句话；`detail` 是不翻译的技术细节（服务方原话、
   * HTTP 状态），界面上折起来 —— 排查时才用得上，平时不该占一大块。
   */
  | { kind: "error"; id: string; text: string; detail?: string }
  /** 中性告知（不是出错）：到达轮数上限之类，只是提示"该歇口气了"。 */
  | { kind: "notice"; id: string; text: string }
  /**
   * 后台子 agent 的完成通知（内核合成的 user 消息，见 MessageMeta.task_notice）。
   * `text` 是它的汇报正文。模型收到的是同一段话；这里画成卡片而不是用户气泡。
   */
  | {
      kind: "task_notice";
      id: string;
      agentId: string;
      title: string;
      status: BackgroundTaskStatus;
      text: string;
      at?: number;
    }
  /** 压缩边界：上面是压缩前的记录，下面是压缩后的对话。 */
  | { kind: "compact"; id: string };

/**
 * 排队面板里的一条插话（还没被内核注入的用户消息）。
 *
 * `id` 是宿主队列条目 id —— 注入后回流的消息用同一个 id，面板条目
 * 由此转成对话气泡。sendTurn 还没返回的短暂窗口里是本地临时 id。
 */
export interface QueuedItem {
  id: string;
  text: string;
  images: ImageInput[];
  /** `@` 引用的文件路径（输入框里的那些块）。 */
  refs: string[];
}

/**
 * 一条被撤回的提问：用户在模型开口之前按了停止，内核把它从历史里删了。
 *
 * 界面要把它放回输入框 —— 那句话从没被回答过，用户按停止的意思是
 * "重说一遍"，而不是"扔掉我刚打的字"。
 */
export interface WithdrawnPrompt {
  /** 内核那条消息的 id。对账/排查用，界面按位置认气泡。 */
  id: string;
  text: string;
  images: ImageInput[];
  refs: string[];
  /** 撤完这个会话一条消息都不剩了。侧栏那句自动标题也该跟着撤。 */
  sessionEmpty: boolean;
}

export interface SessionState {
  items: Item[];
  /** 正在流式输出的正文。 */
  streaming: string;
  /** 正在流式输出的思考过程。 */
  thinking: string;
  /**
   * 正在流式写出的计划正文（CreatePlan 的 `plan` 参数）。
   * `null` = 没在写计划。空字符串 = 已经认出是计划、正文还没到。
   * 计划整段塞在工具参数里，等 tool_use 完整到达才显示的话，
   * 用户会对着侧栏空面板干等几十秒，以为对话卡住了。侧栏的计划面板
   * 边流边渲染它；工具落定后改读磁盘上的文件。
   */
  streamingPlan: string | null;
  busy: boolean;
  /**
   * 宿主正在压缩上下文。
   *
   * 压缩要真调一次模型做摘要，几十秒 —— 而那段时间界面上原本只有那三个点，
   * 和"模型正在回答"分不出来，用户看到的是应答莫名变慢。
   *
   * 宿主不发"压缩结束"，只发压缩**成功**的 `compacted`。失败的那一半
   * （摘要请求本身出错）没有事件，所以这个标志必须由后续动作清掉，
   * 见 handle 里 `request_start` 和 `done` 的处理。
   */
  compacting: boolean;
  /**
   * 待回答的权限请求，按到达顺序排队，弹窗每次只显示队首那个。
   *
   * `[约束]` 必须是队列而不是单个槽位。调度器会把并发安全的工具放在
   * 同一批里并行跑，每个各自征求授权 —— WebSearch + WebFetch 就是这样
   * 一对。用单槽位的话后到的会覆盖先到的，被覆盖那个永远等不到回应，
   * 一直挂到宿主侧 10 分钟超时才按拒绝收场。用户看到的是两个工具卡片
   * 转圈、没有任何弹窗。
   */
  asks: { requestId: string; detail: PermissionAsk }[];
  /**
   * 本会话的 token 用量。花的是用户的钱，应该让他看得见。
   *
   * `input`/`output` 是**累计**（每轮相加，只增不减）；`context` 是
   * **当前占用**的快照 —— 最近一次请求真实发出去的量，压缩之后会掉下来。
   * 两个口径混用会让人以为"聊了半天上下文才用了 5%"（累计 ÷ 窗口），
   * 或者"压缩完怎么还是这么多"（快照当累计看）。
   */
  tokens: { input: number; output: number; context: number };
  /**
   * 宿主主动切换的权限模式（批准计划时用户选的执行档）。null = 没发生过。
   * Composer 靠它同步显示 —— 不同步的话界面还写着「规划模式」，
   * 宿主已经按「自动接受编辑」放行了。
   */
  hostMode: PermissionMode | null;
  /** 排队面板：模型跑动中发的、还没注入对话的插话。 */
  queued: QueuedItem[];
  /**
   * 刚被撤回、等着放回输入框的那条提问。输入框消费掉之后置回 null
   * （见 `clearWithdrawn`）。
   */
  withdrawn: WithdrawnPrompt | null;
  /**
   * 后台子 agent（跑着的和刚结束的），按启动顺序。`background_task` 事件
   * 每次推一份全量视图，这里按 id 覆盖；切回会话时用快照整批替换。
   */
  tasks: BackgroundTaskView[];
  /** 有文件切片的用户提问 id。 */
  checkpointIds: string[];
  /** 最近一次 Restore 还能 Redo。 */
  redoAvailable: boolean;
  /** 回退/重做改了磁盘：外层拿它刷新改动栏。 */
  filesRev: number;
}

/** 能做上下文修改的条目：用户气泡和助手文本气泡。 */
export type TextItem = Extract<Item, { kind: "user" } | { kind: "assistant" }>;

export type UserItem = Extract<Item, { kind: "user" }>;

/**
 * 宿主的历史快照。
 *
 * `[约束]` 类型只有 `bridge` 里那一份（对着 Rust 的 `HistoryOut`）。
 * 这里以前另写了一份把四个字段标成可选的副本，于是满地 `?? false` /
 * `?? []` 兜着永远不会发生的情况，而真出现字段增删时两份都不会红。
 */
export type HistorySnap = HistorySnapshot;

export const EMPTY_STATE: SessionState = {
  items: [],
  streaming: "",
  thinking: "",
  streamingPlan: null,
  busy: false,
  compacting: false,
  asks: [],
  tokens: { input: 0, output: 0, context: 0 },
  hostMode: null,
  queued: [],
  withdrawn: null,
  tasks: [],
  checkpointIds: [],
  redoAvailable: false,
  filesRev: 0,
};

