"""工具描述消融：真实请求（R2 形状）下，是工具描述的写法、工具种类还是数量把修 bug 拉出简写模式。

用法：python3 -I tool_ablation.py riot_wire.json [n]
riot_wire.json 的导出方法见 wire_regress.py。
"""

import collections
import concurrent.futures as cf
import copy
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e1
import prompts as P
from ds import chat_retry

w = json.load(open(sys.argv[1]))
N = int(sys.argv[2]) if len(sys.argv) > 2 else 16
sysmsg, user = w["messages"]
REAL = w["tools"]
CORE = {"Read", "Write", "Edit", "Bash", "Glob"}
PRODUCT = {"TodoWrite", "CreatePlan", "SwitchMode", "AskUserQuestion", "Task", "Schedule"}


def first_sentence(text):
    text = text.strip().split("\n")[0]
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    return (m.group(1) if m else text)[:200]


def strip_param_desc(schema):
    s = copy.deepcopy(schema)

    def walk(v):
        if isinstance(v, dict):
            v.pop("description", None)
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(s)
    return s


def oneline(tools, params_too):
    out = copy.deepcopy(tools)
    for t in out:
        f = t["function"]
        f["description"] = first_sentence(f["description"])
        if params_too:
            f["parameters"] = strip_param_desc(f["parameters"])
    return out


VARIANTS = {
    "real23": REAL,
    "minimal5": P.TOOLS,
    "real23_desc_oneline": oneline(REAL, params_too=False),
    "real23_desc_and_params_oneline": oneline(REAL, params_too=True),
    "core5_long_desc": [t for t in REAL if t["function"]["name"] in CORE],
    "real17_no_product": [t for t in REAL if t["function"]["name"] not in PRODUCT],
    "core5_desc_and_params_oneline": oneline([t for t in REAL if t["function"]["name"] in CORE], params_too=True),
}

TASKS = {"bug": e1.TASKS["bug"], "algo": e1.TASKS["algo"]}


def size(tools):
    return sum(len(json.dumps(t["function"], ensure_ascii=False)) for t in tools)


def one(job):
    v, t, i = job
    u = dict(user, content=user["content"].replace("第一问", TASKS[t]))
    r = chat_retry([sysmsg, u], tools=VARIANTS[v], stop_at_first_action=True, reason_cap=3000, max_tokens=16000)
    return v, t, P.style(r["reasoning"]), len(r["reasoning"])


def main():
    only = os.environ.get("ONLY")
    vs = only.split(",") if only else list(VARIANTS)
    jobs = [(v, "bug", i) for v in vs for i in range(N)]
    # 写算法只做抽查：确认精简描述不会把本来就好的任务带坏
    if not only:
        jobs += [(v, "algo", i) for v in ("real23", "real23_desc_and_params_oneline") for i in range(8)]
    c = collections.Counter()
    chars = collections.defaultdict(list)
    with cf.ThreadPoolExecutor(16) as ex:
        for v, t, s, n in ex.map(one, jobs):
            c[(v, t, s)] += 1
            chars[(v, t)].append(n)
    for t in TASKS:
        print(f"\n== {t}")
        for v in VARIANTS:
            k = sum(c[(v, t, s)] for s in "ABCDZ")
            if not k:
                continue
            ch = sorted(chars[(v, t)])
            print(f"  {v:32} 工具{len(VARIANTS[v]):2}个 {size(VARIANTS[v]):6}字符  "
                  + " ".join(f"{s}{c[(v, t, s)]}" for s in "ABCD") + f"  /{k}  推理字数中位数 {ch[len(ch) // 2]}")


if __name__ == "__main__":
    main()
