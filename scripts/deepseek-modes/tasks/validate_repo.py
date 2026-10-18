"""校验仓库任务：原样应失败（bug）/ 原有测试应通过（edit），参考修复应全过且不越界。"""

import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t_repo as R

# (文件, 旧串, 新串)
FIX = {
    "b01_semver": [("semver.py", 'return tuple(v.strip().lstrip("v").split("."))',
                    'return tuple(int(x) for x in v.strip().lstrip("v").split("."))')],
    "b02_split_bill": [("billing.py", """    share = total_cents / people
    base = int(share)
    extra = round((share - base) * people)
    return [base + (1 if i < extra - 1 else 0) for i in range(people)]""",
                        """    base, extra = divmod(total_cents, people)
    return [base + (1 if i < extra else 0) for i in range(people)]""")],
    "b03_lru": [("cache.py", """            return default
        return self.data[key]""", """            return default
        self.data.move_to_end(key)
        return self.data[key]""")],
    "b04_months": [("dates.py", "    return DAYS[month - 1]",
                    "    import calendar\n    return calendar.monthrange(year, month)[1]")],
    "b05_tokenizer": [("lexer.py", 'OPS = ["<", ">", "=", "!", "<=", ">=", "==", "!=",',
                       'OPS = ["<=", ">=", "==", "!=", "<", ">", "=", "!",')],
    "b06_report": [("report.py", "        acc += int(r[\"amount\"])\n    return out",
                    "        acc += int(r[\"amount\"])\n    if current is not None:\n        out.append((current, acc))\n    return out")],
    "b07_bucket": [("ratelimit.py", "int(elapsed) * self.rate", "elapsed * self.rate")],
    "b08_wrap": [("wrap.py", "len(cur) + len(word) <= width", "len(cur) + 1 + len(word) <= width")],
    "b09_dijkstra": [("graph.py", "return -d", "return d"), ("graph.py", "(d - w, v)", "(d + w, v)")],
    "b10_roman": [("roman.py", ' and ch == "I":', ":")],
    "b11_inventory": [("inventory/config.py", 'LOW_STOCK = os.environ.get("LOW_STOCK", "5")',
                       'LOW_STOCK = int(os.environ.get("LOW_STOCK", "5"))')],
    "b12_matrix": [("matrix.py", "[[m[j][i] for j in range(len(m[0]))] for i in range(len(m))]",
                    "[[m[j][i] for j in range(len(m))] for i in range(len(m[0]))]")],
    "b13_schedule": [("schedule.py", "start <= e[1] and e[0] <= end", "start < e[1] and e[0] < end")],
    "b14_slug": [("slug.py", '    s = s.lower()\n    s = re.sub(r"[^a-z0-9]", "-", s)\n    s = re.sub(r"-+", "-", s)\n    return s',
                  '    s = s.encode("ascii", "ignore").decode().lower()\n    s = re.sub(r"[^a-z0-9]+", "-", s)\n    return s.strip("-")')],
    "b15_paginate": [("pages.py", "    return n_items // per_page + 1", "    return -(-n_items // per_page)")],
    "e01_slug_sep": [("text.py", 'def slugify(title):\n    s = re.sub(r"[^a-z0-9]+", "-", title.lower())\n    return s.strip("-")',
                      'def slugify(title, sep="-"):\n    s = re.sub(r"[^a-z0-9]+", sep, title.lower())\n    return s.strip(sep)')],
    "e02_mean_empty": [("stats.py", "def mean(xs):\n    return", 'def mean(xs):\n    if not xs:\n        raise ValueError("mean of empty data")\n    return')],
    "e03_coupon": [("cart.py", "    def total(self):", '    def apply_coupon(self, code):\n        rates = {"SAVE10": 0.10, "SAVE25": 0.25}\n        if code not in rates:\n            raise ValueError(code)\n        self.discount = rates[code]\n\n    def total(self):')],
    "e04_tilde": [("config.py", "    with open(path) as f:\n        return json.load(f)",
                   "    with open(os.path.expanduser(path)) as f:\n        return json.load(f)")],
    "e05_perimeter": [("shapes.py", "        return self.w * self.h\n", "        return self.w * self.h\n\n    def perimeter(self):\n        return 2 * (self.w + self.h)\n")],
    "e06_binary_units": [("formatting.py", '''def format_bytes(n):
    """Decimal units: 1500 -> '1.5 kB'."""
    for unit in ["B", "kB", "MB", "GB"]:
        if abs(n) < 1000 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000''', '''def format_bytes(n, binary=False):
    """Decimal units: 1500 -> '1.5 kB'."""
    base = 1024 if binary else 1000
    units = ["B", "KiB", "MiB", "GiB"] if binary else ["B", "kB", "MB", "GB"]
    for unit in units:
        if abs(n) < base or unit == units[-1]:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= base''')],
    "e07_pop_empty": [("pq.py", "    def pop(self):\n        return", "    def pop(self):\n        if not self._h:\n            return None\n        return")],
    "e08_email_strip": [("users.py", "    return email.lower()", "    return email.strip().lower()")],
    "e09_quoted": [("kv.py", '''    out = {}
    for part in line.split():
        k, v = part.split("=", 1)
        out[k] = v
    return out''', '''    import shlex
    out = {}
    for part in shlex.split(line):
        k, v = part.split("=", 1)
        out[k] = v
    return out''')],
    "e10_days": [("timeutil.py", '''    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if h:''', '''    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if d:
        parts.append(f"{d}d")
    if h:''')],
}


def run_in(root):
    def f(cmd):
        p = subprocess.run(["/bin/bash", "-c", cmd], cwd=root, capture_output=True, text=True, timeout=60)
        return p.stdout + p.stderr, p.returncode
    return f


def main():
    bad = 0
    for t in R.load():
        d = tempfile.mkdtemp()
        R.setup(t, d)
        out, _ = run_in(d)("python3 -m unittest discover -s tests -t . 2>&1 | tail -3")
        orig_ok = out.rstrip().endswith("OK")
        for fn, old, new in FIX[t["id"]]:
            p = os.path.join(d, fn)
            s = open(p).read()
            assert s.count(old) == 1, (t["id"], fn, old[:40])
            open(p, "w").write(s.replace(old, new))
        g = R.grade(t, d, run_in(d))
        want_orig = t["kind"] == "edit"
        ok = g["pass"] and orig_ok == want_orig
        bad += not ok
        print(f"{t['id']:18} orig_visible_ok={orig_ok!s:5} fixed_pass={g['pass']!s:5} "
              f"{'scope=' + str(g.get('scope_violations')) if t['kind'] == 'edit' else ''} {'' if ok else '<<< 有问题 ' + g['test_tail'][-300:]}")
        shutil.rmtree(d)
    print("问题数", bad)


if __name__ == "__main__":
    main()
