//! 用户在「设置 → 环境变量」里配的变量（API key、密码、令牌……）。
//!
//! 这些值**不进上下文**：模型只知道名字，命令里用 `$NAME` 引用，值由
//! 进程执行器注入子进程（见 riot-kernel 的 `UserEnvRunner`）。万一命令把
//! 值打印出来（`echo $KEY`、`cat .env`），出口遮蔽（[`mask`]）把它换成
//! `[已遮蔽：$NAME]` 再交给模型。
//!
//! 一份进程级的表：内核一个进程服务所有会话，变量是应用级设置，不分会话。
//! 宿主每轮随 `TurnConfig` 带一份全量，设置里改了另外推一次（`env.set`）
//! —— 跑轮中经 `RequestEnv` 表单填的值，下一条命令就要用得上，不能等到
//! 下一轮。
//!
//! 放在 riot-tools 而不是内核：遮蔽在这一层的调度器里做，内核只负责写入
//! 和注入，两边读同一份。

use std::sync::{LazyLock, RwLock};

/// 当前生效的变量，按名字排序。
static STORE: LazyLock<RwLock<Vec<(String, String)>>> = LazyLock::new(|| RwLock::new(Vec::new()));

/// 比这短的值不遮：`1`、`true`、`dev` 这类会在输出里到处误伤，而它们
/// 本来也不是机密。
const MIN_MASK_LEN: usize = 6;

/// 整表替换。空名字、空值丢掉。
pub fn set(vars: Vec<(String, String)>) {
    let mut vars: Vec<(String, String)> = vars
        .into_iter()
        .filter(|(k, v)| !k.trim().is_empty() && !v.is_empty())
        .collect();
    vars.sort_by(|a, b| a.0.cmp(&b.0));
    vars.dedup_by(|a, b| a.0 == b.0);
    *STORE.write().unwrap_or_else(|e| e.into_inner()) = vars;
}

/// 一份快照，给进程执行器注入用。
pub fn snapshot() -> Vec<(String, String)> {
    STORE.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 这个变量配了没有。
pub fn is_set(name: &str) -> bool {
    STORE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|(k, _)| k == name)
}

/// 把文本里出现的变量值换成 `[已遮蔽：$NAME]`。没命中返回 None。
///
/// 长的值先换：一个值是另一个值的子串时，先换短的会把长的那个切碎、
/// 剩下半截漏出去。
pub fn mask(text: &str) -> Option<String> {
    let store = STORE.read().unwrap_or_else(|e| e.into_inner());
    let mut vars: Vec<&(String, String)> = store
        .iter()
        .filter(|(_, v)| v.chars().count() >= MIN_MASK_LEN)
        .collect();
    if vars.is_empty() {
        return None;
    }
    vars.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
    let mut out: Option<String> = None;
    for (k, v) in vars {
        let cur = out.as_deref().unwrap_or(text);
        if cur.contains(v.as_str()) {
            out = Some(cur.replace(v.as_str(), &format!("[已遮蔽：${k}]")));
        }
    }
    out
}

#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 值被换成名字_短值不遮() {
        let _g = test_lock();
        set(vec![
            ("MOSS_API_KEY".into(), "sk-moss-1234567890".into()),
            ("DEBUG".into(), "1".into()),
        ]);
        let got = mask("key=sk-moss-1234567890 debug=1").expect("该遮");
        assert_eq!(got, "key=[已遮蔽：$MOSS_API_KEY] debug=1");
        assert!(mask("nothing here").is_none());
        set(Vec::new());
    }

    #[test]
    fn 长值先换_不被短值切碎() {
        let _g = test_lock();
        set(vec![
            ("SHORT".into(), "abcdef".into()),
            ("LONG".into(), "abcdef-123456".into()),
        ]);
        assert_eq!(mask("x abcdef-123456 y").unwrap(), "x [已遮蔽：$LONG] y");
        set(Vec::new());
    }

    #[test]
    fn 整表替换_空值丢掉_按名字认() {
        let _g = test_lock();
        set(vec![
            ("B".into(), "2".into()),
            ("A".into(), "".into()),
            ("C".into(), "3".into()),
        ]);
        assert!(is_set("B") && is_set("C") && !is_set("A"));
        assert_eq!(
            snapshot()
                .iter()
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>(),
            ["B", "C"]
        );
        set(Vec::new());
        assert!(!is_set("B"));
    }
}
