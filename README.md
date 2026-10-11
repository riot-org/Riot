<div align="center">
  <img src="assets/riot-logo.png" width="96" alt="Riot" />

# Riot

**Codex 的开源替代。** Rust 内核，本地执行。

[下载](https://github.com/riot-org/Riot/releases/latest) ·
[功能](#功能) ·
[开发](#开发)

[![Release](https://img.shields.io/github/v/release/riot-org/Riot?display_name=tag)](https://github.com/riot-org/Riot/releases/latest)
[![License](https://img.shields.io/badge/license-PolyForm%20NC-4B8BBE)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#下载)
</div>

---

![Riot 工作空间](assets/README/workspace-preview.png)

## 功能

不只写代码。网页、文档、定时任务也能做。

- **远程连接**：用手机或另一台电脑的浏览器连上正在运行的 Riot，任务还在原来那台机器上跑。
- **多 Agent 协作**：检索、分析、实现分给后台子 Agent，主任务负责协调。
- **定时任务**：每天、工作日、每周或指定时间自动跑，错过的运行会补上。
- **文档能力**：直接生成和修改 Word、Excel、PPT、PDF，公式计算和排版渲染都在本机完成。
- **内置浏览器**：Agent 导航、点击、填表、截图，每一步都显示在浏览器面板上。
- **DOM 拾取**：点一下页面元素，选择器和结构就附进对话。
- **服务器部署**：部署到 Linux 服务器，电脑合上了任务照样跑。
- **安全渗透**：内置爬取、Fuzz、密钥泄露扫描，结果整理成带证据和修复建议的报告。

## 下载

| 系统                           | 安装包                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| macOS（Apple Silicon）         | [`Riot_*_aarch64.dmg`](https://github.com/riot-org/Riot/releases/latest)，拖进「应用程序」 |
| Windows 10 / 11（x64）         | [`Riot_*_x64-setup.exe`](https://github.com/riot-org/Riot/releases/latest)，运行安装程序   |
| Linux 服务器（x86_64 / arm64） | `docker pull ghcr.io/riot-org/riot-server:latest`，见[部署说明](docs/REMOTE_ACCESS.md)     |

装好后在设置里填上模型 API Key 就能用。

macOS 包未签名，首次打开被拦时用访达右键 → 打开，或：

```bash
xattr -dr com.apple.quarantine /Applications/Riot.app
```

## 开发

需要 Rust 1.88+、Node.js 22、pnpm 10。

```bash
git clone https://github.com/riot-org/Riot.git
cd Riot
pnpm install
pnpm tauri dev
```

测试、打包和发版见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)，架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)：个人与非营利用途免费，商业使用需另行授权。
