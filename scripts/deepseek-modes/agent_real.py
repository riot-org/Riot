"""用 Riot 真实工具定义跑完整轨迹，并按工具描述里的用法约束记违规。

核心工具（Read / Write / Edit / Bash / Glob / Grep / Delete / Terminal*）照 Riot 的
schema 真的执行；其余工具给桩：TodoWrite 回执，AskUserQuestion 回「用户不在」，
其他回「本环境不可用」并记下来。Bash 仍跑在 sandbox-exec 里。

三个配置（都是 R2 的形状：system 是 persona，Riot 规则在首条用户消息的 reminder 里）：
- T0：工具定义原样（现在的实现）；
- T1：工具定义只留一句话描述、参数去掉说明；完整说明放进 reminder 的 tool_reference 一节；
- T2：工具定义同 T1，完整说明哪儿都没有。
"""

import copy
import json
import os
import re
import shlex
import subprocess
import time

import prompts as P
from agent import Workspace
from ds import chat_retry

MAX_OUT = 20000


def first_sentence(text):
    line = text.strip().split("\n")[0]
    m = re.match(r"(.+?[.!?])(\s|$)", line)
    return (m.group(1) if m else line)[:200]


def strip_param_desc(schema):
    s = copy.deepcopy(schema)

    def walk(v):
        if isinstance(v, dict):
            v.pop("description", None)
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(s)
    return s


def slim_tools(tools):
    out = copy.deepcopy(tools)
    for t in out:
        f = t["function"]
        f["description"] = first_sentence(f["description"])
        f["parameters"] = strip_param_desc(f["parameters"])
    return out


def _param_doc(schema):
    lines = []
    for name, p in (schema.get("properties") or {}).items():
        d = (p.get("description") or "").replace("\n", " ")
        req = " (required)" if name in (schema.get("required") or []) else ""
        lines.append(f"- `{name}`{req}: {d}" if d else f"- `{name}`{req}")
    return "\n".join(lines)


def tool_manual(tools):
    parts = ["## tool_reference\n\nFull usage notes for the tools you have. The tool definitions themselves only carry a one-line summary."]
    for t in tools:
        f = t["function"]
        parts.append(f"### {f['name']}\n\n{f['description'].strip()}\n\nParameters:\n{_param_doc(f['parameters'])}")
    return "\n\n".join(parts)


class RealWorkspace(Workspace):
    """Riot 真实工具 schema 的执行，外加违规记录。"""

    def __init__(self, root, persistent_shell=False):
        super().__init__(root)
        self.read_files = set()
        self.violations = []
        self.stub_calls = []
        self.terminals = {}
        self.persistent_shell = persistent_shell
        self.bg_groups = []          # 持久 shell 里用 & 起的、bash 退出后仍活着的进程组
        self.bash_touched = set()    # 被 shell 改过（建、改、删）的文件
        self.tool_touched = set()    # 经 Write / Edit / Delete 改过的文件

    def snapshot(self):
        import hashlib
        out = {}
        for d, ds, fs in os.walk(self.root):
            ds[:] = [x for x in ds if x not in (".tmp", ".git", "__pycache__")]
            for f in fs:
                if f.endswith(".pyc"):
                    continue
                full = os.path.join(d, f)
                try:
                    out[os.path.relpath(full, self.root)] = hashlib.sha1(open(full, "rb").read()).hexdigest()
                except OSError:
                    pass
        return out

    def _v(self, kind, detail):
        self.violations.append({"kind": kind, "detail": detail[:200]})

    def _rel(self, full):
        return os.path.relpath(full, self.root)

    def run_real(self, name, a):
        try:
            return self._dispatch(name, a)
        except subprocess.TimeoutExpired:
            return "Error: command timed out"
        except Exception as e:
            return f"Error: {e}"

    def _dispatch(self, name, a):
        if name == "Read":
            full = self._path(a["path"])
            lines = open(full, encoding="utf-8", errors="replace").read().split("\n")
            off = max(int(a.get("offset") or 1), 1)
            lim = int(a.get("limit") or 2000)
            self.read_files.add(full)
            return "\n".join(f"{i}\t{l}" for i, l in enumerate(lines[off - 1:off - 1 + lim], start=off))
        if name == "Write":
            full = self._path(a["path"])
            if os.path.exists(full):
                if full not in self.read_files:
                    self._v("write_without_read", self._rel(full))
                    return "Error: you must Read this existing file before overwriting it."
                old = open(full, encoding="utf-8").read().split("\n")
                new = a["content"].split("\n")
                changed = sum(1 for x, y in zip(old, new) if x != y) + abs(len(old) - len(new))
                if len(old) >= 10 and changed <= max(2, len(old) // 5):
                    self._v("write_for_small_change", f"{self._rel(full)} {changed}/{len(old)} lines")
            elif full.endswith((".md", ".rst")) or os.path.basename(full).upper().startswith("README"):
                self._v("unrequested_doc_file", self._rel(full))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            open(full, "w", encoding="utf-8").write(a["content"])
            self.read_files.add(full)
            self.tool_touched.add(self._rel(full))
            return f"Wrote {self._rel(full)}"
        if name == "Edit":
            full = self._path(a["path"])
            old, new = a["old_string"], a["new_string"]
            if re.search(r"(^|\n)\s*\d+\t", old):
                self._v("line_number_prefix_in_edit", old[:80])
            s = open(full, encoding="utf-8").read()
            n = s.count(old)
            if a.get("replace_all"):
                if n == 0:
                    return "Error: old_string not found."
                open(full, "w", encoding="utf-8").write(s.replace(old, new))
                self.tool_touched.add(self._rel(full))
                return f"Replaced {n} occurrences."
            if n != 1:
                return f"Error: old_string found {n} times; it must match exactly once."
            open(full, "w", encoding="utf-8").write(s.replace(old, new, 1))
            self.read_files.add(full)
            self.tool_touched.add(self._rel(full))
            return "Edited."
        if name == "Delete":
            p = a.get("path") or a.get("file_path")
            full = self._path(p)
            os.remove(full)
            self.tool_touched.add(self._rel(full))
            return f"Deleted {self._rel(full)}"
        if name == "Glob":
            import glob as g
            base = self._path(a.get("path") or ".")
            hits = [h for h in g.glob(os.path.join(base, a["pattern"]), recursive=True)
                    if "/.git/" not in h and "/.tmp/" not in h and os.path.isfile(h)]
            hits.sort(key=os.path.getmtime, reverse=True)
            return "\n".join(self._rel(h) for h in hits[: int(a.get("head_limit") or 300)]) or "(no matches)"
        if name == "Grep":
            return self._grep(a)
        if name in ("Bash", "bash"):
            before = self.snapshot()
            out = self._bash_persistent(a) if self.persistent_shell else self._bash(a)
            after = self.snapshot()
            for k in set(before) | set(after):
                if before.get(k) != after.get(k):
                    self.bash_touched.add(k)
            return out
        if name == "TerminalOutput":
            tid = a.get("terminal_id") or a.get("id") or next(iter(self.terminals), None)
            t = self.terminals.get(tid)
            if not t:
                return "Error: no such terminal"
            t["proc"].poll()
            return open(t["log"]).read()[-4000:] or "(no output yet)"
        if name == "TerminalKill":
            tid = a.get("terminal_id") or a.get("id") or next(iter(self.terminals), None)
            t = self.terminals.pop(tid, None)
            if t:
                t["proc"].kill()
                return "Killed."
            return "Error: no such terminal"
        if name == "TerminalList":
            return "\n".join(self.terminals) or "(none)"
        if name == "TodoWrite":
            return "Todo list updated."
        if name == "AskUserQuestion":
            self.stub_calls.append(name)
            return "The user is away and cannot answer. Proceed with your best judgment."
        self.stub_calls.append(name)
        return f"Error: {name} is unavailable in this environment."

    def _grep(self, a):
        flags = re.I if a.get("case_insensitive") else 0
        rx = re.compile(a["pattern"], flags)
        base = self._path(a.get("path") or ".")
        files = [base] if os.path.isfile(base) else [
            os.path.join(d, f) for d, ds, fs in os.walk(base) if "/.git" not in d and "/.tmp" not in d for f in fs]
        if a.get("glob"):
            import fnmatch
            files = [f for f in files if fnmatch.fnmatch(os.path.basename(f), a["glob"]) or fnmatch.fnmatch(self._rel(f), a["glob"])]
        mode = a.get("output_mode") or "content"
        out = []
        for f in sorted(files):
            try:
                lines = open(f, encoding="utf-8").read().split("\n")
            except (UnicodeDecodeError, OSError):
                continue
            hits = [i for i, l in enumerate(lines) if rx.search(l)]
            if not hits:
                continue
            if mode == "files_with_matches":
                out.append(self._rel(f))
            elif mode == "count":
                out.append(f"{self._rel(f)}:{len(hits)}")
            else:
                for i in hits:
                    out.append(f"{self._rel(f)}:{i + 1}:{lines[i]}")
        return "\n".join(out[: int(a.get("head_limit") or 500)]) or "(no matches)"

    def _check_bash(self, cmd, a):
        # 只看每段管道的第一个命令：`... | grep x`、`... | tail` 是过滤输出，不是读文件、搜代码。
        segs = [part.split("|")[0] for part in re.split(r"&&|\|\||;|\n", cmd)]
        for seg in segs:
            words = seg.strip().split()
            if not words:
                continue
            w0 = words[0]
            if w0 in ("grep", "rg", "egrep", "ack") or (w0 == "git" and len(words) > 1 and words[1] in ("grep", "ls-files")):
                self._v("shell_search", cmd)
            if w0 == "find" or (w0 == "ls" and "-R" in words):
                self._v("shell_find", cmd)
            if w0 in ("cat", "head", "tail", "less", "more") and len(words) > 1 and not words[1].startswith(("<", ">")):
                self._v("shell_read", cmd)
            if w0 == "sed" and ("-n" in words or "-i" in words or any(x.startswith("-i") for x in words)):
                self._v("shell_read_or_edit", cmd)
            if w0 in ("echo", "printf", "cat") and re.search(r"(?<![0-9&])>\s*[\w./]", seg):
                self._v("shell_write", cmd)
            if w0 == "rm" and len(words) == 2 and words[1].endswith((".py", ".js", ".ts", ".rs", ".go")):
                self._v("rm_single_source_file", cmd)
        if re.fullmatch(r"\s*cd\s+\S+\s*", cmd):
            self._v("bare_cd", cmd)

    def _bash(self, a):
        cmd = a["command"]
        self._check_bash(cmd, a)
        tmp = os.path.join(self.root, ".tmp")
        os.makedirs(tmp, exist_ok=True)
        env = {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
               "HOME": self.root, "TMPDIR": tmp, "PYTHONDONTWRITEBYTECODE": "1", "LANG": "en_US.UTF-8"}
        argv = ["sandbox-exec", "-f", self.profile, "/bin/bash", "-c", cmd]
        if a.get("background"):
            tid = f"term{len(self.terminals) + 1}"
            log = os.path.join(tmp, tid + ".log")
            proc = subprocess.Popen(argv, cwd=self.root, env=env, stdout=open(log, "w"), stderr=subprocess.STDOUT)
            self.terminals[tid] = {"proc": proc, "log": log, "cmd": cmd}
            time.sleep(2)
            return f"Started in terminal {tid}. Read its output with TerminalOutput(terminal_id: \"{tid}\")."
        timeout = 60
        try:
            p = subprocess.run(argv, cwd=self.root, env=env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            self._v("long_lived_without_background", cmd)
            out = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            return out[-2000:] + f"\n[killed after {timeout}s timeout]"
        out = (p.stdout + p.stderr) or "(no output)"
        return out + ("" if p.returncode == 0 else f"\n[exit code {p.returncode}]")

    def _bash_persistent(self, a):
        """模拟 RL 环境里的持久 bash：cwd 和导出的环境变量跨调用保留，`&` 放后台的进程不阻塞。

        不是真正的常驻进程（shell 函数、未导出的变量不保留），但覆盖了 RL 版描述承诺的
        「State is persistent」里模型实际会依赖的部分。
        """
        cmd = a["command"]
        self._check_bash(cmd, a)
        tmp = os.path.join(self.root, ".tmp")
        os.makedirs(tmp, exist_ok=True)
        cwdf, envf = os.path.join(tmp, "shell.cwd"), os.path.join(tmp, "shell.env")
        if not os.path.exists(cwdf):
            open(cwdf, "w").write(self.root)
        n = len(os.listdir(tmp))
        log = os.path.join(tmp, f"bash{n}.log")
        script = (f'cd "$(cat {shlex.quote(cwdf)})" 2>/dev/null || cd {shlex.quote(self.root)}\n'
                  f'[ -f {shlex.quote(envf)} ] && . {shlex.quote(envf)} 2>/dev/null\n'
                  f'{cmd}\n__rc=$?\npwd > {shlex.quote(cwdf)}\nexport -p > {shlex.quote(envf)}\nexit $__rc\n')
        env = {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
               "HOME": self.root, "TMPDIR": tmp, "PYTHONDONTWRITEBYTECODE": "1", "LANG": "en_US.UTF-8"}
        with open(log, "w") as lf:
            proc = subprocess.Popen(["sandbox-exec", "-f", self.profile, "/bin/bash", "-c", script],
                                    cwd=self.root, env=env, stdout=lf, stderr=subprocess.STDOUT,
                                    start_new_session=True)
        try:
            rc = proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self._v("long_lived_without_background", cmd)
            try:
                os.killpg(proc.pid, 9)
            except ProcessLookupError:
                pass
            return open(log, errors="replace").read()[-2000:] + "\n[killed after 60s timeout]"
        time.sleep(0.5 if "&" in cmd else 0)
        try:
            os.killpg(proc.pid, 0)
            self.bg_groups.append(proc.pid)
        except (ProcessLookupError, PermissionError):
            pass
        out = open(log, errors="replace").read() or "(no output)"
        return out + ("" if rc == 0 else f"\n[exit code {rc}]")

    def background_alive(self):
        alive = any(t["proc"].poll() is None for t in self.terminals.values())
        for g in self.bg_groups:
            try:
                os.killpg(g, 0)
                alive = True
            except (ProcessLookupError, PermissionError):
                pass
        return alive

    def cleanup(self):
        for t in self.terminals.values():
            t["proc"].kill()
        for g in self.bg_groups:
            try:
                os.killpg(g, 9)
            except (ProcessLookupError, PermissionError):
                pass
        # 模型会用 nohup / setsid / screen 把服务放进新的会话，进程组清理够不着。
        # 按工作目录兜底：cwd 在本工作区里的进程一律结束。
        try:
            pids = subprocess.run(["lsof", "-t", "+d", self.root], capture_output=True, text=True, timeout=20).stdout.split()
        except (subprocess.TimeoutExpired, OSError):
            pids = []
        for pid in set(pids):
            if int(pid) != os.getpid():
                try:
                    os.kill(int(pid), 9)
                except (ProcessLookupError, PermissionError, ValueError):
                    pass


RL_BASH_DESC = (
    "Run commands in a bash shell\n"
    "* When invoking this tool, the contents of the \"command\" parameter does NOT need to be XML-escaped.\n"
    "* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.\n"
    "* State is persistent across command calls and discussions with the user.\n"
    "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.\n"
    "* Please avoid commands that may produce a very large amount of output.\n"
    "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.")

# Riot 版：RL 的写法，只补 Riot 必需的一条（破坏性操作先问）。
RIOT_RL_BASH_DESC = (
    "Run commands in a bash shell\n"
    "* State is persistent across command calls: `cd` and exported environment variables carry over.\n"
    "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.\n"
    "* Please avoid commands that may produce a very large amount of output.\n"
    "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.\n"
    "* Ask the user before destructive operations they did not request, such as `git push --force`, "
    "`git reset --hard` or `rm -rf` outside build output.")

EDIT_LINE = "\n* Change files with the Edit and Write tools rather than through the shell, so the user can review the diff."


def _bash_tool(name, desc):
    return {"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": {"command": {
            "type": "string", "description": "The bash command to run. Relative path is preferred in the command."}},
            "required": ["command"]}}}


def _swap_bash(tools, new):
    return [new] + [t for t in copy.deepcopy(tools) if t["function"]["name"] != "Bash"]


DESTRUCTIVE_LINE = ("\n* Ask the user before destructive operations they did not request, such as "
                    "`git push --force`, `git reset --hard` or `rm -rf` outside build output.")

PERSISTENT_CONFIGS = {"B1", "B2", "B3", "B1a", "B4", "REAL"}
# 这些配置下，对 `Bash` 的调用按 `bash` 的别名接受（落地时 Riot 也会这么做）。
ALIAS_CONFIGS = {"B1a", "B4"}


def build(config, wire, task_text, cwd):
    """返回 (system, 首条用户消息, tools)。"""
    sysmsg, user = wire["messages"]
    content = user["content"].replace("第一问", task_text)
    m = re.search(r"Working directory: (\S+)", content)
    if m:
        content = content.replace(m.group(1), cwd)
    tools = wire["tools"]
    if config in ("T0", "REAL"):  # REAL：请求文件里的工具原样用（落地后导出的真实请求）
        return sysmsg["content"], content, tools
    if config == "B1":  # RL 版原文，小写 bash
        return sysmsg["content"], content, _swap_bash(tools, _bash_tool("bash", RL_BASH_DESC))
    if config == "B1a":  # B1 + Bash 别名
        return sysmsg["content"], content, _swap_bash(tools, _bash_tool("bash", RL_BASH_DESC))
    if config == "B4":  # B1 + Bash 别名 + 破坏性操作先问
        return sysmsg["content"], content, _swap_bash(tools, _bash_tool("bash", RL_BASH_DESC + DESTRUCTIVE_LINE))
    if config == "B2":  # Riot 版 RL 写法
        return sysmsg["content"], content, _swap_bash(tools, _bash_tool("Bash", RIOT_RL_BASH_DESC))
    if config == "B3":  # B2 + 「改文件用 Edit/Write」
        return sysmsg["content"], content, _swap_bash(tools, _bash_tool("Bash", RIOT_RL_BASH_DESC + EDIT_LINE))
    slim = slim_tools(tools)
    if config == "T2":
        return sysmsg["content"], content, slim
    if config == "T1":
        assert content.rstrip().endswith("</system-reminder>")
        head = content.rstrip()[: -len("</system-reminder>")].rstrip()
        content = head + "\n\n" + tool_manual(tools) + "\n</system-reminder>"
        return sysmsg["content"], content, slim
    raise ValueError(config)


def _background_used(steps):
    for s in steps:
        for c in s["tool_calls"]:
            if c["name"] != "Bash":
                continue
            try:
                if json.loads(c["arguments"] or "{}").get("background"):
                    return True
            except json.JSONDecodeError:
                pass
    return False


def run_task(config, wire, task_text, root, max_steps=30, deadline_s=1200):
    ws = RealWorkspace(root, persistent_shell=config in PERSISTENT_CONFIGS)
    initial = ws.snapshot()
    system, first, tools = build(config, wire, task_text, ws.root)
    names = {t["function"]["name"] for t in tools}
    alias_used = 0
    bg_alive = False
    msgs = [{"role": "user", "content": first}]
    steps = []
    t_start = time.time()
    try:
        for _ in range(max_steps):
            if time.time() - t_start > deadline_s:
                ws._v("deadline_exceeded", f"{deadline_s}s")
                break
            r = chat_retry([{"role": "system", "content": system}] + msgs, tools=tools, effort="max", timeout=300)
            steps.append({"style": P.style(r["reasoning"]), "reasoning_chars": len(r["reasoning"]),
                          "reasoning": r["reasoning"][:800], "content": r["content"],
                          "tool_calls": [{"name": c["name"], "arguments": c["arguments"][:2000]} for c in r["tool_calls"]],
                          "usage": r["usage"], "finish": r["finish"]})
            am = {"role": "assistant", "content": r["content"] or "", "reasoning_content": r["reasoning"]}
            if r["tool_calls"]:
                am["tool_calls"] = [{"id": c["id"], "type": "function",
                                     "function": {"name": c["name"], "arguments": c["arguments"]}} for c in r["tool_calls"]]
            msgs.append(am)
            if not r["tool_calls"]:
                break
            for c in r["tool_calls"]:
                if config in ALIAS_CONFIGS and c["name"] == "Bash" and "bash" in names:
                    alias_used += 1
                    c = dict(c, name="bash")
                if c["name"] not in names:
                    # 和真实 Riot 一样：调用不存在的工具直接报错，不偷偷放行。
                    ws._v("unknown_tool", c["name"])
                    out = f"Error: no tool named {c['name']}. Available tools: {', '.join(sorted(names))}."
                    msgs.append({"role": "tool", "tool_call_id": c["id"], "content": out})
                    continue
                try:
                    out = ws.run_real(c["name"], json.loads(c["arguments"] or "{}"))
                except json.JSONDecodeError:
                    out = "Error: arguments are not valid JSON"
                if len(out) > MAX_OUT:
                    out = out[:MAX_OUT] + "\n...[truncated]"
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": out})
        bg_alive = ws.background_alive()
    finally:
        ws.cleanup()
    final_snap = ws.snapshot()
    changed = {k for k in set(initial) | set(final_snap) if initial.get(k) != final_snap.get(k)}
    untracked = sorted(changed & ws.bash_touched)
    usage = [s["usage"] or {} for s in steps]
    return {
        "config": config, "steps": steps, "final": steps[-1]["content"] if steps else "",
        "n_steps": len(steps), "violations": ws.violations, "stub_calls": ws.stub_calls,
        "terminals_left": list(ws.terminals),
        "background_alive_at_end": bg_alive,
        "alias_used": alias_used,
        "changed_files": sorted(changed),
        "untracked_changes": untracked,
        "tool_changes": sorted(changed & ws.tool_touched),
        "background_used": _background_used(steps),
        "first_style": steps[0]["style"] if steps else None,
        "completion_tokens": sum(u.get("completion_tokens", 0) for u in usage),
        "prompt_tokens": sum(u.get("prompt_tokens", 0) for u in usage),
    }
