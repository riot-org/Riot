"""系统提示词变体、工具定义、风格分类器。

data/riot_prompt.txt 是 Riot 真实的系统提示词（OpenAI 兼容外壳，模型名
deepseek-v4-flash，工作目录占位 /tmp/proj）。重新生成：在 prompt.rs 的
tests 里临时加一个测试把 system_prompt(...) 写到文件。
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
RIOT = open(os.path.join(HERE, "data", "riot_prompt.txt")).read()
CWD_PLACEHOLDER = "/tmp/proj"

_MODEL_SENTENCE = (
    "You are Riot, a general-purpose agent running on the user's own machine, powered by the model "
    "`deepseek-v4-flash`. Riot is who you are; `deepseek-v4-flash` is what runs you — if asked which "
    "model you are, that is the answer. "
)
assert _MODEL_SENTENCE in RIOT, "riot_prompt.txt 的身份句变了，更新 _MODEL_SENTENCE"
RIOT_NO_MODEL = RIOT.replace(_MODEL_SENTENCE, "You are Riot, a general-purpose agent running on the user's own machine. ")
RIOT_IDENTITY = RIOT.split("\n## communicating_with_the_user")[0]

PERSONA = "You are a helpful software engineer assistant."
PERSONA_ZH = "你是一个乐于助人的软件工程师助手。"
# V4 报告表 4 里工具调用系统提示词的那句。
V4_TOOL_RULE = ("You MUST output your complete reasoning inside <think>...</think> BEFORE any tool calls "
                "or final response.")
# V4 报告表 3 Think Max 指令里能确认的几句。
THINK_MAX = ("Reasoning Effort: Absolute maximum with no shortcuts permitted. You MUST be very thorough in "
             "your thinking. Explicitly write out your entire deliberation process, documenting every "
             "intermediate step.")
RULES_DENSE = ("You must always answer in the user's language. You must never invent facts. You must keep "
               "answers under 200 words. You must cite sources. You must never use emojis. You must ask "
               "before destructive actions. You must not apologize. You must use Markdown headings.")
R32_REASON = "Please first reason before giving the final answer."


def _filler(n_chars):
    para = ("The Riverside Botanical Archive was founded in 1887 by a group of amateur naturalists. Its "
            "collection grew steadily through donations from regional herbaria, and today it holds specimens "
            "from more than forty countries. The main building, a brick structure with tall arched windows, "
            "was renovated in 1962 and again in 2004. Visitors often remark on the reading room, whose oak "
            "shelves still carry the original brass labels. ")
    return (para * (n_chars // len(para) + 1))[:n_chars]


def reminder(rules):
    return "<system-reminder>\n" + rules.strip() + "\n</system-reminder>"


def with_cwd(text, cwd):
    return text.replace(CWD_PLACEHOLDER, cwd)


# E1 的系统提示词。值是 (system, user_suffix)：user_suffix 不为空时，它被
# 拼到用户消息里任务的后面。
E1_SYSTEMS = {
    "none": (None, None),
    "persona": (PERSONA, None),
    "persona_zh": (PERSONA_ZH, None),
    "riot_full": (RIOT, None),
    "riot_no_model": (RIOT_NO_MODEL, None),
    "riot_identity": (RIOT_IDENTITY, None),
    "filler_len_matched": (_filler(len(RIOT)), None),
    "rules_dense": (RULES_DENSE, None),
    "v4_tool_rule": (V4_TOOL_RULE, None),
    "r32_reason": (R32_REASON, None),
    "think_max": (THINK_MAX, None),
    "rules_in_user": (PERSONA, reminder(RIOT_NO_MODEL)),
}

TOOLS = [
    {"type": "function", "function": {"name": n, "description": d, "parameters": {
        "type": "object", "properties": p, "required": req}}}
    for n, d, p, req in [
        ("Read", "Read a text file. Returns its content with line numbers.",
         {"path": {"type": "string", "description": "Absolute path, or relative to the working directory."}},
         ["path"]),
        ("Write", "Create or overwrite a file with the given content.",
         {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
        ("Edit", "Replace one exact, unique occurrence of old_string with new_string in a file.",
         {"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}},
         ["path", "old_string", "new_string"]),
        ("Bash", "Run a shell command in the working directory and return stdout+stderr. No network.",
         {"command": {"type": "string"}}, ["command"]),
        ("Glob", "List files matching a glob pattern, relative to the working directory.",
         {"pattern": {"type": "string"}}, ["pattern"]),
    ]
]

_NEED_SENT = re.compile(r"(?:^|[.!?;]\s+|\n)Need\b")


def style(reasoning):
    """A 简写 / B 叙述 / C 不思考 / D 流畅「We need to」/ Z 中文思维链。

    按句式判：句首的「Need …」或不接 to 的「We need …」是简写体的标志。
    冠词比例不可靠 —— 数学推理里的变量 a 和公式会把它搅乱。
    """
    r = reasoning.strip()
    if not r:
        return "C"
    head = r[:300]
    if len(re.findall(r"[一-鿿]", head)) > len(head) * 0.3:
        return "Z"
    if re.match(r"We need (?!to\b)", head) or _NEED_SENT.search(head):
        return "A"
    if re.match(r"We (need|have) to\b", head):
        return "D"
    return "B"


def pronouns(reasoning):
    w = [x.lower() for x in re.findall(r"[A-Za-z']+", reasoning[:3000])]
    n = max(len(w), 1)
    return {
        "we": sum(x in ("we", "we'll", "let's", "us") for x in w) / n,
        "i": sum(x in ("i", "i'll", "i'm", "i've", "me", "my") for x in w) / n,
        "user": reasoning[:3000].lower().count("the user") / n,
    }
