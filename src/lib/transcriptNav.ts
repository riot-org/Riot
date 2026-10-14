/**
 * 输入框是空的时候按 ↑，输入框往对话流（`.transcript`）派这个事件：从最后
 * 一条消息开始逐条往上看（见 Transcript 的键盘导航，Esc 回到输入框）。
 *
 * 单放一个文件：Transcript 引着 Composer，Composer 再从 Transcript 取这个
 * 名字就成了循环引用。
 */
export const ENTER_TRANSCRIPT_EVENT = "riot:enter-transcript";
