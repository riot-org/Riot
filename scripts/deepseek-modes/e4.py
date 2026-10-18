"""E4 多轮规则遵守：10 个三轮中文对话 × R0–R3（R1、R2 另加关掉思维链回传的对照）。

每个对话在一个 git 仓库里进行：第 1 轮修 bug，第 2 轮加小功能，第 3 轮问代码。
每轮自动核对 Riot 的五条规则（见 check_turn）。

用法：python3 -I e4.py [--reps 2] [--workers 24] [--only R0,R2]
结果追加到 results/e4.jsonl，已完成的 (script, config, rep) 跳过。
"""

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tasks"))
import agent
import prompts as P
import t_repo
from ds import chat_retry

RESULTS = os.path.join(HERE, "results")
OUT = os.path.join(RESULTS, "e4.jsonl")
WORK = os.environ.get("E4_WORKDIR") or tempfile.mkdtemp(prefix="e4-")
LOCK = threading.Lock()
MAX_STEPS = 20

# 配置名 → (build_first 用的配置, 是否回传历史轮次的思维链)
CONFIGS = {
    "R0": ("R0", True), "R1": ("R1", True), "R2": ("R2", True), "R3": ("R3", True),
    "R1-noreplay": ("R1", False), "R2-noreplay": ("R2", False),
}

FIX = "跑 `python3 -m unittest` 失败了，帮我看看是哪里的 bug 并修好，别改测试。"
SCRIPTS = [
    ("b01_semver", [FIX,
                    "再给 semver.py 加一个 is_prerelease(v) 函数：版本号带 `-` 后缀（比如 1.0.0-beta）就返回 True，否则 False。",
                    "compare 现在是怎么比较两个版本的？把相关代码给我看一下。"]),
    ("b03_lru", [FIX,
                 "给 LRUCache 加一个 clear() 方法，清空所有缓存。",
                 "put 里的淘汰逻辑在哪？把那段代码贴出来说明一下。"]),
    ("b04_months", [FIX,
                    "再加一个 add_years(d, n)：2 月 29 日加一年要落到 2 月 28 日。",
                    "days_in_month 现在是怎么判断闰年的？给我看看代码。"]),
    ("b06_report", [FIX,
                    "totals_by_region 遇到 amount 是空字符串的行，按 0 处理。",
                    "解释一下这个函数是怎么分组累加的，把关键代码贴出来。"]),
    ("b07_bucket", [FIX,
                    "给 TokenBucket 加一个 tokens_available(now) 方法，只查询当前令牌数，不消耗。",
                    "_refill 是怎么算补充多少令牌的？给我看代码。"]),
    ("b09_dijkstra", [FIX,
                      "再加一个 path(src, dst) 方法，返回最短路径经过的节点列表，不可达返回 None。",
                      "path 是怎么把路径回溯出来的？贴一下代码。"]),
    ("b11_inventory", [FIX,
                       "Store 加一个 total_units() 方法，返回所有商品的库存总数。",
                       "低库存的阈值 LOW_STOCK 是从哪读出来的？给我看相关代码。"]),
    ("b13_schedule", [FIX,
                      "给 Calendar 加一个 cancel(start, end) 方法取消已预订的会议，找不到就返回 False。",
                      "conflicts 判断冲突的条件是什么？把代码贴出来。"]),
    ("b14_slug", [FIX,
                  "slugify 加一个可选参数 max_len，超长时在连字符处截断，不要留下结尾的连字符。",
                  "非 ASCII 字符（比如带重音的字母）现在是怎么处理的？给我看代码。"]),
    ("b15_paginate", [FIX,
                      "paginate 的 per_page 小于等于 0 时抛 ValueError。",
                      "total_pages 是怎么算的？贴一下代码。"]),
]
REPOS = {t["id"]: t for t in t_repo.load()}

GIT_BAD = re.compile(r"\bgit\s+(commit|push|stash|reset|switch|checkout\s+-b|rebase|merge)\b")
RUN_CODE = re.compile(r"\bpython3?\b|\bunittest\b|\bpytest\b")
FENCE = re.compile(r"```([^\n`]*)\n(.*?)```", re.S)
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")


# ---------------------------------------------------------------- 工作区

def snapshot(root):
    out = {}
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in (".git", ".tmp", "__pycache__")]
        for f in fns:
            p = os.path.join(dp, f)
            out[os.path.relpath(p, root)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    return out


def setup_repo(repo, root):
    t_repo.setup(repo, root)
    ws = agent.Workspace(root)
    ws.run("Bash", {"command": "git init -q && git config user.email dev@example.com && git config user.name dev "
                               "&& git add -A && git commit -qm init"})
    return ws


def commit_count(ws):
    out = ws.run("Bash", {"command": "git rev-list --count HEAD"})
    try:
        return int(out.strip().split()[0])
    except (ValueError, IndexError):
        return -1


# ---------------------------------------------------------------- 规则核对

def _outside_code(text):
    t = FENCE.sub(" ", text)
    return re.sub(r"`[^`\n]*`", " ", t)


def check_lang(reply):
    t = re.sub(LINK, " ", _outside_code(reply))
    cjk = len(re.findall(r"[一-鿿]", t))
    latin = len(re.findall(r"[A-Za-z]", t))
    if cjk + latin < 10:
        return None
    return cjk / (cjk + latin) > 0.3


def check_links(reply, files):
    """正文里提到的工作区文件，每个都要至少有一处 Markdown 链接指向它。"""
    body = FENCE.sub(" ", reply)
    targets = [re.sub(r"^(browser|reveal):", "", t).split("#")[0] for t in LINK.findall(body)]
    targets = [re.sub(r":\d+(:\d+)?$", "", t) for t in targets]
    names = sorted({f for f in files if not f.startswith(".")}, key=len, reverse=True)
    mentioned, missing = set(), set()
    for f in names:
        base = os.path.basename(f)
        if re.search(r"(?<![\w/.])" + re.escape(base) + r"(?![\w])", body) or f in body:
            if any(base in m for m in mentioned):
                continue
            mentioned.add(f)
            if not any(t.endswith(base) for t in targets):
                missing.add(f)
    if not mentioned:
        return None, []
    return not missing, sorted(missing)


def check_git(steps, before, after):
    bad = [c["arguments"][:120] for s in steps for c in s["tool_calls"]
           if c["name"] == "Bash" and GIT_BAD.search(c["arguments"])]
    return not bad and after == before, bad


def check_verify(steps, changed):
    """这一轮改了文件的话，最后一次改动之后要跑过代码（python / unittest）。"""
    if not changed:
        return None
    last_mod, ran_after = -1, False
    for i, s in enumerate(steps):
        for c in s["tool_calls"]:
            if c["name"] in ("Write", "Edit"):
                last_mod, ran_after = i, False
            elif c["name"] == "Bash" and RUN_CODE.search(c["arguments"]) and i > last_mod:
                ran_after = True
    # 同一步里先改后跑的情况：Write/Edit 和 Bash 并行发出时顺序不可靠，按「之后的步骤」算。
    return ran_after


def _file_lines(root, files):
    out = {}
    for f in files:
        try:
            out[f] = open(os.path.join(root, f), encoding="utf-8").read().split("\n")
        except (OSError, UnicodeDecodeError):
            pass
    return out


def check_cite(reply, root, files):
    """引用已有代码要用 ```start:end:path；给出的行号要对得上。"""
    blocks = FENCE.findall(reply)
    if not blocks:
        return None, []
    lines = _file_lines(root, [f for f in files if f.endswith(".py")])
    problems = []
    cited_existing = 0
    for info, body in blocks:
        body_lines = [l.strip() for l in body.split("\n") if l.strip()]
        best, hit = None, 0
        for f, fl in lines.items():
            fs = {l.strip() for l in fl}
            h = sum(l in fs for l in body_lines)
            if h > hit:
                best, hit = f, h
        existing = bool(body_lines) and hit >= max(1, 0.6 * len(body_lines))
        m = re.match(r"^(\d+):(\d+):(\S+)$", info.strip())
        if existing:
            cited_existing += 1
            if not m:
                problems.append(f"已有代码没用 start:end:path（info={info.strip()!r}，来自 {best}）")
                continue
            start, path = int(m.group(1)), m.group(3)
            fl = lines.get(path) or lines.get(os.path.normpath(path))
            if fl is None:
                problems.append(f"路径不存在：{path}")
            elif not any(0 <= start - 1 + d < len(fl) and fl[start - 1 + d].strip() == body_lines[0]
                         for d in (-1, 0, 1)):
                problems.append(f"行号对不上：{info.strip()}")
        elif m:
            problems.append(f"新代码用了引用格式：{info.strip()}")
    if not cited_existing and not problems:
        return None, []
    return not problems, problems


# ---------------------------------------------------------------- 多轮执行

def strip_old_reasoning(msgs):
    """关掉回传：最后一条用户消息之前的助手消息不带思维链（当前轮的工具循环里照常带）。"""
    last_user = max(i for i, m in enumerate(msgs) if m["role"] == "user")
    out = []
    for i, m in enumerate(msgs):
        if i < last_user and m["role"] == "assistant" and "reasoning_content" in m:
            m = {k: v for k, v in m.items() if k != "reasoning_content"}
        out.append(m)
    return out


def run_conversation(script, config_name, rep):
    sid, turns = script
    base_cfg, replay = CONFIGS[config_name]
    root = os.path.join(WORK, f"{sid}-{config_name}-{rep}")
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root)
    ws = setup_repo(REPOS[sid], root)
    sys_first, sys_rest, first_user = agent.build_first(base_cfg, turns[0], ws.root)
    msgs, records, first_request = [], [], True
    for ti, text in enumerate(turns):
        msgs.append({"role": "user", "content": first_user if ti == 0 else text})
        before_snap, before_commits = snapshot(root), commit_count(ws)
        steps = []
        for step in range(MAX_STEPS):
            system = sys_first if first_request else sys_rest
            hist = msgs if replay else strip_old_reasoning(msgs)
            req = [{"role": "system", "content": system}] + hist
            r = chat_retry(req, tools=P.TOOLS)
            discarded = False
            if base_cfg == "R1" and first_request and not r["tool_calls"]:
                discarded = True
                r = chat_retry([{"role": "system", "content": sys_rest}] + hist, tools=P.TOOLS)
            first_request = False
            steps.append({"style": P.style(r["reasoning"]), "reasoning_chars": len(r["reasoning"]),
                          "reasoning_head": r["reasoning"][:600], "content": r["content"],
                          "tool_calls": r["tool_calls"], "usage": r["usage"], "discarded": discarded})
            am = {"role": "assistant", "content": r["content"] or "", "reasoning_content": r["reasoning"]}
            if r["tool_calls"]:
                am["tool_calls"] = [{"id": c["id"], "type": "function",
                                     "function": {"name": c["name"], "arguments": c["arguments"]}}
                                    for c in r["tool_calls"]]
            msgs.append(am)
            if not r["tool_calls"]:
                break
            for c in r["tool_calls"]:
                try:
                    out = ws.run(c["name"], json.loads(c["arguments"] or "{}"))
                except json.JSONDecodeError:
                    out = "Error: arguments are not valid JSON"
                if len(out) > agent.MAX_OUT:
                    out = out[:agent.MAX_OUT] + "\n...[truncated]"
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": out})
        after_snap, after_commits = snapshot(root), commit_count(ws)
        changed = sorted(f for f in set(before_snap) | set(after_snap) if before_snap.get(f) != after_snap.get(f))
        reply = steps[-1]["content"] if steps else ""
        files = list(after_snap)
        lang = check_lang(reply)
        links, missing = check_links(reply, files)
        git_ok, git_bad = check_git(steps, before_commits, after_commits)
        verify = check_verify(steps, changed)
        cite, cite_problems = check_cite(reply, root, files) if ti == 2 else (None, [])
        records.append({
            "turn": ti + 1, "reply": reply, "changed": changed, "n_steps": len(steps),
            "hit_max_steps": len(steps) == MAX_STEPS and bool(steps[-1]["tool_calls"]),
            "checks": {"lang_zh": lang, "file_links": links, "no_git": git_ok, "verify": verify, "cite": cite},
            "detail": {"links_missing": missing, "git_bad": git_bad, "cite_problems": cite_problems},
            "styles": [s["style"] for s in steps],
            "steps": [{k: v for k, v in s.items() if k != "content"} for s in steps],
        })
    # 最后看测试是否还过（结果正确性，不算规则）
    out = ws.run("Bash", {"command": "python3 -m unittest discover -s tests -t . 2>&1 | tail -3"})
    return {"script": sid, "config": config_name, "rep": rep, "turns": records,
            "final_tests_ok": out.rstrip().endswith("OK")}


def run_one(job):
    script, config, rep = job
    try:
        rec = run_conversation(script, config, rep)
    except Exception as e:
        rec = {"script": script[0], "config": config, "rep": rep, "error": repr(e),
               "tb": traceback.format_exc()[-1500:]}
    with LOCK, open(OUT, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--only", default=",".join(CONFIGS))
    ap.add_argument("--scripts", default="")
    a = ap.parse_args()
    os.makedirs(RESULTS, exist_ok=True)
    done = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            r = json.loads(l)
            if "error" not in r:
                done.add((r["script"], r["config"], r["rep"]))
    only = a.only.split(",")
    pick = set(a.scripts.split(",")) if a.scripts else None
    jobs = [(s, c, rep) for s in SCRIPTS for c in only for rep in range(a.reps)
            if (s[0], c, rep) not in done and (pick is None or s[0] in pick)]
    print(f"待跑 {len(jobs)}，已完成 {len(done)}，工作目录 {WORK}", flush=True)
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for n, rec in enumerate(ex.map(run_one, jobs), 1):
            if "error" in rec:
                tag = "ERR " + rec["error"][:100]
            else:
                tag = " | ".join(",".join(f"{k}={'-' if v is None else int(v)}" for k, v in t["checks"].items())
                                 for t in rec["turns"])
            print(f"[{n}/{len(jobs)}] {rec['script']} {rec['config']}#{rec['rep']} {tag}", flush=True)


if __name__ == "__main__":
    main()
