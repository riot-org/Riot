"""E10 落地后回归：用改完之后导出的真实请求（工具里已是 RL 式 Bash）原样跑 E8 的 12 道任务。

用法：python3 -I e10.py riot_wire_rl.json [reps]
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e5
import e7  # noqa: F401  起服务那题的判法

e5.CONFIGS = ["REAL"]
e5.OUT = os.path.join(HERE, "results", "e10.jsonl")

if __name__ == "__main__":
    e5.main()
