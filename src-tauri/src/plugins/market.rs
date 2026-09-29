//! 插件市场：一个含 `marketplace.json` 的 git 仓库，或直接一个 JSON 地址。
//!
//! 三家的市场清单同构（Claude Code 的 `.claude-plugin/marketplace.json`、
//! Cursor 的 `.cursor-plugin/marketplace.json`）：
//!
//! ```json
//! { "name": "acme", "owner": { "name": "Acme" },
//!   "plugins": [ { "name": "x", "description": "…", "version": "1.0.0",
//!                  "source": "./plugins/x" } ] }
//! ```
//!
//! `source` 的几种写法都认：相对路径（市场仓库里的子目录）、
//! `{ "source": "github", "repo": "o/r" }`、`{ "source": "git", "url": … }`、
//! `{ "source": "git-subdir", "url": …, "path": … }`。Riot 自己多一种
//! `{ "source": "archive", "platforms": { "<平台>": { "url", "sha256", "size" } } }`
//! —— 几百 MB 二进制的文档插件走这条，包体在 Releases 里，仓库只放清单。
//!
//! # 怎么拿到清单
//!
//! - 以 `.json` 结尾的 https 地址：直接 GET。
//! - `owner/repo` 或 github 地址：按三个固定路径试 raw.githubusercontent.com，
//!   不用 clone 一个仓库只为读一个文件。
//! - 其它 git 地址：浅 clone 到缓存目录再读。
//!
//! 豁免理由：宿主层，这个模块的职责就是访问网络和执行 git。

#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::path::Path;

use riot_kernel::config::MarketplaceConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::install::InstallError;

/// 市场里的一个插件条目（已把 `source` 解析成能直接安装的形态）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    pub marketplace: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    pub source: ResolvedSource,
    /// 这个平台装得上吗。git 来源永远 true；archive 看有没有本平台的包。
    pub supported: bool,
    /// archive 来源本平台包的下载体积；别的来源为 0。
    pub download_size: u64,
    pub installed_size: u64,
}

/// 能直接拿去安装的来源。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolvedSource {
    Git {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
    Archive {
        /// 平台键 → 资产。
        platforms: BTreeMap<String, ArchiveAsset>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveAsset {
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    /// 解压后占多少盘。设置页拿它提示用户,免得下完才发现空间不够。
    #[serde(default)]
    pub installed_size: u64,
}

/// 一个市场拉下来的样子。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub id: String,
    pub source: String,
    /// 清单里自报的名字。
    pub name: String,
    pub plugins: Vec<MarketEntry>,
    /// 拉取失败的原因。有值时 `plugins` 为空。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<riot_protocol::UiError>,
}

/// 拉一个市场。失败不 panic、不 Err —— 装进 `error` 字段，设置页照常
/// 显示别的市场。
pub async fn fetch(cfg: &MarketplaceConfig, cache_root: &Path) -> Marketplace {
    match fetch_inner(cfg, cache_root).await {
        Ok((name, plugins)) => Marketplace {
            id: cfg.id.clone(),
            source: cfg.source.clone(),
            name,
            plugins,
            error: None,
        },
        Err(e) => Marketplace {
            id: cfg.id.clone(),
            source: cfg.source.clone(),
            name: String::new(),
            plugins: Vec::new(),
            error: Some(e.to_ui()),
        },
    }
}

async fn fetch_inner(
    cfg: &MarketplaceConfig,
    cache_root: &Path,
) -> Result<(String, Vec<MarketEntry>), InstallError> {
    let (raw, repo_url) = if is_json_url(&cfg.source) {
        let body = http_get(&cfg.source)
            .await
            .map_err(|e| e.into_install(&cfg.source))?;
        (body, None)
    } else {
        let repo = repo_url(&cfg.source);
        match github_raw_candidates(&repo) {
            Some(urls) => (fetch_github_manifest(&repo, &urls).await?, Some(repo)),
            None => {
                let dir = cache_root.join(".marketplaces").join(slug(&cfg.id));
                super::source::git_clone(&repo, None, &dir).await?;
                let body = MANIFEST_PATHS
                    .iter()
                    .find_map(|p| std::fs::read_to_string(dir.join(p)).ok())
                    .ok_or_else(|| InstallError::MarketplaceNoManifest(repo.clone()))?;
                (body, Some(repo))
            }
        }
    };
    parse(&cfg.id, &raw, repo_url.as_deref())
}

/// 按三个约定路径逐个试 raw 地址，回第一份拿到的清单。
///
/// 三条候选在同一台主机上，所以连不上时立刻停 —— 再试两次只是把同一个
/// 网络错误多等两轮超时。都试完还没有：全是 404 才算"仓库里没这个文件"；
/// 中间出过别的状态（403 限流、5xx）就报那一个，404 是预期内的，它不是。
async fn fetch_github_manifest(repo: &str, urls: &[String]) -> Result<String, InstallError> {
    let mut other: Option<InstallError> = None;
    for u in urls {
        match http_get(u).await {
            Ok(body) => return Ok(body),
            Err(e @ FetchError::Unreachable { .. }) => return Err(e.into_install(u)),
            Err(FetchError::Status(s)) if s == reqwest::StatusCode::NOT_FOUND => {}
            Err(e) => other = Some(e.into_install(u)),
        }
    }
    Err(other.unwrap_or_else(|| InstallError::MarketplaceNoManifest(repo.to_owned())))
}

const MANIFEST_PATHS: &[&str] = &[
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
    "marketplace.json",
];

/// 直接给一个 JSON 地址。https，或回环上的 http（e2e 测试起本机服务器
/// 当市场；回环上没有"中间人"这回事）。
///
/// `[约束]` 判前缀之后必须看紧跟的那个字符，否则 `http://localhost.evil.com`
/// 会被当成本机。
fn is_json_url(s: &str) -> bool {
    let s = s.trim();
    let path_ok = s.split('?').next().is_some_and(|p| p.ends_with(".json"));
    if !path_ok {
        return false;
    }
    if s.starts_with("https://") {
        return true;
    }
    let Some(rest) = s.strip_prefix("http://") else {
        return false;
    };
    ["127.0.0.1", "[::1]", "localhost"].iter().any(|host| {
        rest.strip_prefix(host)
            .is_some_and(|tail| tail.is_empty() || tail.starts_with([':', '/']))
    })
}

/// `owner/repo` → GitHub 地址；别的原样。
pub fn repo_url(source: &str) -> String {
    let s = source.trim();
    let shorthand = s.split('/').count() == 2
        && !s.contains(':')
        && !s.starts_with('.')
        && !s.starts_with('/')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if shorthand {
        format!("https://github.com/{s}")
    } else {
        s.to_owned()
    }
}

/// GitHub 仓库的 raw 地址候选。不是 GitHub 就 None（只能 clone）。
fn github_raw_candidates(repo: &str) -> Option<Vec<String>> {
    let rest = repo
        .strip_prefix("https://github.com/")
        .or_else(|| repo.strip_prefix("http://github.com/"))
        .or_else(|| repo.strip_prefix("git@github.com:"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.splitn(3, '/');
    let owner = parts.next()?;
    let name = parts.next()?;
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(
        MANIFEST_PATHS
            .iter()
            .map(|p| format!("https://raw.githubusercontent.com/{owner}/{name}/HEAD/{p}"))
            .collect(),
    )
}

/// 一次 GET 失败的三种样子。分开是因为上层要按它决定下一步：连不上就别
/// 再试同一台主机上的别的路径，404 要继续试，其它状态要原样报出去。
#[derive(Debug)]
enum FetchError {
    /// 没拿到响应：DNS、拒连、超时、TLS。`detail` 是 source 链末端的根因。
    Unreachable { host: String, detail: String },
    /// 拿到了响应但不是 2xx。
    Status(reqwest::StatusCode),
    /// 响应体没读完。
    Body(String),
}

const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

impl FetchError {
    fn into_install(self, url: &str) -> InstallError {
        match self {
            FetchError::Unreachable { host, detail } => {
                InstallError::MarketplaceUnreachable { host, detail }
            }
            FetchError::Status(s) => InstallError::Marketplace(format!("{url}: HTTP {s}")),
            FetchError::Body(d) => InstallError::Marketplace(format!("{url}: {d}")),
        }
    }
}

async fn http_get(url: &str) -> Result<String, FetchError> {
    let res = reqwest::Client::new()
        .get(url)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| FetchError::Unreachable {
            host: host_of(url),
            detail: root_cause(&e),
        })?;
    if !res.status().is_success() {
        return Err(FetchError::Status(res.status()));
    }
    res.text()
        .await
        .map_err(|e| FetchError::Body(root_cause(&e)))
}

/// 地址里的主机名；解析不了就整条地址。
fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.to_owned())
}

/// reqwest 错误的根因。
///
/// 它的 `Display` 只说最外层的 "error sending request for url (…)"，真正
/// 能指出方向的那句（"dns error"、"Connection refused"、证书不受信）在
/// source 链的末端。直接拼整条链会把同一句话重复两三遍，只取最深的一层。
/// 超时单独说：它的链末端是一句没有信息量的 "operation timed out"。
fn root_cause(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return format!("timed out after {}s", HTTP_TIMEOUT.as_secs());
    }
    let mut last: Option<String> = None;
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        last = Some(s.to_string());
        src = s.source();
    }
    // 没有 source 链时退回 Display，但先剥掉 URL —— 主机名已经在上一层的
    // 文案里了。`without_url` 要拿所有权而这里只有借用，按 Display 的固定
    // 形态 "<what> for url (<url>)" 把括号那截截掉，效果一样。
    last.unwrap_or_else(|| {
        let s = e.to_string();
        match s.find(" for url (") {
            Some(i) => s[..i].to_owned(),
            None => s,
        }
    })
}

fn slug(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 解析一份市场清单。`repo_url` 是清单所在仓库，相对来源按它解析。
pub fn parse(
    marketplace_id: &str,
    raw: &str,
    repo_url: Option<&str>,
) -> Result<(String, Vec<MarketEntry>), InstallError> {
    let v: Value = serde_json::from_str(raw)
        .map_err(|e| InstallError::Marketplace(format!("marketplace.json: {e}")))?;
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(marketplace_id)
        .to_owned();
    let platform = riot_kernel::plugins::platform_key();
    let mut out = Vec::new();
    for item in v
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(pname) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let source = match resolve_source(item.get("source"), repo_url) {
            Some(s) => s,
            None => {
                tracing::warn!(
                    marketplace = marketplace_id,
                    plugin = pname,
                    "市场条目的 source 认不出，跳过"
                );
                continue;
            }
        };
        let (supported, download_size, installed_size) = match &source {
            ResolvedSource::Git { .. } => (true, 0, 0),
            ResolvedSource::Archive { platforms } => match platforms.get(&platform) {
                Some(a) => (true, a.size, a.installed_size),
                None => (false, 0, 0),
            },
        };
        let s = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_owned);
        out.push(MarketEntry {
            marketplace: marketplace_id.to_owned(),
            name: pname.to_owned(),
            description: s("description"),
            version: s("version"),
            author: match item.get("author") {
                Some(Value::Object(a)) => a.get("name").and_then(Value::as_str).map(str::to_owned),
                Some(Value::String(a)) => Some(a.clone()),
                _ => None,
            },
            homepage: s("homepage"),
            category: s("category"),
            tags: item
                .get("tags")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            source,
            supported,
            download_size,
            installed_size,
        });
    }
    Ok((name, out))
}

fn resolve_source(source: Option<&Value>, repo_url: Option<&str>) -> Option<ResolvedSource> {
    match source? {
        // 相对路径：市场仓库里的子目录。
        Value::String(rel) => {
            let rel = rel.trim().trim_start_matches("./").trim_matches('/');
            let url = repo_url?.to_owned();
            Some(ResolvedSource::Git {
                url,
                git_ref: None,
                subdir: (!rel.is_empty()).then(|| rel.to_owned()),
            })
        }
        Value::Object(o) => {
            let kind = o.get("source").and_then(Value::as_str)?;
            let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
            match kind {
                "github" => Some(ResolvedSource::Git {
                    url: repo_url_from(&s("repo")?),
                    git_ref: s("ref"),
                    subdir: s("path"),
                }),
                "git" | "url" => Some(ResolvedSource::Git {
                    url: s("url")?,
                    git_ref: s("ref"),
                    subdir: s("path"),
                }),
                "git-subdir" => Some(ResolvedSource::Git {
                    url: s("url")?,
                    git_ref: s("ref"),
                    subdir: s("path"),
                }),
                "archive" => {
                    let platforms: BTreeMap<String, ArchiveAsset> =
                        serde_json::from_value(o.get("platforms")?.clone()).ok()?;
                    Some(ResolvedSource::Archive { platforms })
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn repo_url_from(repo: &str) -> String {
    if repo.contains("://") || repo.starts_with("git@") {
        repo.to_owned()
    } else {
        format!("https://github.com/{}", repo.trim_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 三种_source_写法都能解析() {
        let raw = r#"{
          "name": "acme",
          "plugins": [
            { "name": "a", "source": "./plugins/a", "version": "1.0.0", "description": "A" },
            { "name": "b", "source": { "source": "github", "repo": "o/r", "ref": "v2" } },
            { "name": "c", "source": { "source": "git-subdir", "url": "https://x.example/r.git", "path": "p/c" } },
            { "name": "d", "source": { "source": "archive", "platforms": {
                "darwin-arm64": { "url": "https://x/d.tar.zst", "sha256": "ab", "size": 10, "installedSize": 20 } } } },
            { "name": "bad", "source": { "source": "mystery" } }
          ]
        }"#;
        let (name, entries) =
            parse("acme", raw, Some("https://github.com/acme/market")).expect("解析");
        assert_eq!(name, "acme");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c", "d"], "认不出来源的跳过");
        assert_eq!(
            entries[0].source,
            ResolvedSource::Git {
                url: "https://github.com/acme/market".into(),
                git_ref: None,
                subdir: Some("plugins/a".into()),
            },
            "相对路径按市场仓库解析"
        );
        assert_eq!(
            entries[1].source,
            ResolvedSource::Git {
                url: "https://github.com/o/r".into(),
                git_ref: Some("v2".into()),
                subdir: None,
            }
        );
        assert!(matches!(entries[3].source, ResolvedSource::Archive { .. }));
        let here = riot_kernel::plugins::platform_key();
        assert_eq!(entries[3].supported, here == "darwin-arm64");
    }

    #[test]
    fn 没有仓库地址时相对来源无效() {
        let raw = r#"{ "plugins": [ { "name": "a", "source": "./a" } ] }"#;
        let (_, entries) = parse("m", raw, None).expect("解析");
        assert!(entries.is_empty(), "纯 JSON 地址的市场里写相对路径没法解析");
    }

    #[test]
    fn 仓库简写与_raw_地址() {
        assert_eq!(
            repo_url("riot-org/riot-marketplace"),
            "https://github.com/riot-org/riot-marketplace"
        );
        assert_eq!(
            repo_url("https://gitlab.com/a/b.git"),
            "https://gitlab.com/a/b.git"
        );
        let urls = github_raw_candidates("https://github.com/riot-org/riot-marketplace.git")
            .expect("是 GitHub");
        assert_eq!(
            urls[2],
            "https://raw.githubusercontent.com/riot-org/riot-marketplace/HEAD/marketplace.json"
        );
        assert!(github_raw_candidates("https://gitlab.com/a/b").is_none());
        assert!(is_json_url("https://example.com/m.json"));
        assert!(!is_json_url("https://example.com/repo"));
        assert!(
            is_json_url("http://127.0.0.1:8931/marketplace.json"),
            "回环放行"
        );
        assert!(
            !is_json_url("http://evil.example.com/m.json"),
            "非回环明文不行"
        );
        assert!(
            !is_json_url("http://localhost.evil.com/m.json"),
            "前缀后面那个字符要看"
        );
    }

    /// 一个按路径回固定状态码的极简 HTTP 服务器。回 `(地址, 收到的请求路径)`。
    async fn status_server(
        by_path: Vec<(&'static str, u16)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("监听");
        let base = format!("http://{}", listener.local_addr().expect("取地址"));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_owned();
                log.lock().expect("锁").push(path.clone());
                let status = by_path
                    .iter()
                    .find(|(p, _)| path.ends_with(p))
                    .map_or(404, |(_, s)| *s);
                let body = if status == 200 {
                    r#"{"plugins":[]}"#
                } else {
                    ""
                };
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        (base, seen)
    }

    fn candidates(base: &str) -> Vec<String> {
        MANIFEST_PATHS
            .iter()
            .map(|p| format!("{base}/o/r/HEAD/{p}"))
            .collect()
    }

    #[tokio::test]
    async fn 三个路径全_404_才算仓库里没有清单() {
        let (base, seen) = status_server(vec![]).await;
        let err = fetch_github_manifest("https://github.com/o/r", &candidates(&base))
            .await
            .expect_err("全 404 该失败");
        assert!(
            matches!(&err, InstallError::MarketplaceNoManifest(repo) if repo == "https://github.com/o/r"),
            "{err}"
        );
        assert_eq!(seen.lock().expect("锁").len(), 3, "三个候选都要试到");
    }

    #[tokio::test]
    async fn 中间的非_404_状态压过_404() {
        let (base, _) = status_server(vec![(".cursor-plugin/marketplace.json", 403)]).await;
        let err = fetch_github_manifest("https://github.com/o/r", &candidates(&base))
            .await
            .expect_err("403 该失败");
        match &err {
            InstallError::Marketplace(d) => {
                assert!(
                    d.contains("HTTP 403"),
                    "要报那个 403 而不是笼统的没找到：{d}"
                );
                assert!(
                    !d.contains("marketplace:"),
                    "细节里不能再套一层 Display 前缀：{d}"
                );
            }
            other => panic!("该是 Marketplace(HTTP 403)，得到 {other}"),
        }
    }

    #[tokio::test]
    async fn 第一个候选就能拿到时不再多试() {
        let (base, seen) = status_server(vec![(".claude-plugin/marketplace.json", 200)]).await;
        let body = fetch_github_manifest("https://github.com/o/r", &candidates(&base))
            .await
            .expect("第一条就 200");
        assert_eq!(body, r#"{"plugins":[]}"#);
        assert_eq!(seen.lock().expect("锁").len(), 1);
    }

    #[tokio::test]
    async fn 连不上时立刻停_并报主机名而不是整条地址() {
        // 绑一个端口再立刻放掉：之后连它一定被拒。
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").expect("绑端口");
            l.local_addr().expect("取地址").port()
        };
        let base = format!("http://127.0.0.1:{port}");
        let err = fetch_github_manifest("https://github.com/o/r", &candidates(&base))
            .await
            .expect_err("拒连该失败");
        match &err {
            InstallError::MarketplaceUnreachable { host, detail } => {
                assert_eq!(host, "127.0.0.1");
                assert!(
                    !detail.contains("http://") && !detail.contains("error sending request"),
                    "细节该是根因（拒连），不是外层那句套话和整条 URL：{detail}"
                );
                assert!(!detail.is_empty());
            }
            other => panic!("该是 MarketplaceUnreachable，得到 {other}"),
        }
    }
}
