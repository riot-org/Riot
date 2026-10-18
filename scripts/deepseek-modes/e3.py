"""E3 能力对比：R0–R3 四个配置 × 数学 / 代码 / 仓库 / 设计。

用法：python3 -I e3.py [--only math,code,repo,design] [--workers 32]
结果追加写到 results/e3.jsonl，已经跑完的 (kind, id, config, rep) 会跳过，可断点续跑。
"""

import argparse
import concurrent.futures as cf
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tasks"))
import agent
import t_code
import t_math
import t_repo

CONFIGS = ["R0", "R1", "R2", "R3"]
RESULTS = os.path.join(HERE, "results")
OUT = os.path.join(RESULTS, "e3.jsonl")
WORK = os.environ.get("E3_WORKDIR") or tempfile.mkdtemp(prefix="e3-")
LOCK = threading.Lock()

DESIGN = [
    ("d01_zebra", "a zebra riding a motorcycle by the seaside"),
    ("d02_lighthouse", "a lighthouse on a cliff during a stormy night"),
    ("d03_clock", "a modern, elegant analog wall clock showing 10:10"),
    ("d04_cafe", "an isometric view of a small corner coffee shop"),
    ("d05_fox", "a fox reading a book under a tree in autumn"),
    ("d06_pelican", "a pelican riding a bicycle"),
    ("d07_skyline", "a city skyline at sunset reflected in a river"),
    ("d08_astrocat", "a cat astronaut floating in space near a planet"),
    ("d09_weather", "a weather app card UI showing a 5-day forecast"),
    ("d10_robot", "a small robot watering plants in a greenhouse"),
]


def design_prompt(desc):
    return f"Draw an SVG of {desc}. Save it as image.svg in the working directory."


def math_prompt(q):
    return q + "\n\nPlease reason step by step, and put your final answer within \\boxed{}."


def _boxed(text):
    """最后一个 \\boxed{...} 的内容，支持嵌套花括号。"""
    i = text.rfind("\\boxed{")
    if i < 0:
        return None
    j, depth = i + len("\\boxed{"), 1
    k = j
    while k < len(text) and depth:
        depth += {"{": 1, "}": -1}.get(text[k], 0)
        k += 1
    return text[j:k - 1]


def extract_int(text):
    text = text or ""
    cand = _boxed(text)
    if cand is None:
        nums = re.findall(r"-?\d[\d,]*", text)
        cand = nums[-1] if nums else ""
    cand = re.sub(r"\{,\}|\\[,!;: ]|[,$\s]", "", cand)
    try:
        return int(re.findall(r"-?\d+", cand)[-1])
    except IndexError:
        return None


def math_failure(traj, got, answer):
    s = traj["steps"][-1]
    if got == answer:
        return None
    if s.get("finish") == "length":
        return "length"
    if "DSML" in (traj["final"] or "") or "<｜" in (traj["final"] or ""):
        return "fake_tool_call"
    return "wrong"


def slim(traj):
    """结果里只留推理开头和长度，完整推理太大。"""
    for s in traj["steps"]:
        s["reasoning_chars"] = len(s["reasoning"])
        s["reasoning"] = s["reasoning"][:1500]
        for c in s["tool_calls"]:
            c["arguments"] = c["arguments"][:3000]
    return traj


def sandbox_runner(ws):
    def run(cmd):
        out = ws.run("Bash", {"command": cmd})
        rc = 1 if "[exit code" in out else 0
        return out, rc
    return run


def job_math(p, config, rep):
    traj = agent.run_task(config, math_prompt(p["question"]), workdir=None)
    got = extract_int(traj["final"])
    return {"pass": got == p["answer"], "got": got, "answer": p["answer"],
            "failure": math_failure(traj, got, p["answer"])}, traj


def job_code(t, config, rep, root):
    traj = agent.run_task(config, t_code.prompt(t), workdir=root)
    ws = agent.Workspace(root)
    with open(os.path.join(root, "_check.py"), "w") as f:
        f.write(t_code.CHECKER)
    with open(os.path.join(root, "_cases.json"), "w") as f:
        json.dump(t["cases"], f)
    out = ws.run("Bash", {"command": f"python3 _check.py {t['func']} _cases.json"})
    try:
        r = json.loads([l for l in out.strip().split("\n") if l.startswith("{")][-1])
    except Exception:
        r = {"pass": 0, "total": len(t["cases"]), "error": out[-300:]}
    r["pass_all"] = r.get("pass") == r.get("total")
    return {"pass": r["pass_all"], "detail": r}, traj


def job_repo(t, config, rep, root):
    t_repo.setup(t, root)
    traj = agent.run_task(config, t["prompt"], workdir=root)
    ws = agent.Workspace(root)
    g = t_repo.grade(t, root, sandbox_runner(ws))
    return g, traj


def job_design(d, config, rep, root):
    traj = agent.run_task(config, design_prompt(d[1]), workdir=root)
    src = os.path.join(root, "image.svg")
    dst_dir = os.path.join(RESULTS, "design")
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, f"{d[0]}__{config}__{rep}.svg")
    ok = os.path.exists(src)
    if ok:
        shutil.copy(src, dst)
    return {"pass": ok, "svg": dst if ok else None, "bytes": os.path.getsize(src) if ok else 0}, traj


def jobs(only):
    out = []
    if "math" in only:
        for p in t_math.load():
            for c in CONFIGS:
                for rep in range(2):
                    out.append(("math", p["id"], c, rep, p))
    if "code" in only:
        for t in t_code.load():
            for c in CONFIGS:
                out.append(("code", t["id"], c, 0, t))
    if "repo" in only:
        for t in t_repo.load():
            for c in CONFIGS:
                for rep in range(2):
                    out.append(("repo", t["id"], c, rep, t))
    if "design" in only:
        for d in DESIGN:
            for c in CONFIGS:
                out.append(("design", d[0], c, 0, d))
    return out


def run_one(j):
    kind, tid, config, rep, payload = j
    root = os.path.join(WORK, f"{kind}-{tid}-{config}-{rep}")
    if kind != "math":
        shutil.rmtree(root, ignore_errors=True)
        os.makedirs(root)
    try:
        if kind == "math":
            g, traj = job_math(payload, config, rep)
        elif kind == "code":
            g, traj = job_code(payload, config, rep, root)
        elif kind == "repo":
            g, traj = job_repo(payload, config, rep, root)
        else:
            g, traj = job_design(payload, config, rep, root)
        rec = {"kind": kind, "id": tid, "config": config, "rep": rep, "grade": g, "traj": slim(traj)}
    except Exception as e:
        rec = {"kind": kind, "id": tid, "config": config, "rep": rep, "error": repr(e),
               "tb": traceback.format_exc()[-1500:]}
    with LOCK, open(OUT, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="math,code,repo,design")
    ap.add_argument("--workers", type=int, default=32)
    a = ap.parse_args()
    os.makedirs(RESULTS, exist_ok=True)
    done = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            r = json.loads(l)
            if "error" not in r:
                done.add((r["kind"], r["id"], r["config"], r["rep"]))
    todo = [j for j in jobs(a.only.split(",")) if j[:4] not in done]
    print(f"待跑 {len(todo)}，已完成 {len(done)}，工作目录 {WORK}", flush=True)
    n = 0
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for rec in ex.map(run_one, todo):
            n += 1
            tag = "ERR " + rec["error"][:80] if "error" in rec else ("ok" if rec["grade"].get("pass") else "fail")
            print(f"[{n}/{len(todo)}] {rec['kind']} {rec['id']} {rec['config']}#{rec['rep']} {tag}", flush=True)


if __name__ == "__main__":
    main()
