"""E6 单步探针：参考 DeepSeek Harness 和 V4/V4.1 的几个优化方向。

用法：python3 -I e6_probe.py riot_wire.json [n]
RL_BASH 摘自 DeepSeek Harness minimal 预设的快照（它是 RL 训练用的 agent 组合）。
"""

import collections
import concurrent.futures as cf
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e1
import prompts as P
from ds import chat_retry

w = json.load(open(sys.argv[1]))
N = int(sys.argv[2]) if len(sys.argv) > 2 else 8
sysmsg, user = w["messages"]
REAL = w["tools"]

RL_BASH = {"type": "function", "function": {
    "name": "bash",
    "description": (
        "Run commands in a bash shell\n"
        "* When invoking this tool, the contents of the \"command\" parameter does NOT need to be XML-escaped.\n"
        "* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.\n"
        "* State is persistent across command calls and discussions with the user.\n"
        "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.\n"
        "* Please avoid commands that may produce a very large amount of output.\n"
        "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background."),
    "parameters": {"type": "object", "properties": {"command": {
        "type": "string", "description": "The bash command to run. Relative path is preferred in the command."}},
        "required": ["command"]}}}

TASKS = {k: e1.TASKS[k] for k in os.environ.get("TASKS", "bug,svg,algo").split(",")}


def user_with(task, rules=True):
    c = user["content"].replace("第一问", task)
    if not rules:
        c = c.rsplit("<system-reminder>\n## agent_identity", 1)[0].rstrip()
    return {"role": "user", "content": c}


def swap_bash(tools):
    return [RL_BASH] + [t for t in copy.deepcopy(tools) if t["function"]["name"] != "Bash"]


VARIANTS = {
    # 名字: (model, system, rules_in_user, tools)
    "V0_r2_v4": ("deepseek-v4-flash", sysmsg["content"], True, REAL),
    "V1_r2_v41": ("deepseek-flash", sysmsg["content"], True, REAL),
    "V2_rl_harness_v4": ("deepseek-v4-flash", P.PERSONA, False, [RL_BASH]),
    "V2b_rl_harness_v41": ("deepseek-flash", P.PERSONA, False, [RL_BASH]),
    "V3_r2_rlbash_v4": ("deepseek-v4-flash", sysmsg["content"], True, swap_bash(REAL)),
    "V7_r2_rlbash_v41": ("deepseek-flash", sysmsg["content"], True, swap_bash(REAL)),
    "V5_r2_thinkmax_v4": ("deepseek-v4-flash", P.THINK_MAX + "\n\n" + sysmsg["content"], True, REAL),
}


def one(job):
    v, t, i = job
    model, system, rules, tools = VARIANTS[v]
    msgs = [{"role": "system", "content": system}, user_with(TASKS[t], rules)]
    r = chat_retry(msgs, tools=tools, model=model, stop_at_first_action=True, reason_cap=4000, max_tokens=16000)
    return v, t, P.style(r["reasoning"]), len(r["reasoning"])


def main():
    only = os.environ.get("ONLY")
    vs = only.split(",") if only else list(VARIANTS)
    jobs = [(v, t, i) for v in vs for t in TASKS for i in range(N)]
    c, ch = collections.Counter(), collections.defaultdict(list)
    with cf.ThreadPoolExecutor(16) as ex:
        for v, t, s, n in ex.map(one, jobs):
            c[(v, t, s)] += 1
            ch[(v, t)].append(n)
    med = lambda xs: sorted(xs)[len(xs) // 2]
    print(f"{'variant':22}" + "".join(f"{t:>22}" for t in TASKS) + "   A合计")
    for v in vs:
        line, tot = f"{v:22}", 0
        for t in TASKS:
            tot += c[(v, t, "A")]
            line += f"{'A%d B%d C%d med%d' % (c[(v, t, 'A')], c[(v, t, 'B')], c[(v, t, 'C')], med(ch[(v, t)])):>22}"
        print(line + f"   {tot}/{N * len(TASKS)}")


if __name__ == "__main__":
    main()
