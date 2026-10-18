"""E5 汇总。"""
import collections, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(os.path.join(HERE, "results", "e5.jsonl"))]
ok = {}
for r in rows:
    if "error" not in r:
        ok[(r["id"], r["config"], r["rep"])] = r
errs = [r for r in rows if "error" in r and (r["id"], r["config"], r["rep"]) not in ok]
C = ["T0", "T1", "T2"]
print(f"有效 {len(ok)}，未恢复的错误 {len(errs)}")
by = collections.defaultdict(list)
for (tid, c, rep), r in ok.items():
    by[c].append(r)
med = lambda xs: sorted(xs)[len(xs) // 2] if xs else 0
print(f"\n{'':6}{'通过':>10}{'首步A':>9}{'首步C':>8}{'全步骤A':>9}{'违规/条':>9}{'有违规的轨迹':>12}{'中位 tokens':>12}{'中位步数':>8}")
for c in C:
    rs = by[c]; n = len(rs)
    steps = [s for r in rs for s in r["traj"]["steps"]]
    print(f"{c:6}{sum(bool(r['grade'].get('pass')) for r in rs):>6}/{n:<3}"
          f"{sum(r['traj']['first_style'] == 'A' for r in rs):>6}/{n:<3}{sum(r['traj']['first_style'] == 'C' for r in rs):>5}/{n:<3}"
          f"{100 * sum(s['style'] == 'A' for s in steps) / max(len(steps), 1):>7.0f}%"
          f"{sum(len(r['traj']['violations']) for r in rs) / n:>9.2f}{sum(bool(r['traj']['violations']) for r in rs):>9}/{n:<3}"
          f"{med([r['traj']['completion_tokens'] for r in rs]):>12}{med([r['traj']['n_steps'] for r in rs]):>8}")
print("\n违规分类（次数）")
kinds = sorted({v["kind"] for c in C for r in by[c] for v in r["traj"]["violations"]})
for k in kinds:
    print(f"  {k:28}" + "".join(f"{c}={sum(v['kind'] == k for r in by[c] for v in r['traj']['violations']):<4}" for c in C))
print("\n按任务：通过 / 首步模式")
for tid in sorted({k[0] for k in ok}):
    line = f"  {tid:16}"
    for c in C:
        rs = [ok[k] for k in ok if k[0] == tid and k[1] == c]
        line += f"  {c}: {sum(bool(r['grade'].get('pass')) for r in rs)}/{len(rs)} " + "".join(r["traj"]["first_style"] for r in rs)
    print(line)
print("\n桩工具调用", {c: collections.Counter(x for r in by[c] for x in r["traj"]["stub_calls"]) for c in C})
print("改代码范围", {c: sum(r["grade"].get("in_scope", True) for r in by[c] if r["id"].startswith("e")) for c in C})
