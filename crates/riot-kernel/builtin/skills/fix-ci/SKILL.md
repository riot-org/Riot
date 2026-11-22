---
name: fix-ci
description: GitHub 上 PR 或分支的 CI 失败、要找出原因并修好时用。用 gh 读失败作业的日志、在本地复现、修根因、推送后确认重新跑的结果。
---

# 修 CI

依赖 GitHub CLI（`gh`，已登录）。

## 1. 找到失败的那次运行

```bash
gh pr checks                      # 当前分支有 PR 时：各检查的状态
gh run list --branch "$(git branch --show-current)" --limit 5
```

用户给了 PR 号或运行链接就用那个。取最近一次**失败**的运行 id。

## 2. 读失败日志，不要猜

```bash
gh run view <run-id>              # 哪个作业、哪一步失败
gh run view <run-id> --log-failed # 只看失败步骤的日志
```

日志很长时用 Grep 在落盘的输出里找 `error`、`FAILED`、`panicked`、
`Error:`、退出码。**找到第一条真正的错误** —— 后面的大多是连锁反应。

分清三类，处理方式不同：

- **代码真的错了**（编译错误、测试断言失败、lint）：修代码。
- **环境 / 偶发**（网络超时、下载依赖失败、runner 磁盘满、和改动无关的
  不稳定测试）：不要改代码去"修"它。告诉用户，问要不要
  `gh run rerun <run-id> --failed`。
- **CI 配置本身的问题**（workflow 写错、缺 secret）：说明原因，改 workflow
  前先问用户；缺 secret 只能用户自己去仓库设置里加。

## 3. 本地复现再修

从 workflow 文件里找到那一步实际跑的命令（`.github/workflows/*.yml`），
在本地跑同一条（同样的参数、同样的 feature 开关）。能复现再改；复现不了
要说明，并指出 CI 和本地的差异（系统、工具链版本、环境变量）。

修**根因**。不要做下面这些，除非用户明确同意并说明了理由：

- 跳过、删除或放宽失败的测试来让 CI 变绿；
- 加 `continue-on-error`、`|| true`、`#[ignore]`、`skip`；
- 降低 lint 等级。

修完在本地把同一条命令再跑一遍，确认过了。

## 4. 推送并确认

按 commit 技能提交（消息写清 CI 为什么挂、怎么修的），然后 `git push`。

CI 可能要跑很久。不要反复轮询：告诉用户已推送、新的运行在哪
（`gh run list --limit 1`），需要的话稍后再用 `gh pr checks` 看结果。

## 不要做的事

- 不要 `--force` 推送，除非用户要求。
- 不要动和这次失败无关的代码，"顺便"修别的。
