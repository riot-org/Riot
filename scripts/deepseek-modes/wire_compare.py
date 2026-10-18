"""两份真实请求（改之前 / 改之后）原样对比单步推理模式。

用法：python3 -I wire_compare.py before.json after.json [n_bug]
"""
import collections, concurrent.futures as cf, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e1, prompts as P
from ds import chat_retry

wires = {"before": json.load(open(sys.argv[1])), "after": json.load(open(sys.argv[2]))}
N = int(sys.argv[3]) if len(sys.argv) > 3 else 24
TASKS = {k: e1.TASKS[k] for k in ("bug", "algo", "svg")}

def one(j):
    name, t, i = j
    w = wires[name]
    sysmsg, user = w["messages"]
    u = dict(user, content=user["content"].replace("第一问", TASKS[t]))
    r = chat_retry([sysmsg, u], tools=w["tools"], stop_at_first_action=True, reason_cap=4000, max_tokens=16000)
    return name, t, P.style(r["reasoning"])

c = collections.Counter()
jobs = [(n, t, i) for n in wires for t in TASKS for i in range(N if t == "bug" else 8)]
with cf.ThreadPoolExecutor(16) as ex:
    for n, t, s in ex.map(one, jobs):
        c[(n, t, s)] += 1
for n in wires:
    print(f"{n:7}", "  ".join(f"{t}: A{c[(n,t,'A')]} B{c[(n,t,'B')]} C{c[(n,t,'C')]}" for t in TASKS))
