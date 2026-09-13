//! 插件从"市场里有个压缩包"到"模型能用上"的整条链路。
//!
//! 这一条覆盖的是真实用户唯一会走的那条路径：拉市场 → 准备 → 确认 →
//! HTTP 下载 → sha256 校验 → 解压原子切换 → 跑自检 → 注册表登记 → 技能被
//! 发现、MCP 被派生、PATH 被注入 → 卸载干净。
//!
//! 分层的单测各自都过，不等于这条链路通 —— 它们中间靠的是**约定**：构建脚本
//! 写出的 `plugin.json` / `mcp.json` 字段名要和内核加载器对得上，`selfCheck`
//! 里的相对路径要和解压后的实际布局对得上，`pathPrepend` 要和 `PluginRunner`
//! 拼 PATH 的方式对得上。这些约定跨了 JS 和 Rust 两侧、跨了几个模块，任何
//! 一处改名都不会有编译错误，只会在用户装完之后表现为"装是装上了，模型说
//! 找不到工具"。
//!
//! 所以这里不 mock 任何一层：起一个真的 HTTP 服务器当市场 + 资产源，喂一个
//! 真的 tar.zst，跑真的 `plugins::prepare` / `plugins::commit`。
//!
//! 用的是一个几 KB 的合成插件而不是真的 900MB 文档插件：这条链路要验的是
//! 接线，不是 LibreOffice 能不能渲染。后者由 plugin-doc-runtime 的 `scripts/verify.mjs` 负责。

#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use riot_host_lib::plugins::{self, SourceRequest};
use riot_kernel::config::{AppConfig, MarketplaceConfig};

/// 合成一个插件目录。结构和 plugin-doc-runtime 打出来的包一致。
fn build_plugin(dir: &Path, version: &str) {
    let bin = dir.join("bin");
    let path_dir = dir.join("path");
    std::fs::create_dir_all(&bin).expect("建 bin");
    std::fs::create_dir_all(&path_dir).expect("建 path");
    std::fs::create_dir_all(dir.join("skills/demo")).expect("建 skills");

    // 自检要跑得起来的真脚本。带一个可辨识的输出，失败时能看出跑的是哪个。
    for (dir, name) in [(&bin, "fake-python3"), (&path_dir, "fake-soffice")] {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\necho ok-$(basename \"$0\")\n").expect("写脚本");
        set_exec(&p);
    }

    std::fs::write(
        dir.join("skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: 由插件带进来的技能，用于验证发现链路。\n---\n正文。\n",
    )
    .expect("写 SKILL.md");

    std::fs::write(
        dir.join("plugin.json"),
        serde_json::json!({
            "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "name": "doc-runtime",
            "version": version,
            "description": "合成的文档运行时",
            "extensions": { "dev.riot": {
                "platforms": [riot_kernel::plugins::platform_key()],
                "env": { "RUNTIME_BIN_DIR": "./bin", "RUNTIME_NODE": "./bin/fake-python3" },
                "pathPrepend": ["./path"],
                "selfCheck": [{ "command": "./bin/fake-python3", "args": ["--version"] }],
            } }
        })
        .to_string(),
    )
    .expect("写 plugin.json");
    std::fs::write(
        dir.join("mcp.json"),
        serde_json::json!({
            "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
            "mcpServers": { "doc-artifact-tool": {
                "type": "stdio",
                "command": "./bin/fake-python3",
                "args": ["--stdio", "${PLUGIN_ROOT}/skills/demo/SKILL.md"],
            } }
        })
        .to_string(),
    )
    .expect("写 mcp.json");
}

fn set_exec(p: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).expect("加可执行位");
}

/// 打成 tar.zst，外面裹一层顶层目录 —— 构建脚本就是这么打的，安装时要剥掉。
fn tarball(src: &Path, out: &Path, top: &str) -> (u64, String) {
    use sha2::{Digest as _, Sha256};

    let file = std::fs::File::create(out).expect("建压缩文件");
    let enc = zstd::stream::write::Encoder::new(file, 3).expect("建 zstd 编码器");
    let mut builder = tar::Builder::new(enc);
    builder.follow_symlinks(false);
    builder.append_dir_all(top, src).expect("打 tar");
    builder
        .into_inner()
        .expect("收尾 tar")
        .finish()
        .expect("收尾 zstd");

    let bytes = std::fs::read(out).expect("读回压缩文件");
    let mut h = Sha256::new();
    h.update(&bytes);
    (bytes.len() as u64, format!("{:x}", h.finalize()))
}

/// 一个只认 GET 的极简 HTTP 服务器。
///
/// 先绑端口再挂路由：清单里要写下载地址，而地址得等端口分配完才知道。
struct Server {
    listener: Option<tokio::net::TcpListener>,
    base: String,
}

impl Server {
    async fn bind() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("监听端口");
        let base = format!("http://{}", listener.local_addr().expect("取地址"));
        Self {
            listener: Some(listener),
            base,
        }
    }

    fn serve(mut self, routes: Vec<(String, Vec<u8>)>) {
        serve_on(self.listener.take().expect("listener 还在"), routes);
    }
}

fn serve_on(listener: tokio::net::TcpListener, routes: Vec<(String, Vec<u8>)>) {
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let routes = routes.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .split('?')
                    .next()
                    .unwrap_or("/")
                    .to_owned();

                let body = routes.iter().find(|(p, _)| *p == path).map(|(_, b)| b);
                let head = match body {
                    Some(b) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        b.len()
                    ),
                    None => {
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_owned()
                    }
                };
                let _ = sock.write_all(head.as_bytes()).await;
                if let Some(b) = body {
                    let _ = sock.write_all(b).await;
                }
                let _ = sock.flush().await;
            });
        }
    });
}

fn marketplace_json(base: &str, version: &str, size: u64, sha256: &str) -> serde_json::Value {
    serde_json::json!({
        "name": "riot",
        "owner": { "name": "Riot" },
        "plugins": [{
            "name": "doc-runtime",
            "description": "文档运行时",
            "version": version,
            "source": { "source": "archive", "platforms": {
                riot_kernel::plugins::platform_key(): {
                    "url": format!("{base}/doc-runtime.tar.zst"),
                    "sha256": sha256,
                    "size": size,
                    "installedSize": 4096,
                }
            } }
        }]
    })
}

fn no_progress(_: plugins::PluginProgress) {}

#[tokio::test]
async fn 从市场一路装到能用() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let config_path = tmp.path().join("riot/config.json");
    std::fs::create_dir_all(config_path.parent().unwrap()).expect("建目录");

    let src = tmp.path().join("src");
    build_plugin(&src, "1.0.0");
    let archive = tmp.path().join("doc-runtime-1.0.0.tar.zst");
    let (size, sha256) = tarball(&src, &archive, "doc-runtime-1.0.0-any");

    let server = Server::bind().await;
    let base = server.base.clone();
    let market = marketplace_json(&base, "1.0.0", size, &sha256);
    server.serve(vec![
        (
            "/marketplace.json".to_owned(),
            market.to_string().into_bytes(),
        ),
        (
            "/doc-runtime.tar.zst".to_owned(),
            std::fs::read(&archive).expect("读压缩包"),
        ),
    ]);

    let mut config = AppConfig::default();
    config.plugin_marketplaces = vec![MarketplaceConfig {
        id: "riot".into(),
        source: format!("{base}/marketplace.json"),
        enabled: true,
    }];

    // —— 市场 ————————————————————————————————————————————
    let markets = plugins::fetch_markets(&config.plugin_marketplaces, &config_path).await;
    assert_eq!(markets.len(), 1);
    assert!(markets[0].error.is_none(), "{:?}", markets[0].error);
    let entries: Vec<_> = markets
        .iter()
        .flat_map(|m| m.plugins.iter().cloned())
        .collect();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].supported, "本平台该有包");

    // —— 准备：压缩包来源预览只有市场元数据 ——————————————
    let (pending, preview) = plugins::prepare(
        SourceRequest::Market {
            marketplace: "riot".into(),
            name: "doc-runtime".into(),
        },
        &config,
        &config_path,
        &entries,
    )
    .await
    .expect("准备");
    assert!(!preview.contents_verified, "压缩包没下之前只能看市场说的");
    assert_eq!(preview.download_size, size);
    assert_eq!(preview.plugin.id, "doc-runtime");
    assert!(preview.replaces_version.is_none(), "还没装过");

    // —— 确认：下载、校验、解压、自检 ——————————————————————
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = seen.clone();
    let entry = plugins::commit(pending, &config_path, &move |p| {
        sink.lock().expect("锁").push(format!("{p:?}"));
    })
    .await
    .expect("安装");
    let stages = seen.lock().expect("锁").join(" | ");
    for want in [
        "Downloading",
        "Verifying",
        "Extracting",
        "SelfCheck",
        "Done",
    ] {
        assert!(stages.contains(want), "进度里缺 {want}：{stages}");
    }
    assert_eq!(entry.version, "1.0.0");
    config.plugins.push(entry.clone());

    let root = riot_kernel::config::plugin_dir(&config_path, "doc-runtime");
    assert!(
        root.join("plugin.json").is_file(),
        "plugin.json 应该直接在插件根下（顶层目录被剥掉），实际 {}",
        root.display()
    );
    // 可执行位必须活过 tar 往返，否则 shim 全都跑不了（自检其实已经证明了
    // 这点 —— 它真的把 bin/fake-python3 跑起来了）。
    use std::os::unix::fs::PermissionsExt as _;
    let mode = std::fs::metadata(root.join("bin/fake-python3"))
        .expect("读 shim 元信息")
        .permissions()
        .mode();
    assert!(mode & 0o111 != 0, "shim 丢了可执行位，mode={mode:o}");

    // —— 接线一：技能被发现，带插件前缀 ——————————————————
    let loaded = plugins::loaded_enabled(&config, &config_path);
    assert_eq!(loaded.len(), 1);
    // 之后按路径比对都用 canonicalize 过的根：macOS 的临时目录在 /var 下，
    // 而 /var 是 /private/var 的 symlink。
    let root = loaded[0].root.clone();
    let skills = riot_kernel::skills::list(None, &loaded);
    let demo = skills
        .iter()
        .find(|s| s.name == "doc-runtime:demo")
        .expect("插件带来的技能应该被发现，且带 `<插件>:` 前缀");
    assert_eq!(demo.source, "plugin");
    assert_eq!(demo.plugin.as_deref(), Some("doc-runtime"));

    // —— 接线二：MCP 派生，相对路径展开成绝对路径 —————————
    let specs = plugins::mcp_specs(&config, &config_path);
    let server = specs
        .iter()
        .find(|s| s.id == "doc-runtime--doc-artifact-tool")
        .expect("MCP 服务器应该被派生，id 带插件前缀");
    let riot_protocol::rpc::McpTransport::Stdio {
        command,
        args,
        env,
        cwd,
    } = &server.transport
    else {
        panic!("该是 stdio");
    };
    assert_eq!(
        Path::new(command),
        root.join("bin/fake-python3"),
        "command 必须是绝对路径 —— 相对路径会按宿主的 cwd 解析，那是用户的项目目录"
    );
    assert_eq!(args[0], "--stdio", "不是路径的参数原样保留");
    assert_eq!(
        Path::new(&args[1]),
        root.join("skills/demo/SKILL.md"),
        "${{PLUGIN_ROOT}} 要展开"
    );
    assert!(
        env.iter()
            .any(|(k, v)| k == "PLUGIN_DATA" && v.contains("plugin-data")),
        "会话数据要落在插件目录外，否则升级时连同目录一起被替换掉：{env:?}"
    );
    assert_eq!(cwd.as_deref(), Some(root.as_path()), "缺省 cwd 是插件根");

    // —— 接线三：PATH 只放声明的目录，env 解析成绝对路径 ————
    let rt = riot_kernel::plugins::runtime_of(&loaded);
    assert_eq!(
        rt.path_dirs,
        vec![root.join("bin"), root.join("path")],
        "实际 {:?}",
        rt.path_dirs
    );
    assert!(
        rt.env
            .iter()
            .any(|(k, v)| k == "RUNTIME_BIN_DIR" && Path::new(v) == root.join("bin")),
        "RUNTIME_* 要解析成绝对路径 —— skill 自带脚本直接读它们：{:?}",
        rt.env
    );

    // —— 状态页：可升级标记来自市场版本 ————————————————————
    let status = plugins::status_all(&config, &config_path, &entries);
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].version, "1.0.0");
    assert!(status[0].fatal.is_none());
    assert_eq!(status[0].components.skills, vec!["doc-runtime:demo"]);
    assert_eq!(
        status[0].components.mcp_servers[0].id,
        "doc-runtime--doc-artifact-tool"
    );

    // —— 关掉 = 什么都不生效 ————————————————————————————————
    config.plugins[0].enabled = false;
    assert!(plugins::loaded_enabled(&config, &config_path).is_empty());
    assert!(plugins::mcp_specs(&config, &config_path).is_empty());
    config.plugins[0].enabled = true;

    // —— 卸载：目录没了、数据目录没了 ————————————————————
    plugins::uninstall(&entry, &config_path).expect("卸载");
    assert!(!root.exists(), "插件目录应该被删掉");
    assert!(
        !plugins::data_root(&config_path)
            .join("doc-runtime")
            .exists(),
        "数据目录跟着删"
    );
    config.plugins.clear();
    assert!(
        riot_kernel::skills::list(None, &plugins::loaded_enabled(&config, &config_path))
            .iter()
            .all(|s| s.source != "plugin"),
        "卸载后技能也要消失"
    );
}

/// 校验和对不上就必须拒绝，而且不能在磁盘上留下半个插件。
#[tokio::test]
async fn 校验和不匹配时拒绝安装() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let config_path = tmp.path().join("riot/config.json");
    std::fs::create_dir_all(config_path.parent().unwrap()).expect("建目录");

    let src = tmp.path().join("src");
    build_plugin(&src, "1.0.0");
    let archive = tmp.path().join("p.tar.zst");
    let (size, _) = tarball(&src, &archive, "p-1.0.0");

    let server = Server::bind().await;
    // 一个语法合法但内容对不上的哈希：中间人改写或下到半截都长这样。
    let market = marketplace_json(&server.base, "1.0.0", size, &"0".repeat(64));
    server.serve(vec![
        (
            "/marketplace.json".to_owned(),
            market.to_string().into_bytes(),
        ),
        (
            "/doc-runtime.tar.zst".to_owned(),
            std::fs::read(&archive).expect("读压缩包"),
        ),
    ]);
    let (_, entries) = plugins::market::parse("riot", &market.to_string(), None).expect("解析");

    let config = AppConfig::default();
    let (pending, _) = plugins::prepare(
        SourceRequest::Market {
            marketplace: "riot".into(),
            name: "doc-runtime".into(),
        },
        &config,
        &config_path,
        &entries,
    )
    .await
    .expect("准备");
    let err = plugins::commit(pending, &config_path, &no_progress)
        .await
        .expect_err("应该拒绝");
    assert!(
        matches!(err, plugins::InstallError::Checksum { .. }),
        "实际是 {err:?}"
    );
    assert!(
        !riot_kernel::config::plugin_dir(&config_path, "doc-runtime").exists(),
        "校验失败不能留下一个半装的插件 —— 状态会显示已安装，用起来到处报错"
    );
}

/// 自检跑不起来要当成安装失败，而且刚解出来的目录要收掉。
#[tokio::test]
async fn 自检失败会让安装失败() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let config_path = tmp.path().join("riot/config.json");
    std::fs::create_dir_all(config_path.parent().unwrap()).expect("建目录");

    let src = tmp.path().join("src");
    build_plugin(&src, "1.0.0");
    // 模拟"文件在，但这台机器上执行不了"：丢掉可执行位。
    let broken = src.join("bin/fake-python3");
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(&broken, std::fs::Permissions::from_mode(0o644)).expect("去可执行位");

    let archive = tmp.path().join("p.tar.zst");
    let (size, sha256) = tarball(&src, &archive, "p-1.0.0");
    let server = Server::bind().await;
    let market = marketplace_json(&server.base, "1.0.0", size, &sha256);
    server.serve(vec![
        (
            "/marketplace.json".to_owned(),
            market.to_string().into_bytes(),
        ),
        (
            "/doc-runtime.tar.zst".to_owned(),
            std::fs::read(&archive).expect("读压缩包"),
        ),
    ]);
    let (_, entries) = plugins::market::parse("riot", &market.to_string(), None).expect("解析");

    let config = AppConfig::default();
    let (pending, _) = plugins::prepare(
        SourceRequest::Market {
            marketplace: "riot".into(),
            name: "doc-runtime".into(),
        },
        &config,
        &config_path,
        &entries,
    )
    .await
    .expect("准备");
    let err = plugins::commit(pending, &config_path, &no_progress)
        .await
        .expect_err("应该失败");
    assert!(
        matches!(err, plugins::InstallError::SelfCheck(_)),
        "实际是 {err:?}"
    );
    assert!(
        !riot_kernel::config::plugin_dir(&config_path, "doc-runtime").exists(),
        "自检失败要把刚解出来的目录收掉"
    );
}

/// 开发者的路：链接本地目录，不拷贝；改完即生效；同 id 的安装版让位。
#[tokio::test]
async fn 链接本地目录_预览完整_不拷贝() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let config_path = tmp.path().join("riot/config.json");
    std::fs::create_dir_all(config_path.parent().unwrap()).expect("建目录");
    let dev = tmp.path().join("my-plugin");
    build_plugin(&dev, "0.0.1");

    let mut config = AppConfig::default();
    let (pending, preview) = plugins::prepare(
        SourceRequest::Local {
            path: dev.display().to_string(),
        },
        &config,
        &config_path,
        &[],
    )
    .await
    .expect("准备");
    assert!(preview.contents_verified, "本地目录读得到真实内容");
    assert_eq!(preview.plugin.components.skills, vec!["doc-runtime:demo"]);
    assert_eq!(preview.plugin.components.hooks.len(), 0);
    assert!(preview.plugin.linked);

    let entry = plugins::commit(pending, &config_path, &no_progress)
        .await
        .expect("链接");
    assert!(entry.linked_path.is_some());
    assert!(
        !riot_kernel::config::plugin_dir(&config_path, "doc-runtime").exists(),
        "链接不拷贝"
    );
    config.plugins.push(entry.clone());

    // 改完即生效：往目录里再加一个技能，下一次读就有。
    std::fs::create_dir_all(dev.join("skills/extra")).expect("建目录");
    std::fs::write(
        dev.join("skills/extra/SKILL.md"),
        "---\ndescription: 新加的\n---\nx\n",
    )
    .expect("写");
    let loaded = plugins::loaded_enabled(&config, &config_path);
    let names: Vec<String> = riot_kernel::skills::list(None, &loaded)
        .into_iter()
        .filter(|s| s.source == "plugin")
        .map(|s| s.name)
        .collect();
    assert_eq!(names, vec!["doc-runtime:demo", "doc-runtime:extra"]);

    // 卸载链接的插件不能删用户自己的目录。
    plugins::uninstall(&entry, &config_path).expect("卸载");
    assert!(
        dev.join("plugin.json").is_file(),
        "用户的目录一根毫毛都不能动"
    );
}

/// 拿**真的**文档插件走一遍安装。
///
/// 上面那些用的是几 KB 的合成插件，验的是接线；这条验的是"从 Codex 运行时
/// 提取出来的那堆二进制，在一个干净的环境里到底跑不跑得起来"—— 也就是整个
/// 方案里最可能翻车的一环：`soffice` 和 `python3.12` 只有 ad-hoc 签名。
///
/// 挂 `#[ignore]` 是因为它依赖旁边的 plugin-doc-runtime 先打过包，而且要解压近 1GB：
/// `cd ../plugin-doc-runtime && node scripts/build.mjs`
/// `cargo test -p riot-host --test plugins_e2e -- --ignored --nocapture`
#[tokio::test]
#[ignore = "要先跑构建脚本产出真包，且要解压近 1GB"]
async fn 真包在最小环境里装得上() {
    // 默认看旁边 plugin-doc-runtime/dist/<平台>/。本机产物不进 git。
    let dist = std::env::var_os("RIOT_DOC_PLUGIN_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(|p| p.parent())
                .expect("workspace 上一级")
                .join("plugin-doc-runtime")
                .join("dist")
        })
        .join(riot_kernel::plugins::platform_key());
    let manifest_path = dist.join("marketplace.json");
    // `[约束]` 清单**不存在**是「前置条件没满足」，不是「产品坏了」——跳过，
    // 不 panic。CI 的 chaos-host 跑的是 `-- --ignored`，它把所有 ignored 测试
    // 不加区分地一起跑。只对 NotFound 跳过。
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "{} 不在，跳过。先在 plugin-doc-runtime 跑 `node scripts/build.mjs` \
                 （近 1GB），或用 RIOT_DOC_PLUGIN_DIST 指向产物目录。",
                manifest_path.display()
            );
            return;
        }
        Err(e) => panic!("{} 读不动（{e}）", manifest_path.display()),
    };
    let (_, entries) = plugins::market::parse("riot", &raw, None).expect("解析 marketplace.json");
    let entry = entries
        .iter()
        .find(|e| e.name == "doc-runtime")
        .expect("清单里该有 doc-runtime");
    let plugins::market::ResolvedSource::Archive { platforms } = &entry.source else {
        panic!("doc-runtime 该是压缩包来源");
    };
    let asset = platforms
        .get(&riot_kernel::plugins::platform_key())
        .expect("本平台的包");
    let file = asset.url.rsplit('/').next().expect("url 里取文件名");
    let archive = dist.join(file);
    let bytes =
        std::fs::read(&archive).unwrap_or_else(|e| panic!("{} 读不到（{e}）", archive.display()));

    let tmp = tempfile::tempdir().expect("临时目录");
    let config_path = tmp.path().join("riot/config.json");
    std::fs::create_dir_all(config_path.parent().unwrap()).expect("建目录");

    let server = Server::bind().await;
    let mut local = serde_json::from_str::<serde_json::Value>(&raw).expect("json");
    local["plugins"][0]["source"]["platforms"][riot_kernel::plugins::platform_key()]["url"] =
        serde_json::Value::String(format!("{}/{file}", server.base));
    server.serve(vec![(format!("/{file}"), bytes)]);
    let (_, entries) = plugins::market::parse("riot", &local.to_string(), None).expect("解析");

    let started = std::time::Instant::now();
    let (pending, _) = plugins::prepare(
        SourceRequest::Market {
            marketplace: "riot".into(),
            name: "doc-runtime".into(),
        },
        &AppConfig::default(),
        &config_path,
        &entries,
    )
    .await
    .expect("准备");
    // 自检就在 commit 里：它会用最小 PATH 真的把 python3、node、soffice、
    // pdftoppm 各跑一遍。这一步过了，就说明 ad-hoc 签名的二进制在这台机器上
    // 确实能执行 —— 那正是这条用例存在的意义。
    let entry = plugins::commit(pending, &config_path, &no_progress)
        .await
        .expect("真包应该装得上（失败信息里会写是哪个二进制起不来）");
    eprintln!(
        "装好 {} {}，耗时 {:?}",
        entry.id,
        entry.version,
        started.elapsed()
    );

    let mut config = AppConfig::default();
    config.plugins.push(entry.clone());
    let loaded = plugins::loaded_enabled(&config, &config_path);
    assert_eq!(loaded.len(), 1);
    assert!(!loaded[0].skill_dirs.is_empty(), "文档插件该带技能");
    assert_eq!(
        loaded[0].mcp_servers.len(),
        1,
        "该带 artifact-tool 那个 MCP 服务器"
    );

    plugins::uninstall(&entry, &config_path).expect("卸载");
}

/// 打出来的 tar.zst 必须能被宿主解开。
///
/// 构建脚本走的是 `zstd -19` 命令行（macOS）或 Node 的 zlib（Windows），
/// 宿主用的是 zstd crate。三方对同一个格式的理解不一致的话，用户会在
/// "下载完成"之后才看到解压失败。
#[test]
fn 打出来的压缩包宿主解得开() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let src = tmp.path().join("src");
    build_plugin(&src, "2.0.0");
    let archive = tmp.path().join("a.tar.zst");
    tarball(&src, &archive, "a-2.0.0");

    let file = std::fs::File::open(&archive).expect("打开压缩包");
    let dec = zstd::stream::read::Decoder::new(std::io::BufReader::new(file)).expect("建解码器");
    let mut tar = tar::Archive::new(dec);
    let out = tmp.path().join("out");
    tar.unpack(&out).expect("解压");
    assert!(out.join("a-2.0.0/plugin.json").is_file());
}
