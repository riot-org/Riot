"""E7 汇总：通过率、推理模式、改动追踪覆盖率、工具名错误、成本。"""

import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = os.environ.get("FILES", "e7.jsonl").split(",")
rows = [json.loads(l) for f in FILES for l in open(os.path.join(HERE, "results", f))]
ok = {}
for r in rows:
    if "error" not in r:
        ok[(r["id"], r["config"], r["rep"])] = r
missing = {(r["id"], r["config"], r["rep"]) for r in rows if "error" in r} - set(ok)
C = os.environ.get("CONFIGS", "T0,B1,B2,B3").split(",")
CODE_EXT = (".py", ".md", ".txt", ".json", ".toml", ".cfg", ".yml", ".yaml", ".js", ".ts", ".sh")


def is_code(path):
    # 运行产物（日志、pid、隐藏目录里的东西）不算代码改动
    return path.endswith(CODE_EXT) and not any(part.startswith(".") for part in path.split("/"))


med = lambda xs: sorted(xs)[len(xs) // 2] if xs else 0
by = collections.defaultdict(list)
for (tid, c, rep), r in ok.items():
    by[c].append(r)

print(f"有效 {len(ok)}，未恢复的错误 {len(missing)}")
print(f"\n{'':4}{'通过':>9}{'首步A':>9}{'首步C':>8}{'全步骤A':>8}{'绕过工具改代码的轨迹':>14}{'代码改动走工具的比例':>14}{'工具名错误':>9}{'长进程没放后台':>11}{'中位tokens':>10}{'中位步数':>7}")
for c in C:
    rs = by[c]
    n = len(rs)
    steps = [s for r in rs for s in r["traj"]["steps"]]
    changed = [f for r in rs for f in r["traj"]["changed_files"] if is_code(f)]
    untracked = [f for r in rs for f in r["traj"]["untracked_changes"] if is_code(f)]
    traj_untracked = sum(any(is_code(f) for f in r["traj"]["untracked_changes"]) for r in rs)
    viol = collections.Counter(v["kind"] for r in rs for v in r["traj"]["violations"])
    print(f"{c:4}{sum(bool(r['grade'].get('pass')) for r in rs):>5}/{n:<3}"
          f"{sum(r['traj']['first_style'] == 'A' for r in rs):>5}/{n:<3}{sum(r['traj']['first_style'] == 'C' for r in rs):>4}/{n:<3}"
          f"{100 * sum(s['style'] == 'A' for s in steps) / max(len(steps), 1):>6.0f}%"
          f"{traj_untracked:>10}/{n:<3}"
          f"{100 * (1 - len(untracked) / max(len(changed), 1)):>11.0f}% ({len(changed) - len(untracked)}/{len(changed)})"
          f"{viol['unknown_tool']:>7}{viol['long_lived_without_background']:>11}"
          f"  别名{sum(r['traj'].get('alias_used', 0) for r in rs):>3}"
          f"{med([r['traj']['completion_tokens'] for r in rs]):>10}{med([r['traj']['n_steps'] for r in rs]):>7}")

print("\nRiot 规则意义上的 shell 用法（B 系列里按 RL 写法这些是被鼓励的，只作参考）")
kinds = ["shell_find", "shell_read", "shell_read_or_edit", "shell_write", "shell_search", "rm_single_source_file", "bare_cd"]
for k in kinds:
    print(f"  {k:24}" + "".join(f"{c}={sum(v['kind'] == k for r in by[c] for v in r['traj']['violations']):<5}" for c in C))

print("\n按任务：通过 / 首步模式")
for tid in sorted({k[0] for k in ok}):
    line = f"  {tid:16}"
    for c in C:
        rs = [ok[k] for k in sorted(ok) if k[0] == tid and k[1] == c]
        line += f"  {c}: {sum(bool(r['grade'].get('pass')) for r in rs)}/{len(rs)} " + "".join(r["traj"]["first_style"] for r in rs)
    print(line)

print("\n绕过工具改的代码文件（样例）")
for c in C:
    ex = [(r["id"], f) for r in by[c] for f in r["traj"]["untracked_changes"] if is_code(f)]
    print(f"  {c}: {ex[:8]}")
