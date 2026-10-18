"""E7 RL 式 Bash：T0（现状 R2）/ B1（RL 版原文）/ B2（Riot 版 RL 写法）/ B3（B2 + 改文件用 Edit），完整轨迹。

B 系列的 Bash 跑在模拟的持久 shell 里（cwd 和导出的环境变量跨调用保留，`&` 放后台）。
复用 E5 的 12 道任务；起服务那题改成按「结束时服务还活着」判。

用法：python3 -I e7.py riot_wire.json [reps]
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e5

e5.CONFIGS = ["T0", "B1", "B2", "B3"]
e5.OUT = os.path.join(HERE, "results", "e7.jsonl")
_grade_extra = e5.grade_extra


def grade_extra(t, root, traj):
    if t["id"] == "s1_server":
        return {"pass": "8765" in (traj["final"] or "") and traj["background_alive_at_end"]}
    return _grade_extra(t, root, traj)


e5.grade_extra = grade_extra

if __name__ == "__main__":
    e5.main()
