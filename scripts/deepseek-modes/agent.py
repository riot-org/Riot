"""完整轨迹执行器：真的执行工具，循环到模型不再调工具或达到步数上限。

工具全部限定在一个临时工作目录里。Bash 跑在 macOS sandbox-exec 下：
工作目录以外不可写、不能联网。每一步都回传 reasoning_content，和 Riot 的
replay_reasoning 一致。
"""

import glob as _glob
import json
import os
import subprocess

import prompts as P
from ds import chat_retry

MAX_OUT = 20000  # 单个工具结果截断


class Workspace:
    def __init__(self, root):
        self.root = os.path.realpath(root)
        self.profile = os.path.join(os.path.dirname(self.root), os.path.basename(self.root) + ".sb")
        with open(self.profile, "w") as f:
            f.write(f"""(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath "{self.root}") (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))
""")

    def _path(self, p):
        p = p.replace(P.CWD_PLACEHOLDER, self.root)
        full = os.path.realpath(p if os.path.isabs(p) else os.path.join(self.root, p))
        if not (full == self.root or full.startswith(self.root + os.sep)):
            raise ValueError(f"path outside working directory: {p}")
        return full

    def run(self, name, args):
        try:
            if name == "Read":
                with open(self._path(args["path"]), encoding="utf-8", errors="replace") as f:
                    lines = f.read().split("\n")
                return "\n".join(f"{i + 1:5}\t{l}" for i, l in enumerate(lines))
            if name == "Write":
                full = self._path(args["path"])
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w", encoding="utf-8") as f:
                    f.write(args["content"])
                return f"Wrote {len(args['content'])} chars to {args['path']}"
            if name == "Edit":
                full = self._path(args["path"])
                s = open(full, encoding="utf-8").read()
                n = s.count(args["old_string"])
                if n != 1:
                    return f"Error: old_string found {n} times; it must be unique."
                with open(full, "w", encoding="utf-8") as f:
                    f.write(s.replace(args["old_string"], args["new_string"], 1))
                return "Edited."
            if name == "Bash":
                # /usr/bin/python3 是 xcrun 的壳，会往沙箱外写缓存并打警告，所以 homebrew 优先。
                tmp = os.path.join(self.root, ".tmp")
                os.makedirs(tmp, exist_ok=True)
                env = {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                       "HOME": self.root, "TMPDIR": tmp, "PYTHONDONTWRITEBYTECODE": "1", "LANG": "en_US.UTF-8"}
                p = subprocess.run(["sandbox-exec", "-f", self.profile, "/bin/bash", "-c", args["command"]],
                                   cwd=self.root, env=env, capture_output=True, text=True, timeout=60)
                out = (p.stdout + p.stderr) or "(no output)"
                return out + ("" if p.returncode == 0 else f"\n[exit code {p.returncode}]")
            if name == "Glob":
                hits = sorted(_glob.glob(os.path.join(self.root, args["pattern"]), recursive=True))
                return "\n".join(os.path.relpath(h, self.root) for h in hits) or "(no matches)"
            return f"Error: unknown tool {name}"
        except subprocess.TimeoutExpired:
            return "Error: command timed out after 60s"
        except Exception as e:  # 工具错误原样回给模型
            return f"Error: {e}"


def build_first(config, task_text, cwd):
    """返回 (首轮 system, 之后的 system, 首条用户消息)。"""
    full = P.with_cwd(P.RIOT, cwd)
    no_model = P.with_cwd(P.RIOT_NO_MODEL, cwd)
    if config == "R0":
        return full, full, task_text
    if config == "R1":
        return P.PERSONA, full, task_text
    if config == "R2":
        return P.PERSONA, P.PERSONA, task_text + "\n\n" + P.reminder(no_model)
    if config == "R3":
        s = P.V4_TOOL_RULE + "\n\n" + no_model
        return s, s, task_text
    raise ValueError(config)


def run_task(config, task_text, workdir=None, tools=True, max_steps=30, effort="max"):
    """跑一条轨迹。workdir 为 None 时不给工具（纯推理题）。"""
    ws = Workspace(workdir) if workdir else None
    cwd = ws.root if ws else P.CWD_PLACEHOLDER
    sys_first, sys_rest, user = build_first(config, task_text, cwd)
    tool_defs = P.TOOLS if (tools and ws) else None
    msgs = [{"role": "user", "content": user}]
    steps, discarded = [], None
    for step in range(max_steps):
        system = sys_first if step == 0 else sys_rest
        req = ([{"role": "system", "content": system}] if system else []) + msgs
        r = chat_retry(req, tools=tool_defs, effort=effort)
        # R1：首轮没调工具就丢掉，用完整提示词重发（复现 adapt::MinimalOpening）。
        if config == "R1" and step == 0 and not r["tool_calls"] and tool_defs:
            discarded = r
            req = [{"role": "system", "content": sys_rest}] + msgs
            r = chat_retry(req, tools=tool_defs, effort=effort)
        steps.append({k: r[k] for k in ("reasoning", "content", "usage", "finish", "elapsed")} |
                     {"tool_calls": r["tool_calls"], "style": P.style(r["reasoning"])})
        am = {"role": "assistant", "content": r["content"] or "", "reasoning_content": r["reasoning"]}
        if r["tool_calls"]:
            am["tool_calls"] = [{"id": c["id"], "type": "function",
                                 "function": {"name": c["name"], "arguments": c["arguments"]}}
                                for c in r["tool_calls"]]
        msgs.append(am)
        if not r["tool_calls"]:
            break
        for c in r["tool_calls"]:
            try:
                args = json.loads(c["arguments"] or "{}")
                out = ws.run(c["name"], args)
            except json.JSONDecodeError:
                out = "Error: arguments are not valid JSON"
            if len(out) > MAX_OUT:
                out = out[:MAX_OUT] + f"\n...[truncated {len(out) - MAX_OUT} chars]"
            msgs.append({"role": "tool", "tool_call_id": c["id"], "content": out})
    usage = [s["usage"] or {} for s in steps]
    return {
        "config": config,
        "steps": steps,
        "final": steps[-1]["content"] if steps else "",
        "n_steps": len(steps),
        "hit_max_steps": len(steps) == max_steps and bool(steps[-1]["tool_calls"]),
        "first_style": steps[0]["style"] if steps else None,
        "first_reasoning_chars": len(steps[0]["reasoning"]) if steps else 0,
        "discarded_first": discarded and {"style": P.style(discarded["reasoning"]),
                                          "usage": discarded["usage"]},
        "completion_tokens": sum(u.get("completion_tokens", 0) for u in usage)
        + ((discarded or {}).get("usage") or {}).get("completion_tokens", 0),
        "reasoning_tokens": sum((u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
                                for u in usage),
        "prompt_tokens": sum(u.get("prompt_tokens", 0) for u in usage),
    }
