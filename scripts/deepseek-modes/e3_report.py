"""E3 汇总：通过率、配对检验（相对 R0）、token、首步模式。"""

import collections
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(os.path.join(HERE, "results", "e3.jsonl"))]
ok_rows = [r for r in rows if "error" not in r]
errs = [r for r in rows if "error" in r]
CONF = ["R0", "R1", "R2", "R3"]


def group(r):
    if r["kind"] == "repo":
        return "repo_bug" if r["id"].startswith("b") else "repo_edit"
    return r["kind"]


def mcnemar(b, c):
    """精确双侧二项检验，b = 只有对照组过，c = 只有实验组过。"""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def boot_diff(pairs, iters=4000, seed=0):
    """pairs: [(x_ctrl, x_exp)]，返回 exp-ctrl 均值差的 95% CI。"""
    rng = random.Random(seed)
    n = len(pairs)
    ds = []
    for _ in range(iters):
        s = [pairs[rng.randrange(n)] for _ in range(n)]
        ds.append(sum(e - c for c, e in s) / n)
    ds.sort()
    return ds[int(0.025 * iters)], ds[int(0.975 * iters)]


by = collections.defaultdict(dict)
for r in ok_rows:
    by[(group(r), r["id"], r["rep"])][r["config"]] = r

groups = ["repo_bug", "repo_edit", "code", "math", "design"]
print(f"记录 {len(rows)}，错误 {len(errs)}")
for e in errs[:5]:
    print("  ERR", e["kind"], e["id"], e["config"], e["error"][:120])

print("\n== 通过率（design 的 pass 只表示产出了文件）")
print(f"{'group':10}" + "".join(f"{c:>14}" for c in CONF))
for g in groups:
    line = f"{g:10}"
    for c in CONF:
        xs = [v[c]["grade"].get("pass", False) for k, v in by.items() if k[0] == g and c in v]
        line += f"{(f'{sum(xs)}/{len(xs)} {100 * sum(xs) / max(len(xs), 1):.0f}%'):>14}"
    print(line)

print("\n== 相对 R0 的配对比较：通过率差（95% bootstrap CI），McNemar p")
for g in groups[:4]:
    for c in CONF[1:]:
        pairs = [(int(bool(v["R0"]["grade"].get("pass"))), int(bool(v[c]["grade"].get("pass"))))
                 for k, v in by.items() if k[0] == g and "R0" in v and c in v]
        if not pairs:
            continue
        b = sum(1 for x, y in pairs if x and not y)
        cc = sum(1 for x, y in pairs if y and not x)
        lo, hi = boot_diff(pairs)
        d = sum(y - x for x, y in pairs) / len(pairs)
        print(f"  {g:10} {c} vs R0: {100 * d:+5.1f} pp  [{100 * lo:+.1f}, {100 * hi:+.1f}]  "
              f"discordant R0-only={b} {c}-only={cc}  p={mcnemar(b, cc):.3f}  n={len(pairs)}")

print("\n== edit 任务：测试通过 / 范围内")
for c in CONF:
    xs = [v[c]["grade"] for k, v in by.items() if k[0] == "repo_edit" and c in v]
    print(f"  {c}: tests_pass {sum(g['tests_pass'] for g in xs)}/{len(xs)}  in_scope {sum(g['in_scope'] for g in xs)}/{len(xs)}  "
          f"改了测试 {sum(bool(g['tests_touched']) for g in xs)}")

print("\n== 成本：每条轨迹的中位数（completion tokens / reasoning tokens / 步数）")
print(f"{'group':10}" + "".join(f"{c:>22}" for c in CONF))
for g in groups:
    line = f"{g:10}"
    for c in CONF:
        ts = [v[c]["traj"] for k, v in by.items() if k[0] == g and c in v]
        if not ts:
            line += f"{'-':>22}"
            continue
        med = lambda xs: sorted(xs)[len(xs) // 2]
        line += f"{med([t['completion_tokens'] for t in ts]):>8}/{med([t['reasoning_tokens'] for t in ts]):>6}/{med([t['n_steps'] for t in ts]):>4}  "
    print(line)

print("\n== 首步推理模式（A 简写 / B 叙述 / C 不思考 / D / Z）")
for g in groups:
    line = f"{g:10}"
    for c in CONF:
        cnt = collections.Counter(v[c]["traj"]["first_style"] for k, v in by.items() if k[0] == g and c in v)
        line += "  " + c + ":" + "".join(f"{k}{cnt[k]}" for k in "ABCDZ" if cnt[k])
    print(line)

print("\n== 全部步骤的模式占比（agent 类任务）")
for c in CONF:
    cnt = collections.Counter(s["style"] for k, v in by.items() if k[0] in ("repo_bug", "repo_edit", "code", "design")
                              and c in v for s in v[c]["traj"]["steps"])
    tot = sum(cnt.values()) or 1
    print(f"  {c}: " + "  ".join(f"{k}={100 * cnt[k] / tot:.0f}%" for k in "ABCDZ"))

print("\n== R1 首轮被丢弃重发的次数")
disc = [v["R1"]["traj"]["discarded_first"] for k, v in by.items() if "R1" in v and v["R1"]["traj"]["discarded_first"]]
print(f"  {len(disc)} 次，浪费 completion tokens 合计 {sum((d.get('usage') or {}).get('completion_tokens', 0) for d in disc)}")

print("\n== 首步模式与通过率（agent 类任务，所有配置合并）")
cnt = collections.defaultdict(lambda: [0, 0])
for k, v in by.items():
    if k[0] not in ("repo_bug", "repo_edit", "code"):
        continue
    for c, r in v.items():
        s = r["traj"]["first_style"]
        cnt[s][0] += bool(r["grade"].get("pass"))
        cnt[s][1] += 1
for s, (p, n) in sorted(cnt.items()):
    print(f"  首步 {s}: {p}/{n} = {100 * p / n:.0f}%")
