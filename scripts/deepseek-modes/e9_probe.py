"""E9：RL 原文描述 + 「先问」，工具名 `bash`（B4）对 `Bash`（B5）的单步对照，外加现状 T0。

用法：python3 -I e9_probe.py riot_wire.json [n]
"""
import collections, concurrent.futures as cf, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e1, prompts as P
from agent_real import RL_BASH_DESC, DESTRUCTIVE_LINE, _bash_tool, _swap_bash
from ds import chat_retry

w = json.load(open(sys.argv[1]))
N = int(sys.argv[2]) if len(sys.argv) > 2 else 24
sysmsg, user = w["messages"]
V = {
    "T0": w["tools"],
    "B4_bash": _swap_bash(w["tools"], _bash_tool("bash", RL_BASH_DESC + DESTRUCTIVE_LINE)),
    "B5_Bash": _swap_bash(w["tools"], _bash_tool("Bash", RL_BASH_DESC + DESTRUCTIVE_LINE)),
}
TASKS = {k: e1.TASKS[k] for k in ("bug", "algo")}

def one(j):
    v, t, i = j
    u = dict(user, content=user["content"].replace("第一问", TASKS[t]))
    r = chat_retry([sysmsg, u], tools=V[v], stop_at_first_action=True, reason_cap=4000, max_tokens=16000)
    return v, t, P.style(r["reasoning"])

c = collections.Counter()
with cf.ThreadPoolExecutor(16) as ex:
    for v, t, s in ex.map(one, [(v, t, i) for v in V for t in TASKS for i in range(N if t == "bug" else 8)]):
        c[(v, t, s)] += 1
for v in V:
    print(f"{v:10}", "  ".join(f"{t}: A{c[(v,t,'A')]} B{c[(v,t,'B')]} C{c[(v,t,'C')]}" for t in TASKS))
