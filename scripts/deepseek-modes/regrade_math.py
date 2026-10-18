"""用修正后的提取器重新判数学题，写回 e3.jsonl（原文件备份为 e3.jsonl.bak）。"""
import json, os, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from e3 import extract_int, math_failure
p = os.path.join(HERE, "results", "e3.jsonl")
shutil.copy(p, p + ".bak")
out = []
for l in open(p):
    r = json.loads(l)
    if r.get("kind") == "math" and "error" not in r:
        g = r["grade"]; got = extract_int(r["traj"]["final"])
        g.update(got=got, **{"pass": got == g["answer"]}, failure=math_failure(r["traj"], got, g["answer"]))
    out.append(json.dumps(r, ensure_ascii=False))
open(p, "w").write("\n".join(out) + "\n")
