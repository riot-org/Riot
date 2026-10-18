"""E4 汇总：按配置的规则遵守率、各轮推理模式。"""

import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(os.path.join(HERE, "results", "e4.jsonl"))]
ok = {}
for r in rows:
    if "error" not in r:
        ok[(r["script"], r["config"], r["rep"])] = r
errs = [r for r in rows if "error" in r and (r["script"], r["config"], r["rep"]) not in ok]
CONF = ["R0", "R1", "R2", "R3", "R1-noreplay", "R2-noreplay"]
RULES = ["lang_zh", "file_links", "no_git", "verify", "cite"]
NAMES = {"lang_zh": "中文回答", "file_links": "文件链接", "no_git": "不擅自 git", "verify": "改后验证", "cite": "引用格式(第3轮)"}

print(f"对话 {len(ok)}，未恢复的错误 {len(errs)}")
for e in errs[:5]:
    print("  ERR", e["script"], e["config"], e["error"][:120])


def rate(p, n):
    return f"{p}/{n} {100 * p / n:.0f}%" if n else "-"


print("\n== 规则遵守率（通过 / 适用的轮次）")
print(f"{'config':13}" + "".join(f"{NAMES[k]:>16}" for k in RULES) + f"{'合计':>14}{'测试仍过':>10}")
total = {}
for c in CONF:
    rs = [r for k, r in ok.items() if k[1] == c]
    line, P, N = f"{c:13}", 0, 0
    for rule in RULES:
        vals = [t["checks"][rule] for r in rs for t in r["turns"] if t["checks"][rule] is not None]
        p, n = sum(vals), len(vals)
        P += p
        N += n
        line += f"{rate(p, n):>16}"
    total[c] = P / N if N else 0
    line += f"{rate(P, N):>14}{rate(sum(r['final_tests_ok'] for r in rs), len(rs)):>10}"
    print(line)

print("\n== 合计遵守率相对 R0")
for c in CONF[1:]:
    print(f"  {c}: {100 * total[c] / total['R0']:.0f}% of R0")

print("\n== 按轮次的中文回答率")
for c in CONF:
    rs = [r for k, r in ok.items() if k[1] == c]
    by_turn = []
    for ti in range(3):
        vals = [r["turns"][ti]["checks"]["lang_zh"] for r in rs if r["turns"][ti]["checks"]["lang_zh"] is not None]
        by_turn.append(rate(sum(vals), len(vals)))
    print(f"  {c:13} " + "   ".join(f"T{i + 1} {v}" for i, v in enumerate(by_turn)))

print("\n== 各轮推理模式占比（所有步骤）：A 简写 / B 叙述 / C 不思考")
for c in CONF:
    rs = [r for k, r in ok.items() if k[1] == c]
    parts = []
    for ti in range(3):
        cnt = collections.Counter(s for r in rs for s in r["turns"][ti]["styles"])
        tot = sum(cnt.values()) or 1
        parts.append(f"T{ti + 1} A{100 * cnt['A'] / tot:.0f} B{100 * cnt['B'] / tot:.0f} C{100 * cnt['C'] / tot:.0f}")
    print(f"  {c:13} " + "  |  ".join(parts))

print("\n== 首步模式（每轮第一步）")
for c in CONF:
    rs = [r for k, r in ok.items() if k[1] == c]
    parts = []
    for ti in range(3):
        cnt = collections.Counter(r["turns"][ti]["styles"][0] for r in rs if r["turns"][ti]["styles"])
        parts.append(f"T{ti + 1} " + "".join(f"{k}{cnt[k]}" for k in "ABCDZ" if cnt[k]))
    print(f"  {c:13} " + "   ".join(parts))

print("\n== 违规明细（抽样）")
seen = collections.Counter()
for (s, c, rep), r in sorted(ok.items()):
    for t in r["turns"]:
        for rule in RULES:
            if t["checks"][rule] is False and seen[(c, rule)] < 2:
                seen[(c, rule)] += 1
                d = t["detail"]
                extra = {"file_links": d["links_missing"], "no_git": d["git_bad"], "cite": d["cite_problems"]}.get(rule, "")
                print(f"  {c:13} {s} T{t['turn']} {NAMES[rule]} {extra}")

print("\n== 中位数成本：每段对话的 completion tokens")
for c in CONF:
    rs = [r for k, r in ok.items() if k[1] == c]
    toks = sorted(sum((st["usage"] or {}).get("completion_tokens", 0) for t in r["turns"] for st in t["steps"]) for r in rs)
    if toks:
        print(f"  {c:13} {toks[len(toks) // 2]}")
