"""真实请求回归：拿 Riot 装配出的 OpenAI 线上请求，换上测试任务，比 R2 和「规则放回系统提示词」。

请求文件的导出：在 session.rs 的 `两轮之间请求前缀逐字节不变` 测试里，
`assert_eq!(reqs[0].system, persona);` 后面临时加一段
`riot_providers::openai::request::build_request(&reqs[0], &[], &RetryContext::default(), true)`
序列化写到文件，跑完删掉。首条用户消息里的原话是「第一问」，这里按它替换。

用法：python3 -I wire_regress.py riot_wire.json
"""
import copy, collections, concurrent.futures as cf, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prompts as P, e1
from ds import chat_retry
w = json.load(open(sys.argv[1]))
sysmsg, user = w["messages"]
TASKS = {"svg": e1.TASKS["svg"], "bug": e1.TASKS["bug"], "algo": e1.TASKS["algo"]}
def variant(kind, task):
    u = copy.deepcopy(user)
    u["content"] = u["content"].replace("第一问", task)
    if kind == "R2_riot":
        return [sysmsg, u]
    # R0：把规则从首条用户消息末尾拿回系统提示词
    head, rules = u["content"].rsplit("<system-reminder>\n", 1)
    rules = rules.rsplit("\n</system-reminder>", 1)[0]
    return [{"role": "system", "content": rules}, {"role": "user", "content": head.rstrip()}]
def one(j):
    kind, t, i = j
    r = chat_retry(variant(kind, TASKS[t]), tools=w["tools"], stop_at_first_action=True, reason_cap=3000, max_tokens=16000)
    return kind, t, P.style(r["reasoning"])
c = collections.Counter()
jobs = [(k, t, i) for k in ("R2_riot", "R0_riot") for t in TASKS for i in range(8)]
with cf.ThreadPoolExecutor(16) as ex:
    for k, t, s in ex.map(one, jobs): c[(k, t, s)] += 1
for k in ("R2_riot", "R0_riot"):
    print(k, {t: f"A{c[(k,t,'A')]} B{c[(k,t,'B')]} C{c[(k,t,'C')]}" for t in TASKS})
