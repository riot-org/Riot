"""落地后的真实请求和 E9 探针差在哪：工具顺序、schema 里的 $schema / title。"""
import collections, concurrent.futures as cf, copy, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e1, prompts as P
from ds import chat_retry

w = json.load(open(sys.argv[1]))
N = int(sys.argv[2]) if len(sys.argv) > 2 else 24
sysmsg, user = w["messages"]

def bash_first(tools):
    return sorted(tools, key=lambda t: t["function"]["name"] != "Bash")

def slim_schema(tools):
    out = copy.deepcopy(tools)
    for t in out:
        if t["function"]["name"] == "Bash":
            p = t["function"]["parameters"]
            p.pop("$schema", None); p.pop("title", None)
    return out

V = {
    "after_asis": w["tools"],
    "bash_first": bash_first(w["tools"]),
    "slim_schema": slim_schema(w["tools"]),
    "both": bash_first(slim_schema(w["tools"])),
}

def one(j):
    v, i = j
    u = dict(user, content=user["content"].replace("第一问", e1.TASKS["bug"]))
    r = chat_retry([sysmsg, u], tools=V[v], stop_at_first_action=True, reason_cap=4000, max_tokens=16000)
    return v, P.style(r["reasoning"])

c = collections.Counter()
with cf.ThreadPoolExecutor(16) as ex:
    for v, s in ex.map(one, [(v, i) for v in V for i in range(N)]):
        c[(v, s)] += 1
for v in V:
    print(f"{v:12} bug: A{c[(v,'A')]} B{c[(v,'B')]} C{c[(v,'C')]}")
print("order:", [t["function"]["name"] for t in w["tools"]][:5])
