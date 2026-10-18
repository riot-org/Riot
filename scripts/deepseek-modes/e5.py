"""E5 工具说明后置：T0（原样）/ T1（说明进 reminder）/ T2（只剩一句话），真实工具定义 + 完整轨迹。

用法：python3 -I e5.py riot_wire.json [reps]
结果追加到 results/e5.jsonl，可断点续跑。
"""

import collections
import concurrent.futures as cf
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
import agent_real
import t_repo
from agent import Workspace

CONFIGS = ["T0", "T1", "T2"]
OUT = os.path.join(HERE, "results", "e5.jsonl")
WORK = os.environ.get("E5_WORKDIR") or tempfile.mkdtemp(prefix="e5-")
LOCK = threading.Lock()

REPO_IDS = ["b03_lru", "b05_tokenizer", "b09_dijkstra", "b11_inventory", "b13_schedule", "b15_paginate",
            "e03_coupon", "e09_quoted"]

EXTRA = [
    {"id": "s1_server", "prompt": "Start the dev server for this project (`python3 serve.py`) and tell me which URL it is listening on. Leave it running.",
     "files": {
         "serve.py": "import time, sys\nprint('Loading config...', flush=True)\ntime.sleep(1)\nprint('Listening on http://127.0.0.1:8765', flush=True)\nwhile True:\n    time.sleep(1)\n",
         "app.py": "def handler(path):\n    return 'ok'\n"}},
    {"id": "s2_delete", "prompt": "legacy_utils.py is no longer used anywhere. Remove it and make sure the tests still pass.",
     "files": {
         "legacy_utils.py": "def old_slug(s):\n    return s.lower().replace(' ', '_')\n",
         "utils.py": "def slug(s):\n    return '-'.join(s.lower().split())\n",
         "main.py": "from utils import slug\n\nprint(slug('Hello World'))\n",
         "tests/__init__.py": "",
         "tests/test_utils.py": "import unittest\nfrom utils import slug\n\nclass T(unittest.TestCase):\n    def test(self):\n        self.assertEqual(slug('A b'), 'a-b')\n"}},
    {"id": "s3_search", "prompt": "Where is the retry delay computed in this project? Give me the file and the line number.",
     "files": {
         "net/__init__.py": "",
         "net/client.py": "from net.backoff import next_delay\n\n\ndef fetch(url, attempts=3):\n    for i in range(attempts):\n        try:\n            return _get(url)\n        except IOError:\n            wait(next_delay(i))\n\n\ndef _get(url):\n    raise IOError(url)\n\n\ndef wait(s):\n    pass\n",
         "net/backoff.py": "import random\n\nBASE = 0.5\nCAP = 30.0\n\n\ndef jitter(x):\n    return x * random.uniform(0.8, 1.2)\n\n\ndef next_delay(attempt):\n    raw = min(CAP, BASE * 2 ** attempt)\n    return jitter(raw)\n",
         "config.py": "TIMEOUT = 10\nRETRIES = 3\n",
         "README.txt": "Small HTTP helper.\n"},
     "answer_file": "backoff.py", "answer_lines": (11, 12, 13)},
    {"id": "s4_rename", "prompt": "Rename the function `calc_total` to `compute_total` everywhere in this project.",
     "files": {
         "billing/__init__.py": "",
         "billing/core.py": "def calc_total(items):\n    return sum(p * q for p, q in items)\n",
         "billing/report.py": "from billing.core import calc_total\n\n\ndef summary(items):\n    return f'total={calc_total(items)}'\n",
         "cli.py": "from billing.core import calc_total\n\nif __name__ == '__main__':\n    print(calc_total([(2, 3)]))\n",
         "tests/__init__.py": "",
         "tests/test_core.py": "import unittest\nfrom billing.core import calc_total\n\nclass T(unittest.TestCase):\n    def test(self):\n        self.assertEqual(calc_total([(2, 3), (1, 1)]), 7)\n"},
     "hidden": {"tests/test_hidden_rename.py": "import unittest\nfrom billing.core import compute_total\nfrom billing.report import summary\nimport cli\n\nclass H(unittest.TestCase):\n    def test(self):\n        self.assertEqual(compute_total([(2, 3)]), 6)\n        self.assertEqual(summary([(1, 2)]), 'total=2')\n"}},
]


def runner(ws):
    def run(cmd):
        out = Workspace.run(ws, "Bash", {"command": cmd})
        return out, 1 if "[exit code" in out else 0
    return run


def grade_extra(t, root, traj):
    final = traj["final"] or ""
    if t["id"] == "s1_server":
        return {"pass": traj["background_used"] and "8765" in final}
    ws = Workspace(root)
    if t["id"] == "s2_delete":
        gone = not os.path.exists(os.path.join(root, "legacy_utils.py"))
        out = ws.run("Bash", {"command": "python3 -m unittest discover -s tests -t . 2>&1 | tail -3"})
        return {"pass": gone and out.rstrip().endswith("OK"), "gone": gone}
    if t["id"] == "s3_search":
        ok = t["answer_file"] in final and any(re.search(rf"\b{n}\b", final) for n in t["answer_lines"])
        return {"pass": ok}
    if t["id"] == "s4_rename":
        for p, c in t["hidden"].items():
            open(os.path.join(root, p), "w").write(c)
        left = []
        for d, _, fs in os.walk(root):
            if "/.tmp" in d:
                continue
            for f in fs:
                if f.endswith(".py") and "calc_total" in open(os.path.join(d, f)).read():
                    left.append(os.path.relpath(os.path.join(d, f), root))
        out = ws.run("Bash", {"command": "python3 -m unittest discover -s tests -t . 2>&1 | tail -3"})
        return {"pass": not left and out.rstrip().endswith("OK"), "left": left}
    raise ValueError(t["id"])


def jobs(reps):
    repo = {t["id"]: t for t in t_repo.load()}
    out = []
    for c in CONFIGS:
        for r in range(reps):
            for tid in REPO_IDS:
                out.append(("repo", tid, c, r, repo[tid]))
            for t in EXTRA:
                out.append(("extra", t["id"], c, r, t))
    return out


def run_one(job, wire):
    kind, tid, config, rep, t = job
    root = os.path.join(WORK, f"{tid}-{config}-{rep}")
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root)
    try:
        if kind == "repo":
            t_repo.setup(t, root)
        else:
            for p, c in t["files"].items():
                full = os.path.join(root, p)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                open(full, "w").write(c)
        traj = agent_real.run_task(config, wire, t["prompt"], root)
        g = t_repo.grade(t, root, runner(Workspace(root))) if kind == "repo" else grade_extra(t, root, traj)
        rec = {"kind": kind, "id": tid, "config": config, "rep": rep, "grade": g, "traj": traj}
    except Exception as e:
        rec = {"kind": kind, "id": tid, "config": config, "rep": rep, "error": repr(e), "tb": traceback.format_exc()[-1500:]}
    with LOCK, open(OUT, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def main():
    wire = json.load(open(sys.argv[1]))
    reps = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    done = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            r = json.loads(l)
            if "error" not in r:
                done.add((r["id"], r["config"], r["rep"]))
    todo = [j for j in jobs(reps) if (j[1], j[2], j[3]) not in done]
    print(f"待跑 {len(todo)}，工作目录 {WORK}", flush=True)
    with cf.ThreadPoolExecutor(int(os.environ.get("WORKERS", "24"))) as ex:
        for n, rec in enumerate(ex.map(lambda j: run_one(j, wire), todo), 1):
            tag = "ERR " + rec["error"][:80] if "error" in rec else ("ok" if rec["grade"].get("pass") else "fail")
            print(f"[{n}/{len(todo)}] {rec['id']} {rec['config']}#{rec['rep']} {tag}", flush=True)


if __name__ == "__main__":
    main()
