#!/usr/bin/env python3
"""riot-eval：用 `riot exec` 跑一批真实任务，按隐藏测试判对错，出分数表。

每个任务是 `evals/tasks/<名字>/` 下的一个目录：

    task.json     {"prompt": "...", "check": "python3 -m unittest -q", "timeout": 300}
    repo/         任务开始时的项目（复制进临时目录、git init 后交给 agent）
    check/        隐藏的验收测试。agent 看不到 —— 跑完才复制进去执行，
                  免得它改测试来"通过"。

用法：

    python3 evals/run.py                              # 全部任务，当前配置的模型
    python3 evals/run.py --runs 3 --tasks 'off-*'     # 每个任务 3 次，只跑 off-*
    python3 evals/run.py -- --model deepseek-v4-pro   # `--` 之后原样交给 riot exec
    python3 evals/run.py --riot ./target/release/riot-server

输出：终端里一张表；完整记录写进 evals/results/<时间>/（results.jsonl +
summary.md），方便和上一次比。只用标准库。
"""

import argparse
import fnmatch
import json
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent


def load_tasks(pattern: str):
    tasks = []
    for d in sorted((ROOT / "tasks").iterdir()):
        if not d.is_dir() or not fnmatch.fnmatch(d.name, pattern):
            continue
        spec = json.loads((d / "task.json").read_text(encoding="utf-8"))
        spec["name"] = d.name
        spec["dir"] = d
        tasks.append(spec)
    return tasks


def git(cwd: Path, *args: str):
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        env={
            "GIT_AUTHOR_NAME": "riot-eval",
            "GIT_AUTHOR_EMAIL": "eval@localhost",
            "GIT_COMMITTER_NAME": "riot-eval",
            "GIT_COMMITTER_EMAIL": "eval@localhost",
            "PATH": __import__("os").environ.get("PATH", ""),
            "HOME": __import__("os").environ.get("HOME", ""),
        },
    )


def summarize_events(stdout: str):
    """从 --json 事件流里数轮数、工具调用和 token。"""
    stats = {"turns": 0, "tool_calls": 0, "input_tokens": 0, "output_tokens": 0,
             "cache_read_tokens": 0, "tools": {}, "final": "", "done": None}
    for line in stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get("type")
        if t == "request_start":
            stats["turns"] += 1
        elif t == "message" and ev.get("role") == "assistant":
            usage = ev.get("usage") or {}
            for k in ("input_tokens", "output_tokens", "cache_read_tokens"):
                stats[k] += int(usage.get(k) or 0)
            texts = []
            for c in ev.get("content", []):
                if c.get("type") == "tool_use":
                    stats["tool_calls"] += 1
                    name = c.get("name", "?")
                    stats["tools"][name] = stats["tools"].get(name, 0) + 1
                elif c.get("type") == "text":
                    texts.append(c.get("text", ""))
            if texts:
                stats["final"] = "\n".join(texts)
        elif t == "done":
            stats["done"] = ev.get("reason")
    return stats


def run_task(task, riot: str, extra: list, keep: bool):
    work = Path(tempfile.mkdtemp(prefix=f"riot-eval-{task['name']}-"))
    try:
        shutil.copytree(task["dir"] / "repo", work, dirs_exist_ok=True)
        git(work, "init", "-q")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "task start")

        timeout = int(task.get("timeout", 300))
        cmd = [riot, "exec", "--json", "--mode", "bypass", "--trust", "-C", str(work),
               "--timeout", str(timeout), *extra, task["prompt"]]
        started = time.monotonic()
        proc = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                              timeout=timeout + 60)
        elapsed = time.monotonic() - started
        stats = summarize_events(proc.stdout)

        # 验收：把隐藏测试放进去再跑。
        check_dir = task["dir"] / "check"
        if check_dir.is_dir():
            shutil.copytree(check_dir, work, dirs_exist_ok=True)
        check = subprocess.run(task.get("check", "python3 -m unittest -q"), shell=True, cwd=work,
                               capture_output=True, text=True, timeout=120)
        changed = subprocess.run(["git", "diff", "--stat", "HEAD"], cwd=work,
                                 capture_output=True, text=True).stdout.strip().splitlines()
        return {
            "task": task["name"],
            "passed": check.returncode == 0,
            "exit_code": proc.returncode,
            "seconds": round(elapsed, 1),
            **{k: stats[k] for k in ("turns", "tool_calls", "input_tokens", "output_tokens",
                                     "cache_read_tokens", "tools", "done")},
            "files_changed": changed[-1] if changed else "",
            "check_output": (check.stdout + check.stderr)[-2000:],
            "stderr_tail": proc.stderr[-1500:],
            "final": stats["final"][-1500:],
            "workdir": str(work) if keep else None,
        }
    finally:
        if not keep:
            shutil.rmtree(work, ignore_errors=True)


def fmt_tokens(n: int) -> str:
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--riot", default=str(REPO_ROOT / "target" / "debug" / "riot-server"),
                    help="riot-server 或 Riot 主程序的路径")
    ap.add_argument("--tasks", default="*", help="任务名的通配符")
    ap.add_argument("--runs", type=int, default=1, help="每个任务跑几次（看稳定性）")
    ap.add_argument("--keep", action="store_true", help="保留临时工作目录，方便排查")
    ap.add_argument("--fail-under", type=float, default=None,
                    help="通过率低于这个百分比时退出码为 1（给 CI 用）")
    ap.add_argument("extra", nargs="*", help="`--` 之后的参数原样交给 riot exec")
    args = ap.parse_args()

    tasks = load_tasks(args.tasks)
    if not tasks:
        print("没有匹配的任务", file=sys.stderr)
        return 2
    if not Path(args.riot).exists():
        print(f"找不到 {args.riot}，先 cargo build -p riot-kernel -p riot-host --bin riot-server",
              file=sys.stderr)
        return 2

    out_dir = ROOT / "results" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True)
    results = []
    with open(out_dir / "results.jsonl", "w", encoding="utf-8") as f:
        for task in tasks:
            for i in range(args.runs):
                label = task["name"] + (f" #{i + 1}" if args.runs > 1 else "")
                print(f"▸ {label} …", end="", flush=True)
                try:
                    r = run_task(task, args.riot, args.extra, args.keep)
                except subprocess.TimeoutExpired:
                    r = {"task": task["name"], "passed": False, "exit_code": 124, "seconds": None,
                         "turns": 0, "tool_calls": 0, "input_tokens": 0, "output_tokens": 0,
                         "cache_read_tokens": 0, "tools": {}, "done": "harness timeout"}
                r["run"] = i + 1
                results.append(r)
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
                f.flush()
                print(f" {'✓' if r['passed'] else '✗'} {r['seconds']}s, {r['tool_calls']} tool calls")

    passed = sum(1 for r in results if r["passed"])
    rate = 100.0 * passed / len(results)
    lines = [
        f"# riot-eval {out_dir.name}",
        "",
        f"- riot: `{args.riot}`",
        f"- exec args: `{' '.join(args.extra) or '(app default model)'}`",
        f"- **pass rate: {passed}/{len(results)} = {rate:.0f}%**",
        "",
        "| task | run | pass | seconds | turns | tool calls | input | output | cache read |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        lines.append(
            f"| {r['task']} | {r['run']} | {'✓' if r['passed'] else '✗'} | {r['seconds']} | "
            f"{r['turns']} | {r['tool_calls']} | {fmt_tokens(r['input_tokens'])} | "
            f"{fmt_tokens(r['output_tokens'])} | {fmt_tokens(r['cache_read_tokens'])} |"
        )
    tot_in = sum(r["input_tokens"] for r in results)
    tot_out = sum(r["output_tokens"] for r in results)
    secs = [r["seconds"] for r in results if r["seconds"] is not None]
    lines += ["", f"Totals: input {fmt_tokens(tot_in)}, output {fmt_tokens(tot_out)}, "
                  f"median {sorted(secs)[len(secs) // 2] if secs else '-'}s per task."]
    summary = "\n".join(lines) + "\n"
    (out_dir / "summary.md").write_text(summary, encoding="utf-8")
    print()
    print(summary)
    print(f"完整记录：{out_dir}")
    if args.fail_under is not None and rate < args.fail_under:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
