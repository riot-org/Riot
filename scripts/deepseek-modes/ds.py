"""DeepSeek Chat Completions 的最小流式客户端。

key 从环境变量 DEEPSEEK_API_KEY 读，没有就读 DEEPSEEK_KEY_FILE 指向的文件。
key 不进仓库。
"""

import http.client
import json
import os
import time
import urllib.error
import urllib.request

URL = "https://api.deepseek.com/chat/completions"
MODEL = os.environ.get("DS_MODEL", "deepseek-v4-flash")


def _key():
    k = os.environ.get("DEEPSEEK_API_KEY")
    if k:
        return k.strip()
    path = os.environ.get("DEEPSEEK_KEY_FILE")
    if path:
        return open(path).read().strip()
    raise SystemExit("需要 DEEPSEEK_API_KEY 或 DEEPSEEK_KEY_FILE")


KEY = _key()


def chat(messages, tools=None, effort="max", max_tokens=32000, stop_at_first_action=False,
         reason_cap=None, temperature=1.0, model=None, timeout=900):
    """发一次请求，返回 dict(reasoning, content, tool_calls, usage, first, finish, elapsed)。

    stop_at_first_action：读到第一个正文或工具调用就断开（单步探针用）。
    reason_cap：推理累计到这么多字就断开，first 记为 "cap"。
    """
    body = {
        "model": model or MODEL,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "reasoning_effort": effort,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if tools:
        body["tools"] = tools
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    t0 = time.time()
    r = urllib.request.urlopen(req, timeout=timeout)
    reasoning, content, usage, first, finish = [], [], None, None, None
    calls = {}
    try:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            d = line[5:].strip()
            if d == "[DONE]":
                break
            j = json.loads(d)
            if j.get("usage"):
                usage = j["usage"]
            if not j.get("choices"):
                continue
            ch = j["choices"][0]
            dl = ch.get("delta") or {}
            if dl.get("reasoning_content"):
                reasoning.append(dl["reasoning_content"])
            if dl.get("content"):
                content.append(dl["content"])
                first = first or "text"
            for tc in dl.get("tool_calls") or []:
                first = first or "tool"
                slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "arguments": ""})
                slot["id"] = tc.get("id") or slot["id"]
                fn = tc.get("function") or {}
                slot["name"] += fn.get("name") or ""
                slot["arguments"] += fn.get("arguments") or ""
            if ch.get("finish_reason"):
                finish = ch["finish_reason"]
            if stop_at_first_action and first:
                break
            if reason_cap and sum(map(len, reasoning)) >= reason_cap and not first:
                first = "cap"
                break
    finally:
        r.close()
    if finish is None and first != "cap" and not (stop_at_first_action and first):
        # 流被中途断开：没有 finish_reason 也没有用量。当成网络错误重试。
        raise ConnectionError("stream ended without finish_reason")
    return {
        "reasoning": "".join(reasoning),
        "content": "".join(content),
        "tool_calls": [calls[i] for i in sorted(calls)],
        "usage": usage,
        "first": first,
        "finish": finish,
        "elapsed": time.time() - t0,
    }


def chat_retry(*a, tries=4, **kw):
    err = None
    for i in range(tries):
        try:
            return chat(*a, **kw)
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError, OSError,
                http.client.HTTPException) as e:
            err = e
            body = ""
            if isinstance(e, urllib.error.HTTPError):
                body = e.read().decode("utf-8", "replace")[:500]
                if e.code == 400:
                    raise RuntimeError(f"400: {body}") from e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"请求失败：{err}")
