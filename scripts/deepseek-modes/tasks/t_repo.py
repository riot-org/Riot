"""E3 仓库类任务：修 bug（kind=bug）和限定范围的改动（kind=edit）。

判分：
- bug：可见测试 + 隐藏测试全过；可见测试文件不许改。
- edit：隐藏测试（新功能）+ 原有测试全过；并且**范围检查**：目标函数以外的
  函数 AST 不变，其他已有文件不变（允许新增文件）。
"""

import ast
import hashlib
import json
import os
import subprocess

BUG_PROMPT = "Running `python3 -m unittest` in this repo fails. Please find and fix the bug. Don't modify the tests."

T = []


def task(id, kind, prompt, files, hidden, target=None):
    T.append({"id": id, "kind": kind, "prompt": prompt, "files": files, "hidden": hidden, "target": target})


# ---------------------------------------------------------------- bugs
task("b01_semver", "bug", BUG_PROMPT, {
    "semver.py": '''
def parse(v):
    """'1.2.3' -> (major, minor, patch) as strings."""
    return tuple(v.strip().lstrip("v").split("."))


def compare(a, b):
    """Return -1, 0 or 1."""
    pa, pb = parse(a), parse(b)
    return (pa > pb) - (pa < pb)


def latest(versions):
    best = None
    for v in versions:
        if best is None or compare(v, best) > 0:
            best = v
    return best
''',
    "tests/__init__.py": "",
    "tests/test_semver.py": '''
import unittest
from semver import compare, latest

class T(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(compare("1.2.3", "1.2.3"), 0)
        self.assertEqual(compare("1.2.4", "1.2.3"), 1)
    def test_double_digit(self):
        self.assertEqual(compare("1.10.0", "1.9.0"), 1)
    def test_latest(self):
        self.assertEqual(latest(["0.9.0", "0.10.1", "0.10.0"]), "0.10.1")
''',
}, {
    "tests/test_hidden_semver.py": '''
import unittest
from semver import compare, latest
class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual(compare("v2.0.0", "1.99.99"), 1)
        self.assertEqual(compare("10.0.0", "9.0.0"), 1)
        self.assertEqual(compare("1.2.10", "1.2.9"), 1)
        self.assertEqual(compare("0.0.1", "0.0.10"), -1)
        self.assertEqual(latest(["1.0.0"]), "1.0.0")
        self.assertIsNone(latest([]))
''',
})

task("b02_split_bill", "bug", BUG_PROMPT, {
    "billing.py": '''
def split_bill(total_cents, people):
    """Split an integer amount of cents among people as evenly as possible.

    The first (total % people) people pay one extra cent. Sum must equal total.
    """
    if people <= 0:
        raise ValueError("people must be positive")
    share = total_cents / people
    base = int(share)
    extra = round((share - base) * people)
    return [base + (1 if i < extra - 1 else 0) for i in range(people)]
''',
    "tests/__init__.py": "",
    "tests/test_billing.py": '''
import unittest
from billing import split_bill
class T(unittest.TestCase):
    def test_even(self):
        self.assertEqual(split_bill(900, 3), [300, 300, 300])
    def test_remainder(self):
        self.assertEqual(split_bill(1000, 3), [334, 333, 333])
        self.assertEqual(sum(split_bill(1001, 7)), 1001)
''',
}, {
    "tests/test_hidden_billing.py": '''
import unittest
from billing import split_bill
class H(unittest.TestCase):
    def test_many(self):
        for total in range(0, 400, 7):
            for p in range(1, 12):
                s = split_bill(total, p)
                self.assertEqual(sum(s), total)
                self.assertLessEqual(max(s) - min(s), 1)
                self.assertEqual(s, sorted(s, reverse=True))
        self.assertEqual(split_bill(5, 3), [2, 2, 1])
        with self.assertRaises(ValueError):
            split_bill(5, 0)
''',
})

task("b03_lru", "bug", BUG_PROMPT, {
    "cache.py": '''
from collections import OrderedDict


class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.data = OrderedDict()

    def get(self, key, default=None):
        if key not in self.data:
            return default
        return self.data[key]

    def put(self, key, value):
        if key in self.data:
            self.data.move_to_end(key)
        self.data[key] = value
        if len(self.data) > self.capacity:
            self.data.popitem(last=False)

    def __len__(self):
        return len(self.data)
''',
    "tests/__init__.py": "",
    "tests/test_cache.py": '''
import unittest
from cache import LRUCache
class T(unittest.TestCase):
    def test_evicts_least_recent(self):
        c = LRUCache(2)
        c.put("a", 1); c.put("b", 2)
        c.get("a")
        c.put("c", 3)
        self.assertEqual(c.get("a"), 1)
        self.assertIsNone(c.get("b"))
''',
}, {
    "tests/test_hidden_cache.py": '''
import unittest
from cache import LRUCache
class H(unittest.TestCase):
    def test_more(self):
        c = LRUCache(3)
        for k in "abc": c.put(k, k)
        c.get("a"); c.put("b", "B"); c.put("d", "d")
        self.assertIsNone(c.get("c"))
        self.assertEqual(c.get("b"), "B")
        self.assertEqual(len(c), 3)
        self.assertEqual(c.get("zz", 7), 7)
        c.get("a"); c.put("e", 1)
        self.assertIsNone(c.get("d"))
''',
})

task("b04_months", "bug", BUG_PROMPT, {
    "dates.py": '''
import datetime

DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def days_in_month(year, month):
    return DAYS[month - 1]


def add_months(d, n):
    """Add n months to date d, clamping the day to the end of the target month."""
    m = d.month - 1 + n
    year = d.year + m // 12
    month = m % 12 + 1
    day = min(d.day, days_in_month(year, month))
    return datetime.date(year, month, day)
''',
    "tests/__init__.py": "",
    "tests/test_dates.py": '''
import datetime, unittest
from dates import add_months
class T(unittest.TestCase):
    def test_clamp(self):
        self.assertEqual(add_months(datetime.date(2023, 1, 31), 1), datetime.date(2023, 2, 28))
    def test_leap(self):
        self.assertEqual(add_months(datetime.date(2024, 1, 31), 1), datetime.date(2024, 2, 29))
''',
}, {
    "tests/test_hidden_dates.py": '''
import datetime, unittest
from dates import add_months, days_in_month
class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual(days_in_month(1900, 2), 28)
        self.assertEqual(days_in_month(2000, 2), 29)
        self.assertEqual(add_months(datetime.date(2024, 3, 31), -1), datetime.date(2024, 2, 29))
        self.assertEqual(add_months(datetime.date(2023, 12, 15), 2), datetime.date(2024, 2, 15))
        self.assertEqual(add_months(datetime.date(2020, 2, 29), 12), datetime.date(2021, 2, 28))
''',
})

task("b05_tokenizer", "bug", BUG_PROMPT, {
    "lexer.py": '''
import re

OPS = ["<", ">", "=", "!", "<=", ">=", "==", "!=", "+", "-", "*", "/", "(", ")"]
TOKEN = re.compile(r"\\s*(?:(\\d+\\.?\\d*)|([A-Za-z_]\\w*)|(" + "|".join(map(re.escape, OPS)) + r"))")


def tokenize(src):
    pos, out = 0, []
    src = src.rstrip()
    while pos < len(src):
        m = TOKEN.match(src, pos)
        if not m:
            raise SyntaxError(f"bad char at {pos}: {src[pos]!r}")
        num, name, op = m.groups()
        if num:
            out.append(("NUM", float(num) if "." in num else int(num)))
        elif name:
            out.append(("NAME", name))
        else:
            out.append(("OP", op))
        pos = m.end()
    return out
''',
    "tests/__init__.py": "",
    "tests/test_lexer.py": '''
import unittest
from lexer import tokenize
class T(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(tokenize("a + 12"), [("NAME", "a"), ("OP", "+"), ("NUM", 12)])
    def test_two_char_ops(self):
        self.assertEqual(tokenize("x<=3"), [("NAME", "x"), ("OP", "<="), ("NUM", 3)])
''',
}, {
    "tests/test_hidden_lexer.py": '''
import unittest
from lexer import tokenize
class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual([t[1] for t in tokenize("a>=b != c == 2.5")], ["a", ">=", "b", "!=", "c", "==", 2.5])
        self.assertEqual(tokenize("  (x)"), [("OP", "("), ("NAME", "x"), ("OP", ")")])
        self.assertEqual(tokenize("a<b"), [("NAME", "a"), ("OP", "<"), ("NAME", "b")])
        with self.assertRaises(SyntaxError):
            tokenize("a $ b")
''',
})

task("b06_report", "bug", BUG_PROMPT, {
    "report.py": '''
import csv
import io


def totals_by_region(csv_text):
    """CSV rows are sorted by region. Return [(region, total_amount)] in order."""
    rows = csv.DictReader(io.StringIO(csv_text))
    out = []
    current, acc = None, 0
    for r in rows:
        if r["region"] != current:
            if current is not None:
                out.append((current, acc))
            current, acc = r["region"], 0
        acc += int(r["amount"])
    return out
''',
    "tests/__init__.py": "",
    "tests/test_report.py": '''
import unittest
from report import totals_by_region
DATA = "region,amount\\neast,5\\neast,7\\nwest,1\\n"
class T(unittest.TestCase):
    def test_totals(self):
        self.assertEqual(totals_by_region(DATA), [("east", 12), ("west", 1)])
''',
}, {
    "tests/test_hidden_report.py": '''
import unittest
from report import totals_by_region
class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual(totals_by_region("region,amount\\n"), [])
        self.assertEqual(totals_by_region("region,amount\\na,1\\n"), [("a", 1)])
        self.assertEqual(totals_by_region("region,amount\\na,1\\nb,2\\nb,3\\nc,0\\n"), [("a", 1), ("b", 5), ("c", 0)])
''',
})

task("b07_bucket", "bug", BUG_PROMPT, {
    "ratelimit.py": '''
class TokenBucket:
    """rate tokens per second, up to capacity. Time is passed in explicitly (seconds, float)."""

    def __init__(self, rate, capacity, now=0.0):
        self.rate = rate
        self.capacity = capacity
        self.tokens = capacity
        self.last = now

    def _refill(self, now):
        elapsed = now - self.last
        self.tokens = min(self.capacity, self.tokens + int(elapsed) * self.rate)
        self.last = now

    def allow(self, now, cost=1):
        self._refill(now)
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False
''',
    "tests/__init__.py": "",
    "tests/test_ratelimit.py": '''
import unittest
from ratelimit import TokenBucket
class T(unittest.TestCase):
    def test_fractional_refill(self):
        b = TokenBucket(rate=2, capacity=2)
        self.assertTrue(b.allow(0.0)); self.assertTrue(b.allow(0.0)); self.assertFalse(b.allow(0.0))
        self.assertTrue(b.allow(0.5))
''',
}, {
    "tests/test_hidden_ratelimit.py": '''
import unittest
from ratelimit import TokenBucket
class H(unittest.TestCase):
    def test_more(self):
        b = TokenBucket(rate=1, capacity=3)
        for _ in range(3): self.assertTrue(b.allow(0))
        self.assertFalse(b.allow(0.4))
        self.assertFalse(b.allow(0.8))
        self.assertTrue(b.allow(1.0))
        self.assertFalse(b.allow(1.0))
        self.assertTrue(b.allow(100, cost=3))
        self.assertFalse(b.allow(100))
''',
})

task("b08_wrap", "bug", BUG_PROMPT, {
    "wrap.py": '''
def wrap(text, width):
    """Greedy word wrap. Lines never exceed width unless a single word is longer than width."""
    lines, cur = [], ""
    for word in text.split():
        if not cur:
            cur = word
        elif len(cur) + len(word) <= width:
            cur += " " + word
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines
''',
    "tests/__init__.py": "",
    "tests/test_wrap.py": '''
import unittest
from wrap import wrap
class T(unittest.TestCase):
    def test_width(self):
        for line in wrap("aaa bbb ccc ddd", 6):
            self.assertLessEqual(len(line), 6)
        self.assertEqual(wrap("aaa bbb ccc", 7), ["aaa bbb", "ccc"])
''',
}, {
    "tests/test_hidden_wrap.py": '''
import unittest
from wrap import wrap
class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual(wrap("", 5), [])
        self.assertEqual(wrap("abcdefgh xy", 5), ["abcdefgh", "xy"])
        self.assertEqual(wrap("a b c d", 3), ["a b", "c d"])
        self.assertEqual(wrap("ab cd", 4), ["ab", "cd"])
        self.assertEqual(wrap("ab cd", 5), ["ab cd"])
''',
})

task("b09_dijkstra", "bug", BUG_PROMPT, {
    "graph.py": '''
import heapq


class Graph:
    def __init__(self):
        self.adj = {}

    def add_edge(self, u, v, w):
        self.adj.setdefault(u, []).append((v, w))
        self.adj.setdefault(v, []).append((u, w))

    def shortest(self, src, dst):
        """Length of the shortest path, or None."""
        heap = [(0, src)]
        seen = set()
        while heap:
            d, u = heapq.heappop(heap)
            if u in seen:
                continue
            seen.add(u)
            if u == dst:
                return -d
            for v, w in self.adj.get(u, []):
                if v not in seen:
                    heapq.heappush(heap, (d - w, v))
        return None
''',
    "tests/__init__.py": "",
    "tests/test_graph.py": '''
import unittest
from graph import Graph
class T(unittest.TestCase):
    def test_prefers_short(self):
        g = Graph()
        g.add_edge("a", "b", 1); g.add_edge("b", "c", 1); g.add_edge("a", "c", 5)
        self.assertEqual(g.shortest("a", "c"), 2)
''',
}, {
    "tests/test_hidden_graph.py": '''
import unittest
from graph import Graph
class H(unittest.TestCase):
    def test_more(self):
        g = Graph()
        for u, v, w in [(1,2,7),(1,3,9),(1,6,14),(2,3,10),(2,4,15),(3,4,11),(3,6,2),(4,5,6),(5,6,9)]:
            g.add_edge(u, v, w)
        self.assertEqual(g.shortest(1, 5), 20)
        self.assertEqual(g.shortest(1, 1), 0)
        g.add_edge(8, 9, 1)
        self.assertIsNone(g.shortest(1, 9))
''',
})

task("b10_roman", "bug", BUG_PROMPT, {
    "roman.py": '''
VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def from_roman(s):
    total = 0
    for i, ch in enumerate(s):
        v = VALUES[ch]
        if i + 1 < len(s) and VALUES[s[i + 1]] > v and ch == "I":
            total -= v
        else:
            total += v
    return total
''',
    "tests/__init__.py": "",
    "tests/test_roman.py": '''
import unittest
from roman import from_roman
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(from_roman("IV"), 4)
        self.assertEqual(from_roman("XC"), 90)
''',
}, {
    "tests/test_hidden_roman.py": '''
import unittest
from roman import from_roman
class H(unittest.TestCase):
    def test_more(self):
        for s, v in [("MCMXCIV", 1994), ("CDXLIV", 444), ("MMMCMXCIX", 3999), ("LVIII", 58), ("III", 3)]:
            self.assertEqual(from_roman(s), v)
''',
})

task("b11_inventory", "bug", BUG_PROMPT, {
    "inventory/__init__.py": "",
    "inventory/config.py": '''
import os

# Items at or below this many units are reported as low stock.
LOW_STOCK = os.environ.get("LOW_STOCK", "5")
''',
    "inventory/store.py": '''
from inventory import config


class Store:
    def __init__(self):
        self.stock = {}

    def add(self, item, n):
        self.stock[item] = self.stock.get(item, 0) + n

    def remove(self, item, n):
        have = self.stock.get(item, 0)
        if n > have:
            raise ValueError(f"only {have} {item} left")
        self.stock[item] = have - n

    def low_stock(self):
        return sorted(i for i, n in self.stock.items() if n <= config.LOW_STOCK)
''',
    "tests/__init__.py": "",
    "tests/test_store.py": '''
import unittest
from inventory.store import Store
class T(unittest.TestCase):
    def test_low(self):
        s = Store(); s.add("pen", 3); s.add("ink", 20)
        self.assertEqual(s.low_stock(), ["pen"])
    def test_remove(self):
        s = Store(); s.add("pen", 3)
        with self.assertRaises(ValueError):
            s.remove("pen", 4)
''',
}, {
    "tests/test_hidden_store.py": '''
import unittest
from inventory.store import Store
class H(unittest.TestCase):
    def test_more(self):
        s = Store(); s.add("a", 5); s.add("b", 6); s.add("c", 0)
        self.assertEqual(s.low_stock(), ["a", "c"])
        s.remove("b", 1)
        self.assertEqual(s.low_stock(), ["a", "b", "c"])
''',
})

task("b12_matrix", "bug", BUG_PROMPT, {
    "matrix.py": '''
def transpose(m):
    if not m:
        return []
    return [[m[j][i] for j in range(len(m[0]))] for i in range(len(m))]


def matmul(a, b):
    bt = transpose(b)
    return [[sum(x * y for x, y in zip(row, col)) for col in bt] for row in a]
''',
    "tests/__init__.py": "",
    "tests/test_matrix.py": '''
import unittest
from matrix import transpose, matmul
class T(unittest.TestCase):
    def test_rect(self):
        self.assertEqual(transpose([[1, 2, 3], [4, 5, 6]]), [[1, 4], [2, 5], [3, 6]])
    def test_matmul(self):
        self.assertEqual(matmul([[1, 2, 3]], [[1], [2], [3]]), [[14]])
''',
}, {
    "tests/test_hidden_matrix.py": '''
import unittest
from matrix import transpose, matmul
class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual(transpose([[1], [2]]), [[1, 2]])
        self.assertEqual(transpose([]), [])
        self.assertEqual(matmul([[1, 2], [3, 4]], [[5, 6], [7, 8]]), [[19, 22], [43, 50]])
        self.assertEqual(matmul([[1], [2]], [[3, 4]]), [[3, 4], [6, 8]])
''',
})

task("b13_schedule", "bug", BUG_PROMPT, {
    "schedule.py": '''
class Calendar:
    """Half-open intervals [start, end): a meeting ending at 10 does not conflict with one starting at 10."""

    def __init__(self):
        self.events = []

    def conflicts(self, start, end):
        return [e for e in self.events if start <= e[1] and e[0] <= end]

    def book(self, start, end):
        if end <= start:
            raise ValueError("empty interval")
        if self.conflicts(start, end):
            return False
        self.events.append((start, end))
        return True
''',
    "tests/__init__.py": "",
    "tests/test_schedule.py": '''
import unittest
from schedule import Calendar
class T(unittest.TestCase):
    def test_adjacent(self):
        c = Calendar()
        self.assertTrue(c.book(9, 10))
        self.assertTrue(c.book(10, 11))
        self.assertFalse(c.book(9, 11))
''',
}, {
    "tests/test_hidden_schedule.py": '''
import unittest
from schedule import Calendar
class H(unittest.TestCase):
    def test_more(self):
        c = Calendar()
        self.assertTrue(c.book(10, 20))
        self.assertTrue(c.book(5, 10)); self.assertTrue(c.book(20, 25))
        self.assertFalse(c.book(19, 21)); self.assertFalse(c.book(12, 13)); self.assertFalse(c.book(0, 30))
        with self.assertRaises(ValueError):
            c.book(3, 3)
''',
})

task("b14_slug", "bug", BUG_PROMPT, {
    "slug.py": '''
import re
import unicodedata


def slugify(title):
    """'Héllo, World!' -> 'hello-world'. Only [a-z0-9-], no leading/trailing/double hyphens."""
    s = unicodedata.normalize("NFKD", title)
    s = s.lower()
    s = re.sub(r"[^a-z0-9]", "-", s)
    s = re.sub(r"-+", "-", s)
    return s
''',
    "tests/__init__.py": "",
    "tests/test_slug.py": '''
import unittest
from slug import slugify
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("Héllo Wörld"), "hello-world")
''',
}, {
    "tests/test_hidden_slug.py": '''
import unittest
from slug import slugify
class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual(slugify("  --Já é  tarde--  "), "ja-e-tarde")
        self.assertEqual(slugify("Crème Brûlée 2"), "creme-brulee-2")
        self.assertEqual(slugify("!!!"), "")
        self.assertEqual(slugify("a_b"), "a-b")
''',
})

task("b15_paginate", "bug", BUG_PROMPT, {
    "pages.py": '''
def total_pages(n_items, per_page):
    return n_items // per_page + 1


def paginate(items, page, per_page):
    """1-indexed pages. Returns (slice, has_next)."""
    if page < 1 or page > max(1, total_pages(len(items), per_page)):
        raise IndexError("page out of range")
    start = (page - 1) * per_page
    chunk = items[start:start + per_page]
    return chunk, page < total_pages(len(items), per_page)
''',
    "tests/__init__.py": "",
    "tests/test_pages.py": '''
import unittest
from pages import paginate, total_pages
class T(unittest.TestCase):
    def test_exact(self):
        self.assertEqual(total_pages(10, 5), 2)
        self.assertEqual(paginate(list(range(10)), 2, 5), ([5, 6, 7, 8, 9], False))
''',
}, {
    "tests/test_hidden_pages.py": '''
import unittest
from pages import paginate, total_pages
class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual(total_pages(0, 5), 0)
        self.assertEqual(total_pages(11, 5), 3)
        self.assertEqual(paginate(list(range(11)), 3, 5), ([10], False))
        self.assertEqual(paginate([], 1, 5), ([], False))
        with self.assertRaises(IndexError):
            paginate(list(range(10)), 3, 5)
''',
})

# ---------------------------------------------------------------- edits
TEXT_PY = '''
import re


def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower())
    return s.strip("-")


def title_case(s):
    small = {"a", "an", "the", "of", "and"}
    words = s.split()
    return " ".join(w if (i and w in small) else w.capitalize() for i, w in enumerate(words))


def truncate(s, n):
    return s if len(s) <= n else s[: max(0, n - 1)] + "…"
'''
task("e01_slug_sep", "edit",
     "In text.py, give slugify an optional keyword argument `sep` (default \"-\") that is used instead of the hyphen. "
     "Only change slugify; leave everything else as it is.",
     {"text.py": TEXT_PY, "tests/__init__.py": "", "tests/test_text.py": '''
import unittest
from text import slugify, title_case, truncate
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(slugify("Hello World"), "hello-world")
        self.assertEqual(title_case("the art of war"), "The Art of War")
        self.assertEqual(truncate("abcdef", 4), "abc…")
'''}, {"tests/test_hidden_e01.py": '''
import unittest
from text import slugify
class H(unittest.TestCase):
    def test(self):
        self.assertEqual(slugify("Hello World", sep="_"), "hello_world")
        self.assertEqual(slugify("  A--B  ", sep="."), "a.b")
        self.assertEqual(slugify("x y"), "x-y")
'''}, target=("text.py", ["slugify"]))

STATS_PY = '''
def mean(xs):
    return sum(xs) / len(xs)


def median(xs):
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def variance(xs):
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / len(xs)
'''
task("e02_mean_empty", "edit",
     "mean() in stats.py crashes with ZeroDivisionError on an empty list. Make it raise ValueError(\"mean of empty data\") instead. "
     "Don't touch the other functions.",
     {"stats.py": STATS_PY, "tests/__init__.py": "", "tests/test_stats.py": '''
import unittest
from stats import mean, median, variance
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(mean([1, 2, 3]), 2)
        self.assertIsNone(median([]))
        self.assertEqual(variance([1, 3]), 1)
'''}, {"tests/test_hidden_e02.py": '''
import unittest
from stats import mean
class H(unittest.TestCase):
    def test(self):
        with self.assertRaisesRegex(ValueError, "mean of empty data"):
            mean([])
        self.assertEqual(mean([4]), 4)
'''}, target=("stats.py", ["mean"]))

CART_PY = '''
class Cart:
    def __init__(self):
        self.items = []
        self.discount = 0.0

    def add(self, name, price_cents, qty=1):
        self.items.append((name, price_cents, qty))

    def subtotal(self):
        return sum(p * q for _, p, q in self.items)

    def total(self):
        return round(self.subtotal() * (1 - self.discount))
'''
task("e03_coupon", "edit",
     "Add an `apply_coupon(code)` method to Cart in cart.py: \"SAVE10\" sets a 10% discount, \"SAVE25\" sets 25%, any other code raises ValueError. "
     "Don't change the existing methods.",
     {"cart.py": CART_PY, "tests/__init__.py": "", "tests/test_cart.py": '''
import unittest
from cart import Cart
class T(unittest.TestCase):
    def test(self):
        c = Cart(); c.add("a", 1000, 2)
        self.assertEqual(c.total(), 2000)
'''}, {"tests/test_hidden_e03.py": '''
import unittest
from cart import Cart
class H(unittest.TestCase):
    def test(self):
        c = Cart(); c.add("a", 1000)
        c.apply_coupon("SAVE10"); self.assertEqual(c.total(), 900)
        c.apply_coupon("SAVE25"); self.assertEqual(c.total(), 750)
        with self.assertRaises(ValueError):
            c.apply_coupon("FREE")
'''}, target=("cart.py", ["Cart.apply_coupon"]))

CONFIG_PY = '''
import json
import os


def load(path):
    with open(path) as f:
        return json.load(f)


def get(cfg, dotted, default=None):
    cur = cfg
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def save(cfg, path):
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
'''
task("e04_tilde", "edit",
     "config.load should accept paths starting with `~` (expand to the user's home directory). Only change load in config.py.",
     {"config.py": CONFIG_PY, "tests/__init__.py": "", "tests/test_config.py": '''
import json, os, tempfile, unittest
from config import load, get, save
class T(unittest.TestCase):
    def test(self):
        d = tempfile.mkdtemp(dir=".")
        p = os.path.join(d, "c.json"); save({"a": {"b": 1}}, p)
        self.assertEqual(get(load(p), "a.b"), 1)
        self.assertEqual(get({}, "x.y", 3), 3)
'''}, {"tests/test_hidden_e04.py": '''
import json, os, unittest
from config import load
class H(unittest.TestCase):
    def test(self):
        home = os.path.abspath("fakehome"); os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "c.json"), "w") as f: json.dump({"k": 2}, f)
        old = os.environ.get("HOME"); os.environ["HOME"] = home
        try:
            self.assertEqual(load("~/c.json"), {"k": 2})
        finally:
            if old is not None: os.environ["HOME"] = old
'''}, target=("config.py", ["load"]))

SHAPES_PY = '''
import math


class Circle:
    def __init__(self, r):
        self.r = r

    def area(self):
        return math.pi * self.r ** 2


class Rectangle:
    def __init__(self, w, h):
        self.w = w
        self.h = h

    def area(self):
        return self.w * self.h


class Square(Rectangle):
    def __init__(self, side):
        super().__init__(side, side)
'''
task("e05_perimeter", "edit",
     "Add a perimeter() method to Rectangle in shapes.py (Square should get it through inheritance). Only touch Rectangle.",
     {"shapes.py": SHAPES_PY, "tests/__init__.py": "", "tests/test_shapes.py": '''
import unittest
from shapes import Circle, Rectangle, Square
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(Rectangle(2, 3).area(), 6)
        self.assertEqual(Square(2).area(), 4)
'''}, {"tests/test_hidden_e05.py": '''
import unittest
from shapes import Rectangle, Square, Circle
class H(unittest.TestCase):
    def test(self):
        self.assertEqual(Rectangle(2, 3).perimeter(), 10)
        self.assertEqual(Square(5).perimeter(), 20)
        self.assertFalse(hasattr(Circle(1), "perimeter"))
'''}, target=("shapes.py", ["Rectangle.perimeter"]))

FMT_PY = '''
def format_bytes(n):
    """Decimal units: 1500 -> '1.5 kB'."""
    for unit in ["B", "kB", "MB", "GB"]:
        if abs(n) < 1000 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000


def format_duration(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02}:{s:02}" if h else f"{m}:{s:02}"
'''
task("e06_binary_units", "edit",
     "Add a keyword argument `binary=False` to format_bytes in formatting.py. When True it uses powers of 1024 and the units B, KiB, MiB, GiB. "
     "Default behaviour must stay exactly the same, and don't change format_duration.",
     {"formatting.py": FMT_PY, "tests/__init__.py": "", "tests/test_formatting.py": '''
import unittest
from formatting import format_bytes, format_duration
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(format_bytes(1500), "1.5 kB")
        self.assertEqual(format_bytes(12), "12 B")
        self.assertEqual(format_duration(3725), "1:02:05")
'''}, {"tests/test_hidden_e06.py": '''
import unittest
from formatting import format_bytes
class H(unittest.TestCase):
    def test(self):
        self.assertEqual(format_bytes(1536, binary=True), "1.5 KiB")
        self.assertEqual(format_bytes(1024 ** 2 * 3, binary=True), "3.0 MiB")
        self.assertEqual(format_bytes(100, binary=True), "100 B")
        self.assertEqual(format_bytes(2500000), "2.5 MB")
'''}, target=("formatting.py", ["format_bytes"]))

PQ_PY = '''
import heapq
import itertools


class PriorityQueue:
    def __init__(self):
        self._h = []
        self._c = itertools.count()

    def push(self, item, priority):
        heapq.heappush(self._h, (priority, next(self._c), item))

    def pop(self):
        return heapq.heappop(self._h)[2]

    def peek(self):
        return self._h[0][2] if self._h else None

    def __len__(self):
        return len(self._h)
'''
task("e07_pop_empty", "edit",
     "PriorityQueue.pop() in pq.py raises IndexError when the queue is empty; make it return None instead. Change nothing else.",
     {"pq.py": PQ_PY, "tests/__init__.py": "", "tests/test_pq.py": '''
import unittest
from pq import PriorityQueue
class T(unittest.TestCase):
    def test(self):
        q = PriorityQueue(); q.push("b", 2); q.push("a", 1)
        self.assertEqual(q.pop(), "a"); self.assertEqual(q.peek(), "b"); self.assertEqual(len(q), 1)
'''}, {"tests/test_hidden_e07.py": '''
import unittest
from pq import PriorityQueue
class H(unittest.TestCase):
    def test(self):
        q = PriorityQueue()
        self.assertIsNone(q.pop())
        q.push(0, 1); self.assertEqual(q.pop(), 0); self.assertIsNone(q.pop())
'''}, target=("pq.py", ["PriorityQueue.pop"]))

USERS_PY = '''
import re

EMAIL = re.compile(r"^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$")


def normalize_email(email):
    return email.lower()


def is_valid_email(email):
    return bool(EMAIL.match(normalize_email(email)))


def display_name(first, last):
    return f"{first.strip().title()} {last.strip().title()}".strip()
'''
task("e08_email_strip", "edit",
     "normalize_email in users.py should also strip surrounding whitespace. Only modify normalize_email.",
     {"users.py": USERS_PY, "tests/__init__.py": "", "tests/test_users.py": '''
import unittest
from users import normalize_email, is_valid_email, display_name
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(normalize_email("A@B.com"), "a@b.com")
        self.assertTrue(is_valid_email("x@y.io"))
        self.assertEqual(display_name(" ada ", "lovelace"), "Ada Lovelace")
'''}, {"tests/test_hidden_e08.py": '''
import unittest
from users import normalize_email, is_valid_email
class H(unittest.TestCase):
    def test(self):
        self.assertEqual(normalize_email("  A@B.com\\n"), "a@b.com")
        self.assertTrue(is_valid_email(" x@y.io "))
'''}, target=("users.py", ["normalize_email"]))

KV_PY = '''
def parse_kv(line):
    """'a=1 b=2' -> {'a': '1', 'b': '2'}"""
    out = {}
    for part in line.split():
        k, v = part.split("=", 1)
        out[k] = v
    return out


def dump_kv(d):
    return " ".join(f"{k}={v}" for k, v in d.items())
'''
task("e09_quoted", "edit",
     "parse_kv in kv.py should support double-quoted values, which may contain spaces and '=' (e.g. `a=\"x = 1\" b=2` -> {'a': 'x = 1', 'b': '2'}). "
     "Quotes are not part of the value. Only change parse_kv.",
     {"kv.py": KV_PY, "tests/__init__.py": "", "tests/test_kv.py": '''
import unittest
from kv import parse_kv, dump_kv
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(parse_kv("a=1 b=2"), {"a": "1", "b": "2"})
        self.assertEqual(dump_kv({"a": 1}), "a=1")
'''}, {"tests/test_hidden_e09.py": '''
import unittest
from kv import parse_kv
class H(unittest.TestCase):
    def test(self):
        self.assertEqual(parse_kv('a="x = 1" b=2'), {"a": "x = 1", "b": "2"})
        self.assertEqual(parse_kv('msg="hello world"'), {"msg": "hello world"})
        self.assertEqual(parse_kv('e="" f=3'), {"e": "", "f": "3"})
        self.assertEqual(parse_kv("k=v=w"), {"k": "v=w"})
'''}, target=("kv.py", ["parse_kv"]))

TIME_PY = '''
def humanize(seconds):
    """5 -> '5s', 125 -> '2m 5s', 3725 -> '1h 2m 5s'."""
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if h:
        parts.append(f"{h}h")
    if m:
        parts.append(f"{m}m")
    if s or not parts:
        parts.append(f"{s}s")
    return " ".join(parts)


def parse_hms(text):
    h, m, s = (int(x) for x in text.split(":"))
    return h * 3600 + m * 60 + s
'''
task("e10_days", "edit",
     "humanize in timeutil.py should show days for durations of a day or more, e.g. 90061 -> '1d 1h 1m 1s'. Only modify humanize.",
     {"timeutil.py": TIME_PY, "tests/__init__.py": "", "tests/test_timeutil.py": '''
import unittest
from timeutil import humanize, parse_hms
class T(unittest.TestCase):
    def test(self):
        self.assertEqual(humanize(3725), "1h 2m 5s")
        self.assertEqual(humanize(0), "0s")
        self.assertEqual(parse_hms("01:00:05"), 3605)
'''}, {"tests/test_hidden_e10.py": '''
import unittest
from timeutil import humanize
class H(unittest.TestCase):
    def test(self):
        self.assertEqual(humanize(90061), "1d 1h 1m 1s")
        self.assertEqual(humanize(86400), "1d")
        self.assertEqual(humanize(172800 + 5), "2d 5s")
        self.assertEqual(humanize(59), "59s")
'''}, target=("timeutil.py", ["humanize"]))


# ---------------------------------------------------------------- 判分

def load():
    return T


def setup(t, root):
    for p, c in t["files"].items():
        full = os.path.join(root, p)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(c.lstrip("\n"))


def _h(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest() if os.path.exists(path) else None


def _defs(src):
    """{'func' / 'Class.method' / 'Class': ast dump}；类本身只比较除方法外的部分。"""
    tree = ast.parse(src)
    out = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out[node.name] = ast.dump(node)
        elif isinstance(node, ast.ClassDef):
            rest = []
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    out[f"{node.name}.{sub.name}"] = ast.dump(sub)
                else:
                    rest.append(ast.dump(sub))
            out[node.name] = "|".join(rest)
        else:
            out.setdefault("<module>", "")
            out["<module>"] += ast.dump(node)
    return out


def grade(t, root, sandbox_run):
    """sandbox_run(cmd) -> (stdout, rc)。返回判分 dict。"""
    res = {}
    # 原有文件有没有被改
    changed = []
    for p, c in t["files"].items():
        full = os.path.join(root, p)
        if not os.path.exists(full):
            changed.append(p + " (deleted)")
        elif open(full).read() != c.lstrip("\n"):
            changed.append(p)
    res["changed_files"] = changed
    tests_touched = [p for p in changed if p.startswith("tests/")]
    res["tests_touched"] = tests_touched
    # 隐藏测试放进去，跑全部
    for p, c in t["hidden"].items():
        with open(os.path.join(root, p), "w") as f:
            f.write(c.lstrip("\n"))
    # 可见测试按原文件跑，防止模型改测试蒙混
    for p in tests_touched:
        if not p.endswith("(deleted)"):
            with open(os.path.join(root, p), "w") as f:
                f.write(t["files"][p].lstrip("\n"))
    out, rc = sandbox_run("python3 -m unittest discover -s tests -t . 2>&1 | tail -15")
    res["tests_pass"] = "OK" in out.split("\n")[-3:] or out.rstrip().endswith("OK")
    res["test_tail"] = out[-600:]
    if t["kind"] == "edit":
        fname, allowed = t["target"]
        before = _defs(t["files"][fname].lstrip("\n"))
        try:
            after = _defs(open(os.path.join(root, fname)).read())
        except SyntaxError:
            after = {}
        violations = []
        for k, v in before.items():
            if k in allowed:
                continue
            if after.get(k) != v:
                violations.append(k)
        for k in after:
            if k not in before and k not in allowed:
                violations.append("+" + k)
        other = [p for p in changed if p != fname and not p.startswith("tests/")]
        res["scope_violations"] = violations + other
        res["in_scope"] = not res["scope_violations"] and not tests_touched
    res["pass"] = res["tests_pass"] and not tests_touched and (t["kind"] == "bug" or res["in_scope"])
    return res
