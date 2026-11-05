//! 流式请求的静默看门狗。
//!
//! # 为什么 HTTP timeout 不够
//!
//! `[约束]` 流式请求最脆弱的不是建连，**是建连之后的静默**。
//!
//! HTTP 客户端的 timeout 基本只覆盖初始 fetch —— 一旦响应头回来了，
//! body 挂在那里不动，它就管不着了。表现是 agent 转圈转到天荒地老，
//! 没有任何错误、没有任何日志，用户只能杀进程。
//!
//! 这条路径在本地开发时几乎碰不到，因为本地网络不会静默挂死。
//! 它专门发生在用户那边：企业代理、移动网络切换、云厂商的 LB 空闲回收。
//!
//! 响应头回来之前那一段也一样没人管 —— 建连超时只管到 TCP / TLS 握手。
//! 那一段由 [`first_byte_deadline`] 和 [`post_within`] 兜着。
//!
//! # 超时之后做什么
//!
//! 这一层只负责**发现**静默并结束流。降级到非流式请求是调用方的事 ——
//! 把重试策略塞进看门狗会让它同时管两件事，而这两件事的正确性条件完全不同。

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_stream::stream;
use futures::StreamExt;
use futures_core::Stream;
use riot_protocol::provider::{ProviderError, ProviderEvent};
use riot_protocol::tool::Clock;
use tokio_util::sync::CancellationToken;

use crate::transport::{ByteStream, HttpError, HttpRequest, HttpTransport};

/// 默认静默阈值。
///
/// 90 秒是权衡的结果：思考模式下模型确实可能几十秒不吐字，
/// 定得太短会误杀正常的长思考；定得太长则用户已经放弃等待了。
pub const DEFAULT_IDLE: Duration = Duration::from_secs(90);

/// 只收到保活字节、一个事件都解不出来，最多忍多久。
///
/// 网关在上游憋着一个大工具调用（整段文件内容攒齐了才下发参数）时，
/// 会每隔几十秒发一行 `: keep-alive` 注释撑着连接 —— 连接是活的，模型
/// 也在写，只是我们解不出任何东西。这种时候不能按 [`DEFAULT_IDLE`] 杀。
/// 但上游真挂了、网关照样一直保活的话也不能等一辈子：10 分钟够写一个
/// 很大的文件，再长用户早就手动停了。
pub const KEEPALIVE_ONLY_MAX: Duration = Duration::from_secs(600);

/// 字节流的活性：每收到一块字节加一（见 [`track_bytes`]）。
///
/// `[约束]` 看门狗不能只看解出来的事件。SSE 注释（`: keep-alive`）、
/// Anthropic 的 `ping`、只带 role 的空 delta 都解不出事件，按事件计时
/// 的话，网关正在保活的连接到 90 秒照样被判成静默 —— 用户看到的就是
/// 模型写大文件写到一半报「服务方 90 秒没有发任何数据」。
#[derive(Clone, Default)]
pub struct ByteLiveness(Arc<AtomicU64>);

impl ByteLiveness {
    fn chunks(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// 给字节流挂上活性计数。返回的流原样转发每一块。
pub fn track_bytes(bytes: ByteStream) -> (ByteStream, ByteLiveness) {
    let live = ByteLiveness::default();
    let counter = live.clone();
    let tracked = bytes.inspect(move |chunk| {
        if chunk.is_ok() {
            counter.0.fetch_add(1, Ordering::Relaxed);
        }
    });
    (Box::pin(tracked), live)
}

/// 给事件流套一个静默看门狗。
///
/// 计时器在**每个事件**后重置 —— 看的是「两个事件之间隔了多久」，
/// 不是「整条流跑了多久」。后者会把正常的长响应误杀掉。
pub fn with_idle_watchdog<S>(
    inner: S,
    idle: Duration,
    clock: Arc<dyn Clock>,
) -> impl Stream<Item = ProviderEvent> + Send
where
    S: Stream<Item = ProviderEvent> + Send + 'static,
{
    with_idle_watchdog_live(inner, idle, clock, None)
}

/// 同 [`with_idle_watchdog`]，另外认字节层的活性：一个周期里没有事件、
/// 但收到过字节（保活），就再等一个周期，累计最多 [`KEEPALIVE_ONLY_MAX`]。
pub fn with_idle_watchdog_live<S>(
    inner: S,
    idle: Duration,
    clock: Arc<dyn Clock>,
    live: Option<ByteLiveness>,
) -> impl Stream<Item = ProviderEvent> + Send
where
    S: Stream<Item = ProviderEvent> + Send + 'static,
{
    let idle_ms = idle.as_millis() as u64;
    let keepalive_max_ms = KEEPALIVE_ONLY_MAX.as_millis() as u64;

    stream! {
        futures::pin_mut!(inner);
        // 上个周期结束时见过的字节块数，和"只有保活"已经续了多久。
        let mut seen = live.as_ref().map_or(0, ByteLiveness::chunks);
        let mut keepalive_ms = 0u64;

        loop {
            let tick = clock.sleep_ms(idle_ms);

            tokio::select! {
                // biased 让「有数据」优先于「超时」。没有它的话，数据和超时
                // 同时就绪时 select 会随机挑一个 —— 表现为偶发的假超时，
                // 而且只在负载高的时候出现。
                biased;

                item = inner.next() => {
                    match item {
                        Some(ev) => {
                            keepalive_ms = 0;
                            seen = live.as_ref().map_or(0, ByteLiveness::chunks);
                            // 错误事件之后流就该结束了，别再等下一个
                            let is_terminal = matches!(ev, ProviderEvent::Error(_));
                            yield ev;
                            if is_terminal {
                                break;
                            }
                        }
                        None => break,
                    }
                }

                _ = tick => {
                    if let Some(l) = &live {
                        let now = l.chunks();
                        if now != seen {
                            seen = now;
                            keepalive_ms += idle_ms;
                            if keepalive_ms < keepalive_max_ms {
                                tracing::debug!(keepalive_secs = keepalive_ms / 1000, "只有保活字节，继续等");
                                continue;
                            }
                            tracing::warn!(keepalive_secs = keepalive_ms / 1000, "只有保活、没有内容太久，结束本条流");
                            yield ProviderEvent::Error(ProviderError::Transport {
                                error: riot_protocol::ui_error!(
                                    "kernel.provider.keepaliveOnly", mins = keepalive_ms / 60_000;
                                    "stream stalled: the server only sent keep-alive pings and no content for a long time"
                                ),
                            });
                            break;
                        }
                    }
                    // 证据采集：是否值得实现"超时后降级非流式"（ARCHITECTURE
                    // §11.3 标注未实现）取决于这条真实触发的频率。日志攒一阵，
                    // 频率可观再排期，别为没证实的场景先付一套非流式解析。
                    tracing::warn!(idle_secs = idle.as_secs(), "流式静默超时，结束本条流");
                    yield ProviderEvent::Error(ProviderError::Transport {
                        error: riot_protocol::ui_error!(
                            "kernel.provider.idle", secs = idle.as_secs();
                            "stream idle: connection still open but the server stopped sending data (usually a proxy or gateway issue)"
                        ),
                    });
                    break;
                }
            }
        }
    }
}

/// 「还没出内容就静默」最多重试几次。
///
/// 不能沿用重试策略的次数（默认 10 次）：每一次都要先干等满一个静默周期
/// 才知道失败，10 次就是一刻钟的转圈。两次之后仍然一个字节都没有，多半
/// 是网关或上游真出了问题，该把错误交给用户了。
pub const STALL_RETRIES: u32 = 2;

/// 流阶段交给 provider 的一项。见 [`hold_until_content`]。
pub enum Guarded {
    Event(ProviderEvent),
    /// 一个字的内容都还没吐，就被看门狗判了静默。带着原来的错误事件，
    /// 重试用完时原样交出去。
    StalledBeforeContent(ProviderEvent),
}

/// 把「还没出内容就静默」从普通的流错误里分出来，让 provider 可以重试。
///
/// 流阶段一律不重试的理由是界面已经画了吐出去的内容，重试会让同一段字
/// 出现两次。可网关有时拿了响应头就整段憋着，一个字节都不发（连保活都
/// 没有）—— 那时什么都还没画，重试是安全的，而不重试的代价是这一轮直接
/// 报错停下，用户得自己打「继续」。
///
/// "内容"指 [`ProviderEvent::Delta`] / [`ProviderEvent::Message`]。在它之前
/// 到的用量事件先扣着：重试的话那一次的用量作废，第一次见到内容再一起放。
pub fn hold_until_content<S>(inner: S) -> impl Stream<Item = Guarded> + Send
where
    S: Stream<Item = ProviderEvent> + Send + 'static,
{
    stream! {
        futures::pin_mut!(inner);
        let mut held: Vec<ProviderEvent> = Vec::new();
        let mut started = false;
        while let Some(ev) = inner.next().await {
            if !started {
                match &ev {
                    ProviderEvent::Delta(_) | ProviderEvent::Message(_) => started = true,
                    ProviderEvent::Error(e) if is_idle_timeout(e) => {
                        yield Guarded::StalledBeforeContent(ev);
                        return;
                    }
                    ProviderEvent::Error(_) => {}
                    _ => {
                        held.push(ev);
                        continue;
                    }
                }
                for h in held.drain(..) {
                    yield Guarded::Event(h);
                }
            }
            yield Guarded::Event(ev);
        }
        for h in held {
            yield Guarded::Event(h);
        }
    }
}

/// 重试前的退避。等待期间被取消就提前返回 `false`，调用方据此结束流。
///
/// `[约束]` 不能睡醒了再看令牌。一次退避最长到重试策略的上限（默认 32
/// 秒），主循环对模型流有宽限期兜底，但压缩、总结这些直接读 provider 流
/// 的调用方没有 —— 用户按了停止，它们会陪着退避干等。
pub async fn wait_before_retry(
    clock: &dyn Clock,
    after: Duration,
    cancel: &CancellationToken,
) -> bool {
    tokio::select! {
        () = clock.sleep_ms(after.as_millis() as u64) => true,
        () = cancel.cancelled() => false,
    }
}

/// 等响应头的宽档：截止过一次之后的重发，以及本机 / 局域网地址。
///
/// 有的中转把整段生成攒齐了才回响应头，本地模型要装载完、读完整段提示词
/// 才回 —— 按静默阈值等它们必然超时。10 分钟和 [`KEEPALIVE_ONLY_MAX`] 同一
/// 个量级：再长用户早就手动停了。
pub const SLOW_HEADERS_MAX: Duration = Duration::from_secs(600);

/// 等不到响应头最多重发几次。重发那次已经放宽到 [`SLOW_HEADERS_MAX`]，
/// 还等不到就是真不通，该把错误交给用户。
pub const NO_HEADERS_RETRIES: usize = 1;

/// 这一次请求最多等多久拿到响应头。
///
/// `[约束]` 建连超时管不到这一段：连上之后、响应头回来之前，对面可以
/// 无限期地憋着。开着 TUN 代理（Clash / Surge 的 fake-IP）的机器上，任何
/// 外网 TCP 都被当场接通，上游不通时得等代理自己放弃，实测两分钟以上，
/// 界面全程只有转圈。Codex 至今卡在这里（openai/codex#41985）。
///
/// 两档，照 Claude Code 的做法：头一次按静默阈值，再按请求体大小加时
/// （每 32KB 一秒 —— 长上下文上传本身就慢，服务方也要读完才回头），黑洞
/// 连接在这一档就被发现；截止过一次之后（`slow`）放宽到 [`SLOW_HEADERS_MAX`]。
///
/// 本机和局域网地址直接用宽档：本地模型几分钟才回响应头是常态，而这些
/// 地址不走 TUN，没有黑洞可防。
pub fn first_byte_deadline(req: &HttpRequest, idle: Duration, slow: bool) -> Duration {
    if slow || crate::endpoint::is_local(&req.url) {
        return SLOW_HEADERS_MAX;
    }
    let upload = Duration::from_secs((req.body.len() / 32_768) as u64);
    (idle + upload).min(SLOW_HEADERS_MAX)
}

/// 请求阶段的结果。见 [`post_within`]。
pub enum Sent {
    Stream(ByteStream),
    Failed(HttpError),
    /// 到截止时间还没等到响应头。请求随之丢掉，连接中止。
    NoHeaders,
}

/// 发请求，最多等 `deadline` 拿到响应头。
pub async fn post_within(
    transport: &dyn HttpTransport,
    req: HttpRequest,
    cancel: CancellationToken,
    clock: &dyn Clock,
    deadline: Duration,
) -> Sent {
    tokio::select! {
        // 响应头和截止同时就绪时认响应头：已经回来的结果不该判成超时。
        biased;
        r = transport.post_sse(req, cancel) => match r {
            Ok(s) => Sent::Stream(s),
            Err(e) => Sent::Failed(e),
        },
        () = clock.sleep_ms(deadline.as_millis() as u64) => Sent::NoHeaders,
    }
}

/// 这是不是看门狗判的「完全静默」（连保活字节都没有）。
fn is_idle_timeout(e: &ProviderError) -> bool {
    matches!(e, ProviderError::Transport { error } if error.key() == "kernel.provider.idle")
}

/// 生产用的时钟。
///
/// 测试里用 `tokio::time::pause()` 控制它 —— tokio 的时间轮在暂停后会
/// 自动推进到下一个 timer，所以 90 秒的超时能在几微秒内测完。
/// 这比自己造一个可快进的 Clock 更可靠：它连 `select!` 的调度语义
/// 一起模拟了，而手写的 mock 只能模拟「时间到了」。
pub struct TokioClock;

#[async_trait::async_trait]
impl Clock for TokioClock {
    // 豁免理由：这就是 Clock 的生产实现本身，它必须碰真实时间。
    // 内核侧代码一律通过注入的 Clock 使用它，不直接调这两个 API。
    #[allow(clippy::disallowed_methods)]
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// 本地时区偏移。每次现查不缓存 —— 夏令时切换和用户改时区都该
    /// 下一轮就生效，而 `localtime_r` 本来就只是一次结构体填充的开销。
    ///
    /// `localtime_r` 是唯一同时覆盖 macOS/Linux 的标准做法；为这一个数
    /// 引整套 chrono 不划算（同 riot-tools date.rs 的取舍）。Windows 走
    /// trait 默认值 0：时钟行会诚实标注 UTC，不会把 UTC 假装成本地时刻。
    #[cfg(unix)]
    fn tz_offset_minutes(&self) -> i32 {
        let secs = (self.now_ms() / 1000) as libc::time_t;
        // SAFETY: tm 是本线程栈上的出参，zeroed 的 tm 对 localtime_r 合法
        // （它只写不读）；localtime_r 是线程安全变体。
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
            return 0;
        }
        (tm.tm_gmtoff / 60) as i32
    }

    #[allow(clippy::disallowed_methods)]
    async fn sleep_ms(&self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
}

#[cfg(test)]
// 豁免理由：这些测试验证的就是「时间流逝」本身，被测对象是看门狗的计时。
// 跑在 `start_paused = true` 下，tokio 的时间轮会自动推进到下一个 timer，
// 所以 90 秒的超时在几微秒内测完 —— 既不慢，也不依赖真实挂钟。
#[allow(clippy::disallowed_methods)]
mod tests {
    use super::*;
    use riot_protocol::event::StreamDelta;
    use riot_protocol::id::MessageId;

    fn delta(text: &str) -> ProviderEvent {
        ProviderEvent::Delta(StreamDelta::Text {
            message_id: MessageId::from_raw("m1"),
            text: text.into(),
        })
    }

    fn is_idle_error(ev: &ProviderEvent) -> bool {
        matches!(
            ev,
            ProviderEvent::Error(ProviderError::Transport { error }) if error.key() == "kernel.provider.idle"
        )
    }

    #[tokio::test(start_paused = true)]
    async fn 正常流不受影响() {
        let inner = futures::stream::iter(vec![delta("a"), delta("b")]);
        let s = with_idle_watchdog(inner, DEFAULT_IDLE, Arc::new(TokioClock));
        let out: Vec<_> = s.collect().await;

        assert_eq!(out.len(), 2);
        assert!(!out.iter().any(is_idle_error));
    }

    #[tokio::test(start_paused = true)]
    async fn 建连后静默会被抓到() {
        // 这是 HTTP timeout 完全覆盖不到的场景：连接活着，但没数据。
        // 没有看门狗的话，agent 会永远转圈。
        let inner = futures::stream::pending::<ProviderEvent>();
        let s = with_idle_watchdog(inner, Duration::from_secs(90), Arc::new(TokioClock));
        let out: Vec<_> = s.collect().await;

        assert_eq!(out.len(), 1);
        assert!(is_idle_error(&out[0]), "{:?}", out[0]);
    }

    #[tokio::test(start_paused = true)]
    async fn 计时器在每个事件后重置() {
        // 看的是「两个事件之间隔了多久」，不是「整条流跑了多久」。
        // 判错的话，正常的长响应会被误杀。
        let idle = Duration::from_secs(10);

        let inner = stream! {
            for i in 0..5 {
                // 每次都比阈值短，但累计远超阈值
                tokio::time::sleep(Duration::from_secs(8)).await;
                yield delta(&format!("chunk{i}"));
            }
        };

        let s = with_idle_watchdog(inner, idle, Arc::new(TokioClock));
        let out: Vec<_> = s.collect().await;

        assert_eq!(out.len(), 5, "累计 40 秒 > 阈值 10 秒，但每一段都没超");
        assert!(!out.iter().any(is_idle_error));
    }

    #[tokio::test(start_paused = true)]
    async fn 中途静默会被抓到() {
        let idle = Duration::from_secs(10);

        let inner = stream! {
            yield delta("开头");
            tokio::time::sleep(Duration::from_secs(60)).await;
            yield delta("这条永远到不了");
        };

        let s = with_idle_watchdog(inner, idle, Arc::new(TokioClock));
        let out: Vec<_> = s.collect().await;

        assert_eq!(out.len(), 2);
        assert!(matches!(out[0], ProviderEvent::Delta(_)));
        assert!(is_idle_error(&out[1]));
    }

    #[tokio::test(start_paused = true)]
    async fn 错误之后不再等待() {
        // 错误是终止事件。继续等下一个只会白白多耗一个 idle 周期，
        // 用户要多等 90 秒才看到那个本该立刻显示的错误。
        let inner = stream! {
            yield ProviderEvent::Error(crate::errors::auth("401"));
            futures::future::pending::<()>().await;
            yield delta("不可达");
        };

        let s = with_idle_watchdog(inner, Duration::from_secs(90), Arc::new(TokioClock));
        let out: Vec<_> = s.collect().await;

        assert_eq!(out.len(), 1, "错误后应立即结束，不再空等一个 idle 周期");
        assert!(matches!(
            out[0],
            ProviderEvent::Error(ProviderError::Auth { .. })
        ));
    }

    /// 每 `every` 秒往活性计数上加一块（模拟网关的 `: keep-alive`）。
    fn keepalive(live: &ByteLiveness, every: u64) -> tokio::task::JoinHandle<()> {
        let live = live.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(every)).await;
                live.0.fetch_add(1, Ordering::Relaxed);
            }
        })
    }

    #[tokio::test(start_paused = true)]
    async fn 只有保活字节时不按静默杀() {
        // 网关憋着一个大工具调用、每 30 秒发一行保活：200 秒后参数才到。
        // 按事件计时的话 90 秒就被杀了 —— 用户看到的就是写大文件报错。
        let live = ByteLiveness::default();
        let pinger = keepalive(&live, 30);
        let inner = stream! {
            tokio::time::sleep(Duration::from_secs(200)).await;
            yield delta("参数到了");
        };
        let s = with_idle_watchdog_live(inner, DEFAULT_IDLE, Arc::new(TokioClock), Some(live));
        let out: Vec<_> = s.collect().await;
        pinger.abort();

        assert_eq!(out.len(), 1, "{out:?}");
        assert!(matches!(out[0], ProviderEvent::Delta(_)));
    }

    #[tokio::test(start_paused = true)]
    async fn 只有保活太久也会结束() {
        // 上游挂了、网关照样保活：不能等一辈子。
        let live = ByteLiveness::default();
        let pinger = keepalive(&live, 30);
        let inner = futures::stream::pending::<ProviderEvent>();
        let start = tokio::time::Instant::now();
        let s = with_idle_watchdog_live(inner, DEFAULT_IDLE, Arc::new(TokioClock), Some(live));
        let out: Vec<_> = s.collect().await;
        pinger.abort();

        assert_eq!(out.len(), 1);
        assert!(
            matches!(&out[0], ProviderEvent::Error(ProviderError::Transport { error }) if error.key() == "kernel.provider.keepaliveOnly"),
            "{:?}",
            out[0]
        );
        let waited = start.elapsed();
        assert!(
            waited >= KEEPALIVE_ONLY_MAX && waited < KEEPALIVE_ONLY_MAX + DEFAULT_IDLE,
            "{waited:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn 连字节都没有仍按静默杀() {
        let live = ByteLiveness::default();
        let inner = futures::stream::pending::<ProviderEvent>();
        let s = with_idle_watchdog_live(inner, DEFAULT_IDLE, Arc::new(TokioClock), Some(live));
        let out: Vec<_> = s.collect().await;
        assert_eq!(out.len(), 1);
        assert!(is_idle_error(&out[0]), "{:?}", out[0]);
    }

    #[tokio::test]
    async fn track_bytes_按块计数且原样转发() {
        let chunks: Vec<Result<Vec<u8>, crate::transport::HttpError>> = vec![
            Ok(b": keep-alive\n\n".to_vec()),
            Ok(b"data: {}\n\n".to_vec()),
        ];
        let (s, live) = track_bytes(Box::pin(futures::stream::iter(chunks)));
        let out: Vec<_> = s.collect().await;
        assert_eq!(out.len(), 2);
        assert_eq!(live.chunks(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn 退避中被取消立刻返回() {
        let cancel = CancellationToken::new();
        let canceller = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                cancel.cancel();
            })
        };
        let start = tokio::time::Instant::now();
        let slept = wait_before_retry(&TokioClock, Duration::from_secs(32), &cancel).await;
        canceller.await.unwrap();

        assert!(!slept, "被取消要告诉调用方别再重试");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "{:?}",
            start.elapsed()
        );
        assert!(
            wait_before_retry(
                &TokioClock,
                Duration::from_secs(5),
                &CancellationToken::new()
            )
            .await
        );
    }

    #[tokio::test(start_paused = true)]
    async fn 空流立即结束() {
        let inner = futures::stream::empty::<ProviderEvent>();
        let s = with_idle_watchdog(inner, DEFAULT_IDLE, Arc::new(TokioClock));
        let out: Vec<_> = s.collect().await;
        assert!(out.is_empty(), "空流不是静默，不该报超时");
    }

    fn request(url: &str, body_bytes: usize) -> HttpRequest {
        HttpRequest {
            url: url.into(),
            headers: vec![],
            body: vec![b'x'; body_bytes],
        }
    }

    #[test]
    fn 首字节截止_两档_本地直接宽档() {
        let remote = "https://api.deepseek.com/v1/chat/completions";
        assert_eq!(
            first_byte_deadline(&request(remote, 1_000), DEFAULT_IDLE, false),
            DEFAULT_IDLE
        );
        assert_eq!(
            first_byte_deadline(&request(remote, 320 * 1024), DEFAULT_IDLE, false),
            DEFAULT_IDLE + Duration::from_secs(10),
            "长上下文上传本身就慢，每 32KB 加一秒"
        );
        assert_eq!(
            first_byte_deadline(&request(remote, 64 * 1024 * 1024), DEFAULT_IDLE, false),
            SLOW_HEADERS_MAX,
            "加时也封在宽档以内"
        );
        assert_eq!(
            first_byte_deadline(&request(remote, 1_000), DEFAULT_IDLE, true),
            SLOW_HEADERS_MAX,
            "截止过一次就放宽：有的中转攒齐整段才回响应头"
        );
        assert_eq!(
            first_byte_deadline(
                &request("http://127.0.0.1:11434/v1/chat/completions", 1_000),
                DEFAULT_IDLE,
                false
            ),
            SLOW_HEADERS_MAX,
            "本地模型装载、读提示词就要几分钟，头一次也给宽档"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn 响应头不来按截止返回_来了照常交出() {
        use crate::transport::{ScriptedResponse, ScriptedTransport};
        let t = ScriptedTransport::new(vec![
            ScriptedResponse::NoHeaders,
            ScriptedResponse::Chunks(vec![b"data: {}\n\n".to_vec()]),
        ]);
        let req = || request("https://api.test/v1", 10);

        let start = tokio::time::Instant::now();
        let sent = post_within(
            &t,
            req(),
            CancellationToken::new(),
            &TokioClock,
            DEFAULT_IDLE,
        )
        .await;
        assert!(matches!(sent, Sent::NoHeaders));
        let waited = start.elapsed();
        assert!(
            waited >= DEFAULT_IDLE && waited < DEFAULT_IDLE + Duration::from_secs(1),
            "{waited:?}"
        );

        let sent = post_within(
            &t,
            req(),
            CancellationToken::new(),
            &TokioClock,
            DEFAULT_IDLE,
        )
        .await;
        assert!(matches!(sent, Sent::Stream(_)));
    }
}
