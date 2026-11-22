---
name: pr
description: 要把当前分支开成 GitHub Pull Request 时用。确认分支和提交、推送、用 gh 建 PR，标题和描述照仓库习惯写，建完把链接给用户。
---

# 开 Pull Request

依赖 GitHub CLI（`gh`）。先确认它在、并且登录了：

```bash
gh auth status
```

没装或没登录：停下来告诉用户（`brew install gh` / `gh auth login`），不要
自己去改用户的凭证。

## 1. 看清要提的是什么

并行跑：

```bash
git status --short
git branch --show-current
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
git log --oneline "origin/$BASE"..HEAD
git diff --stat "origin/$BASE"...HEAD
```

- 当前在默认分支上：**先建分支**（`git switch -c <主题短名>`），不要往默认
  分支直接推。
- 工作区还有没提交的改动：问用户要不要一起提（按 commit 技能的规矩分组），
  不要自作主张全部带上。
- 和基线之间没有提交：没什么可开的，告诉用户。
- 已经有这个分支的 PR（`gh pr view --json url,state` 能查到）：不重复开，
  推送新提交即可，把已有 PR 的链接给用户。

## 2. 推送

```bash
git push -u origin HEAD
```

被拒（远端有新提交）：`git pull --rebase` 后再推；有冲突就停下来报告，不要
`--force`，除非用户明确要求。

## 3. 标题和描述

先看这个仓库的习惯：

```bash
gh pr list --state merged --limit 5 --json title,body
ls .github/pull_request_template.md .github/PULL_REQUEST_TEMPLATE* 2>/dev/null
```

有 PR 模板就按模板填。没有的话：

- 标题：一句话说清改了什么，语言和格式跟已合并的 PR 一致。
- 描述：**为什么**改（问题是什么、症状是什么）、怎么改的（关键取舍）、
  怎么验证的（跑了哪些测试、手工验证了什么、**哪些没验证**）。关联
  issue 写 `Fixes #123`。

用 HEREDOC 传描述，保证换行不被吃掉：

```bash
gh pr create --base "$BASE" --title "标题" --body "$(cat <<'BODY'
## 为什么

## 改了什么

## 怎么验证的
BODY
)"
```

用户没说要草稿就开正式 PR；说了「先别让人审」就加 `--draft`。

## 4. 收尾

把 PR 链接给用户，并说一句 CI 是否已经开始跑（`gh pr checks`）。CI 红了
可以接着用 fix-ci 技能处理 —— 先问用户。

## 不要做的事

- 不要 `git push --force`、改写已推送的历史，除非用户明确要求。
- 不要替用户请求审阅人、加标签、开自动合并，除非用户要求。
- 不要在描述里写没做过的验证。
