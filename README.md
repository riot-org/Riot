<div align="center">
  <img src="assets/riot-logo.png" width="96" alt="Riot" />

# Riot

**接任何模型、装在自己机器上的 AI 编程 Agent。** 源码公开，Rust 内核，本地执行。

中文 · [English](README.en.md)

[下载](https://github.com/riot-org/Riot/releases/latest) ·
[功能](#功能) ·
[服务器部署](#linux-服务器部署) ·
[开发](#开发)

[![Release](https://img.shields.io/github/v/release/riot-org/Riot?display_name=tag)](https://github.com/riot-org/Riot/releases/latest)
[![License](https://img.shields.io/badge/license-PolyForm%20NC-4B8BBE)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#下载)
</div>

---

![Riot 工作空间](assets/README/workspace-preview.png)

## 功能

**一句话：能接任何模型、能装在自己机器或服务器上的 AI 编程 Agent。** Claude、GPT、DeepSeek、GLM、Kimi 等都能用，同一个界面里随时切换；代码和数据不经过任何第三方中转。

### 写代码

- **代码智能（LSP）**：接入本机装好的 rust-analyzer、typescript-language-server、pyright，跳转定义、查引用、看类型、列符号；改完文件自动附上新出现的错误。
- **自动记忆**：你纠正过的做法、确认过的偏好，Agent 会按项目记下来，下次会话自动带上；在「设置 → 记忆」里查看和修改。
- **GitHub 闭环**：内置 `pr`、`fix-ci`、`address-comments` 技能，用 `gh` 开 PR、读 CI 失败日志并修复、逐条处理审查评论。
- **多 Agent 协作**：检索、分析、实现分给后台子 Agent，主任务负责协调。
- **命令行 / CI**：`riot exec "任务"` 不开界面跑完一个任务就退出，可接管道、出 JSON，见[命令行](#命令行riot-exec)。

### 不只写代码

- **内置浏览器**：Agent 导航、点击、填表、截图，每一步都显示在浏览器面板上；点一下页面元素，选择器和结构就附进对话。
- **文档能力**：直接生成和修改 Word、Excel、PPT、PDF，公式计算和排版渲染都在本机完成。
- **定时任务**：每天、工作日、每周或指定时间自动跑，错过的运行会补上；可设跳过时段。
- **安全测试**：内置爬取、Fuzz、密钥泄露扫描，结果整理成带证据和修复建议的报告。只用于你有权测试的目标。

### 部署

- **远程连接**：用手机或另一台电脑的浏览器连上正在运行的 Riot，任务还在原来那台机器上跑。
- **服务器部署**：部署到 Linux 服务器，电脑合上了任务照样跑。

### 安全

- **命令沙箱**：macOS、Linux 默认开启，Agent 跑的命令只能写项目目录；Windows 需要在「设置 → 权限」里装一次。默认权限模式跟着沙箱走：有沙箱的平台默认放行，Windows 默认 Auto（明显安全的自动放行，其余询问）。
- **项目信任**：项目自带的 `.riot/hooks.json`、技能和命令，要你点过「信任此项目」才会加载 —— hooks 会在你的电脑上直接执行命令，克隆来的陌生仓库不能借它跑代码。
- 「设置 → 通用 → 运行环境」一次看清沙箱、git、gh、语言服务器能不能用，缺了怎么装。

## 下载

| 系统                           | 安装包                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| macOS（Apple Silicon）         | [`Riot_*_aarch64.dmg`](https://github.com/riot-org/Riot/releases/latest)，拖进「应用程序」 |
| Windows 10 / 11（x64）         | [`Riot_*_x64-setup.exe`](https://github.com/riot-org/Riot/releases/latest)，运行安装程序   |
| Linux 服务器（x86_64 / arm64） | `docker pull ghcr.io/riot-org/riot-server:latest`，见[服务器部署](#linux-服务器部署)     |

装好后在设置里填上模型 API Key 就能用。

macOS 包未签名，首次打开被拦时用访达右键 → 打开，或：

```bash
xattr -dr com.apple.quarantine /Applications/Riot.app
```

## Linux 服务器部署

无界面版 `riot-server` 跑在服务器上，用浏览器访问，界面和桌面版一样。镜像支持 x86_64 和 arm64。

**1. 启动容器**

```bash
docker run -d --name riot --restart unless-stopped \
  -p 127.0.0.1:7823:7823 \
  -v riot-home:/home/riot \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  ghcr.io/riot-org/riot-server:latest
```

| 参数 | 说明 |
| --- | --- |
| `-p 127.0.0.1:7823:7823` | 只映射到本机回环。网页版不带 TLS，别直接暴露到公网 |
| `-v riot-home:/home/riot` | 配置、API Key、会话和项目文件都在这里，升级、重建容器不丢 |
| `--security-opt …=unconfined` | 给命令沙箱（bubblewrap）建 user namespace 用。不加也能跑，但 agent 执行的命令不隔离 |
| `--restart unless-stopped` | 服务器重启后自动拉起 |

**2. 拿登录地址**

```bash
docker exec riot riot-server token --listen 127.0.0.1:7823
```

输出形如 `http://127.0.0.1:7823/#token=…`，令牌只在第一次运行时生成，之后每次打印的都是同一个。浏览器打开后，在设置里填模型 API Key 就能用。令牌泄露了就加 `--rotate` 换一枚：旧链接马上不能再登录，已经打开的页面断线重连后也会失效。

**3. 从别的机器访问**

端口只听服务器本机，外面要经隧道或反向代理进来：

- **SSH 隧道**（最省事）：在自己电脑上运行 `ssh -N -L 7823:127.0.0.1:7823 user@服务器`，然后打开上面的登录地址。
- **反向代理**（nginx / Caddy / Tailscale Serve 等，带 HTTPS）：代理到 `127.0.0.1:7823`，并开启 WebSocket 转发。启动容器时加上 `-e RIOT_REMOTE_ALLOWED_ORIGINS=https://riot.example.com`，否则 WebSocket 握手会因为来源不匹配被拒。登录地址把 `http://127.0.0.1:7823` 换成你的域名。

**环境变量**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RIOT_LISTEN` | 容器内 `0.0.0.0:7823` | 监听地址，等同 `--listen` |
| `RIOT_REMOTE_ALLOWED_ORIGINS` | 空 | 反向代理的外部地址，多个用逗号分隔 |
| `RIOT_LOG` | `info` | 日志级别，如 `debug`、`riot=debug`。用 `docker logs riot` 查看 |
| `RIOT_WEB_DIR` | 镜像自带 | 网页前端目录，等同 `--web-dir`，自己改前端时才用 |

**升级**

```bash
docker pull ghcr.io/riot-org/riot-server:latest
docker rm -f riot
```

然后用第 1 步的命令重新启动。数据在 `riot-home` 卷里，登录链接不变。

镜像里只有基本命令行工具。agent 要用 node、python、编译器这类运行时，就基于这个镜像再写一层 `FROM` 装上。自己构建镜像、不用 Docker 的 systemd 部署，以及原理说明，见 [REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md#9-无界面宿主riot-server)。

## 命令行（`riot exec`）

不开界面跑一个任务，跑完退出。和桌面版同一个内核、同一份模型配置。

- 桌面版：在「设置 → 通用 → 运行环境」里点「安装」命令行工具，之后终端里就能用 `riot exec`。它是一个很小的控制台程序，转给桌面主程序执行 —— 终端会等它跑完，退出码、管道、Ctrl-C 都和普通命令一样（Windows 上也是）。
- 服务器 / Docker：`riot-server exec`，参数完全相同。

```bash
riot exec "修复 issue #42 并跑测试"
git diff | riot exec --mode plan "审查这个改动，只指出 bug"
riot exec --json "..." > events.jsonl
```

- 默认 `auto` 模式：明显安全的操作自动放行，其余需要人确认的一律拒绝并告诉模型"无人值守"，退出前在 stderr 列出被拒的操作。要全部放开用 `--mode bypass`。
- 项目自带的 hooks / 技能 / 命令默认不加载（没被信任），加 `--trust` 只对这一次运行信任它。
- stdout 只有最终回答（`--json` 时是一行一个事件），过程写 stderr。
- 退出码：0 完成，1 出错，2 参数错误，3 停下来等人，124 超时，130 被中断。
- 会话存在配置目录下的 `exec-sessions/`，和桌面版的会话分开。

**在 CI 里用**：CI 机器上没有配置好的应用，用参数临时定义服务方。不写盘，key 从环境变量读：

```bash
riot-server exec --protocol anthropic --model claude-sonnet-5-5 \
  --api-key-env ANTHROPIC_API_KEY --trust --mode bypass "修复失败的测试"
```

`--protocol` 是 `anthropic` 或 `openai`（OpenAI 兼容的服务，如 DeepSeek，再加 `--base-url https://api.deepseek.com`）。GitHub Actions 里可以直接用 `ghcr.io/riot-org/riot-server` 镜像跑这条命令。

## 开发

需要 Rust 1.88+、Node.js 22、pnpm 10。

```bash
git clone https://github.com/riot-org/Riot.git
cd Riot
pnpm install
pnpm tauri dev
```

测试、打包和发版见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)，架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

效果评测：`python3 evals/run.py` 用 `riot exec` 跑 `evals/tasks/` 下的任务，按隐藏的验收测试判对错，输出通过率、耗时和 token 用量（`-- --model xxx` 换模型对比）。见 [evals/run.py](evals/run.py)。

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)：源码公开，个人与非营利用途免费，商业使用需另行授权。它不是 OSI 定义的开源许可证。
