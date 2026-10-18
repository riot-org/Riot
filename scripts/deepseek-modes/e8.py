"""E8 RL 式 bash 落地前回归：T0（同期对照）/ B1a（B1 + Bash 别名）/ B4（B1a + 破坏性操作先问），和 E7 的 T0 / B1 对照。

用法：python3 -I e8.py riot_wire.json [reps]
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e5
import e7  # noqa: F401  起服务那题的判法

e5.CONFIGS = ["T0", "B1a", "B4"]
e5.OUT = os.path.join(HERE, "results", "e8.jsonl")

if __name__ == "__main__":
    e5.main()
