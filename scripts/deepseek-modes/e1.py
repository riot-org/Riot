"""E1 模式地图：系统提示词 × 任务 × 有无工具，单步探针。

用法：python3 -I e1.py [n_per_cell]
"""

import collections
import concurrent.futures as cf
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prompts as P
from ds import chat_retry

TASKS = {
    "math": "How many ordered pairs of positive integers (a, b) with a, b <= 100 satisfy that a^2 + b^2 is divisible by 13?",
    "algo": "Write a Python function that returns the length of the longest substring with at most k distinct characters, and explain its complexity.",
    "svg": "Draw an SVG of a zebra riding a motorcycle by the seaside. Save it as zebra.svg.",
    "bug": "The tests in this repo are failing after my last change to parser.py. Please fix it.",
    "chat_zh": "我最近总是失眠，有什么建议？",
    "tech_zh": "Rust 里 Arc<Mutex<T>> 和 RwLock 应该怎么选？",
}
CAP = 4000


def one(job):
    sname, tname, tools, i = job
    system, suffix = P.E1_SYSTEMS[sname]
    user = TASKS[tname] + ("\n\n" + suffix if suffix else "")
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    try:
        r = chat_retry(msgs, tools=P.TOOLS if tools else None, stop_at_first_action=True, reason_cap=CAP,
                       max_tokens=16000)
    except Exception as e:
        return {"sys": sname, "task": tname, "tools": tools, "i": i, "error": str(e)}
    return {"sys": sname, "task": tname, "tools": tools, "i": i, "style": P.style(r["reasoning"]),
            "chars": len(r["reasoning"]), "first": r["first"], "head": r["reasoning"][:300],
            "pron": P.pronouns(r["reasoning"])}


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    jobs = [(s, t, tl, i) for s in P.E1_SYSTEMS for t in TASKS for tl in (True, False) for i in range(n)]
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "e1.jsonl")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    done = 0
    with open(out_path, "w") as f, cf.ThreadPoolExecutor(24) as ex:
        for res in ex.map(one, jobs):
            f.write(json.dumps(res, ensure_ascii=False) + "\n")
            f.flush()
            done += 1
            if done % 100 == 0:
                print(done, "/", len(jobs), flush=True)
    rows = [json.loads(l) for l in open(out_path)]
    cell = collections.defaultdict(list)
    for r in rows:
        cell[(r["sys"], r["task"], r["tools"])].append(r)
    print(f"{'system':20} {'task':8} tools  A  B  C  D  Z err  medChars")
    for (s, t, tl), rs in sorted(cell.items()):
        c = collections.Counter(r.get("style", "err") for r in rs)
        chars = sorted(r.get("chars", 0) for r in rs)
        print(f"{s:20} {t:8} {str(tl):5} " + " ".join(f"{c[k]:2}" for k in "ABCDZ") +
              f" {c['err']:3}  {chars[len(chars) // 2]}")


if __name__ == "__main__":
    main()
