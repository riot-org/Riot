"""用存下的开头文本重新分类并汇总 E1。"""
import collections, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prompts as P
rows = [json.loads(l) for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "e1.jsonl"))]
for r in rows:
    if "head" in r:
        r["style"] = P.style(r["head"])
tasks = ["math", "algo", "svg", "bug", "chat_zh", "tech_zh"]
systems = list(P.E1_SYSTEMS)
for tools in (True, False):
    print(f"\n== tools={tools}   每格：A 数 / C 数（n=8），A=简写，C=不思考")
    print(f"{'system':20}" + "".join(f"{t:>10}" for t in tasks) + f"{'A总':>6}")
    for s in systems:
        line, tot = f"{s:20}", 0
        for t in tasks:
            c = collections.Counter(r["style"] for r in rows if r["sys"] == s and r["task"] == t and r["tools"] == tools)
            tot += c["A"]
            line += f"{str(c['A']) + '/' + str(c['C']):>10}"
        print(line + f"{tot:>6}")
# 调工具前推理长度的中位数（只看 tools=True）
print("\n== tools=True 首个动作前推理字数中位数（上限 4000）")
print(f"{'system':20}" + "".join(f"{t:>10}" for t in tasks))
for s in systems:
    line = f"{s:20}"
    for t in tasks:
        ch = sorted(r.get("chars", 0) for r in rows if r["sys"] == s and r["task"] == t and r["tools"])
        line += f"{ch[len(ch) // 2]:>10}"
    print(line)
c = collections.Counter(r["style"] for r in rows)
print("\n总体", dict(c), "错误", sum(1 for r in rows if "error" in r))
