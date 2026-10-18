"""设计题盲评页：每题 4 张图随机排成 W/X/Y/Z，映射写到 results/design_key.json。

评审时只看 results/design_review.html；评完把排名写进 results/design_ranks.json
（{"d01_zebra": ["X", "W", "Z", "Y"], ...}，从好到差），再跑 --score 揭盲。
"""

import collections
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
KEY = os.path.join(RES, "design_key.json")


def build():
    rows = [json.loads(l) for l in open(os.path.join(RES, "e3.jsonl"))]
    rows = [r for r in rows if r.get("kind") == "design" and "error" not in r]
    by = collections.defaultdict(dict)
    for r in rows:
        by[r["id"]][r["config"]] = r["grade"].get("svg")
    rng = random.Random(20261018)
    key, cards = {}, []
    for tid in sorted(by):
        confs = list(by[tid])
        rng.shuffle(confs)
        key[tid] = {}
        cells = []
        for lab, c in zip("WXYZ", confs):
            key[tid][lab] = c
            svg = by[tid][c]
            body = (open(svg).read() if svg and os.path.exists(svg) else "<p>（没有产出文件）</p>")
            cells.append(f'<figure><figcaption>{lab}</figcaption><div class="img">'
                         f'<img src="data:image/svg+xml;charset=utf-8,{_q(body)}"></div></figure>')
        cards.append(f"<section><h2>{tid}</h2><div class='grid'>{''.join(cells)}</div></section>")
    json.dump(key, open(KEY, "w"), indent=1)
    html = ("<!doctype html><meta charset=utf-8><title>Design review</title><style>"
            "body{font:14px system-ui;margin:16px;background:#fff;color:#111}"
            ".grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}"
            "figure{margin:0;border:1px solid #ccc}figcaption{font:bold 18px system-ui;padding:4px}"
            ".img{aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;background:#f4f4f4}"
            ".img img{max-width:100%;max-height:100%}</style>" + "".join(cards))
    open(os.path.join(RES, "design_review.html"), "w").write(html)
    print("写好了 results/design_review.html")


def _q(s):
    from urllib.parse import quote
    return quote(s)


def score():
    key = json.load(open(KEY))
    ranks = json.load(open(os.path.join(RES, "design_ranks.json")))
    pts = collections.Counter()
    first = collections.Counter()
    for tid, order in ranks.items():
        for i, lab in enumerate(order):
            pts[key[tid][lab]] += len(order) - 1 - i
            if i == 0:
                first[key[tid][lab]] += 1
    for c in sorted(pts, key=lambda c: -pts[c]):
        print(f"{c}: 积分 {pts[c]}（满分 {3 * len(ranks)}），第一名 {first[c]} 次")


if __name__ == "__main__":
    score() if "--score" in sys.argv else build()
