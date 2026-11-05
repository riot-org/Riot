# 开发

从源码跑、测、打包、发版。架构约束见 [ARCHITECTURE.md](ARCHITECTURE.md)，验证分层见 [VERIFICATION.md](VERIFICATION.md)。

需要 Rust 1.88+、Node 22、pnpm 10。

## 跑起来

```bash
pnpm install
pnpm tauri dev
```

只看前端布局（宿主 bridge 不可用）：

```bash
pnpm dev
```

从 Dock 或访达启动的应用继承不到 shell 环境变量，这是 macOS 的行为。日常开发用 `pnpm tauri dev`；key 已经在设置里存过，不必再 `export`。环境变量与存档同名时优先于存档，用来临时覆盖。

想先在终端确认模型链路（GUI 会把 key 没读到、base URL 写错、模型名不存在都表现成「没反应」）：

```bash
export DEEPSEEK_API_KEY=sk-...
cargo run -p riot-providers --example smoke

MODEL=deepseek-reasoner cargo run -p riot-providers --example smoke

BASE_URL=https://api.moonshot.cn MODEL=kimi-k2-turbo-preview \
  KEY_ENV=MOONSHOT_API_KEY cargo run -p riot-providers --example smoke
```

## 日常命令

```bash
cargo check --workspace
cargo test --workspace          # 不变量断言只在 debug 下 panic，不要只跑 release
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt
pnpm typecheck
pnpm lint
pnpm test                       # 前端单测（vitest）：事件→条目、快照对账、增量解析、流式切块

# 改了 riot-protocol 里的类型之后必须重新生成，CI 会检查是否同步
pnpm gen
```

`--workspace` 不包含 `riot-browser`（独立 Cargo workspace，避免把 CEF 编进日常构建）。

## 清理 target

旧工具链和长期没用的产物堆在 `target/` 里。用 `cargo-sweep` 按时间、工具链或体积删（`cargo install cargo-sweep`，本机 0.8，选项直接写在 `cargo sweep` 后面），增量缓存还在。

```bash
cargo sweep --time 30                 # 超过 30 天没被访问过的产物
cargo sweep --installed               # 只留当前 rustup 工具链编出来的
cargo sweep --maxsize 2GB --dry-run   # 从最旧的开始删，直到 target 小于这个体积；默认单位 MB

# 只留接下来这次构建真正用到的产物。两条命令中间必须跑构建
cargo sweep --stamp
cargo check --workspace && cargo test --workspace
cargo sweep --file --dry-run          # 先看会删什么
cargo sweep --file
```

`--stamp` 只在当前目录写 `sweep.timestamp`，不删文件。`--file` 读这个时间，删掉 `target/<profile>/.fingerprint/` 里访问时间更早的 crate，以及 `deps/`、`build/` 里同一份指纹对应的文件，然后删掉戳文件。`--dry-run` 只打印，戳还留着。`incremental/` 不参与这次清理。

两条命令不要连着跑。中间没有构建的话，现有产物的访问时间都早于戳，几乎会被整份清掉。判断依据是指纹文件的访问时间，不是「这条 cargo 命令成功了」：构建要真的读到这些指纹，对应 crate 才会留下。

主 workspace 在仓库根目录打一次戳即可，成员 crate 共用一份 `target/`。`crates/riot-browser` 是另一个 workspace，要进那个目录单独打戳、再构建、再 `--file`。`--recursive` 只往下找 Cargo 项目，不处理你当前所在的这一层。

## 内置浏览器

```bash
# 将 CEF 拉到 $HOME/.local/share/cef（或设置 CEF_PATH）
# 二进制来自 https://github.com/tauri-apps/cef-rs 的 export-cef-dir
./scripts/build-browser.sh
```

macOS 上浏览器必须从 `.app` bundle 启动。`pnpm tauri dev` 已经在跑的话，打完包要重启一次，宿主只在启动时定位浏览器。Windows 用 `scripts/build-browser.ps1`，需要 VS 的「使用 C++ 的桌面开发」工作负载。

Linux（只给无界面的 `riot-server` 用）跑同一个 `build-browser.sh`，CEF 由构建自动下载，产物是 `crates/riot-browser/target/bundle/riot-browser/` 平铺目录。运行时依赖和差异见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md) §9。

浏览器是可选能力：没打过包也能起主应用，只是 Browser 工具和面板不可用。

## 无界面服务器版

`riot-server` 和桌面版同在 `riot-host` 包里，不带 `desktop` 特性就不链接 Tauri / GTK：

```bash
pnpm build                       # 网页版前端，riot-server 从 dist/ 提供
cargo build -p riot-kernel
cargo run -p riot-host --no-default-features --bin riot-server
```

镜像用 `docker build -f deploy/server/Dockerfile -t riot-server .`；不用 Docker 的话 `scripts/package-server.sh` 打 tar 包。部署、登录令牌和沙箱见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md) §9。

## 浏览器 profile

浏览器进程全应用只有一个，所有会话共用，profile（cookie、localStorage）在配置目录旁的 `browser-profile/`，跨会话、跨重启保留 —— 在一个会话里登录过的站点，别的会话直接是登录态。想回到干净状态就退出应用后删掉那个目录。每个会话仍然有自己的标签页，互不可见。模型在面板关着时开的页算临时页，一轮结束就关掉；面板开着时开的、上过屏的、或模型用 `show: true` 打开、调过 ShowBrowser 的页留到会话删除。

## 打包

```bash
# mac
./scripts/build-browser.sh
# win
powershell -ExecutionPolicy Bypass -File .\scripts\build-browser.ps1

pnpm tauri build
```

产物在 `src-tauri/target/release/bundle/`（`.app` / `.dmg` / NSIS）。

正式安装包和服务器镜像由 `.github/workflows/release.yml` 出：推 `Riot_<版本>` tag（或在 Actions 里手动跑 Release），先建一份 draft Release，macOS / Windows 安装包挂上去，Linux x86_64 / arm64 镜像推到 `ghcr.io/<owner>/riot-server:<版本>`，全部成功后才发布。

## 仓库分层

```
crates/          内核、工具、权限、模型适配、协议
src-tauri/       宿主：窗口、会话、终端、浏览器、权限弹窗；也出 riot-server
src/             React 界面；只有 src/bridge/ 可以调用 Tauri
schemas/         从 Rust 类型生成，勿手改
deploy/          服务器镜像、systemd unit、SearXNG
scripts/         浏览器 / 服务器打包、CI 辅助
vendor/          file-viewer、srt-win（Windows 沙箱）
docs/            架构、验证、开发
```

依赖方向是 `protocol ← core ← kernel`。`core` 不得依赖 UI。前端不得在 `bridge/` 以外 `import @tauri-apps/api`。

## 发新版本

设置 → 关于里的「检查更新」比的是 Riot 应用本身的版本。改这几处，保持一致：

- `package.json` 的 `version`
- `Cargo.toml` 的 `[workspace.package].version`（各 crate 写 `version.workspace = true`，不用逐个改）
- `src-tauri/tauri.conf.json` 的 `version`
- `Cargo.lock` 和 `crates/riot-browser/Cargo.lock`：改完版本号跑 `cargo check --workspace` 和 `cargo update -p riot-protocol --manifest-path crates/riot-browser/Cargo.toml` 让它们跟上（后者锁着 `riot-protocol` 的版本）。发版构建带 `--locked`，锁文件没跟上会直接失败

提交后推 `Riot_<版本>` tag 触发发版。

宿主从 `tauri.conf.json` 读这份号：关于页显示、对照 GitHub 最新正式 Release，都是它。Release tag 写成 `0.1.1`、`v0.1.1` 或 `Riot_0.1.1` 都行。

测试夹具里的版本号不用改。文档插件在 [`plugin-doc-runtime`](https://github.com/riot-org/plugin-doc-runtime)，版本写在那边的 `plugin.json`。见 [ARCHITECTURE.md](ARCHITECTURE.md) §15.6。
