"""E3 算法代码题：模型在 solution.py 里实现函数，用参考实现对拍随机输入判分。"""

import bisect
import heapq
import json
import random
from collections import OrderedDict, deque
from functools import lru_cache

MOD = 10 ** 9 + 7


def r_str(rng, alpha, lo, hi):
    return "".join(rng.choice(alpha) for _ in range(rng.randint(lo, hi)))


def r_list(rng, lo, hi, vlo, vhi):
    return [rng.randint(vlo, vhi) for _ in range(rng.randint(lo, hi))]


# ---------- 参考实现 ----------

def longest_k_distinct(s, k):
    best = 0
    for i in range(len(s)):
        seen = set()
        for j in range(i, len(s)):
            seen.add(s[j])
            if len(seen) > k:
                break
            best = max(best, j - i + 1)
    return best


def min_window(s, t):
    from collections import Counter
    need = Counter(t)
    best = None
    for i in range(len(s)):
        c = Counter()
        for j in range(i, len(s)):
            c[s[j]] += 1
            if all(c[x] >= need[x] for x in need):
                if best is None or j - i + 1 < len(best):
                    best = s[i:j + 1]
                break
    return best or ""


def count_inversions(a):
    return sum(1 for i in range(len(a)) for j in range(i + 1, len(a)) if a[i] > a[j])


def lis_length(a):
    tails = []
    for x in a:
        i = bisect.bisect_left(tails, x)
        tails[i:i + 1] = [x]
    return len(tails)


def edit_distance(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
    return d[-1]


def num_islands(grid):
    g = [list(r) for r in grid]
    n = 0
    for i in range(len(g)):
        for j in range(len(g[0]) if g else 0):
            if g[i][j] == "1":
                n += 1
                st = [(i, j)]
                g[i][j] = "0"
                while st:
                    x, y = st.pop()
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        u, v = x + dx, y + dy
                        if 0 <= u < len(g) and 0 <= v < len(g[0]) and g[u][v] == "1":
                            g[u][v] = "0"
                            st.append((u, v))
    return n


def merge_intervals(iv):
    out = []
    for s, e in sorted(iv):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def kth_smallest_pair_distance(nums, k):
    d = sorted(abs(nums[i] - nums[j]) for i in range(len(nums)) for j in range(i + 1, len(nums)))
    return d[k - 1]


def trap_rain_water(h):
    return sum(max(0, min(max(h[:i + 1]), max(h[i:])) - h[i]) for i in range(len(h)))


def largest_rectangle(h):
    return max([min(h[i:j + 1]) * (j - i + 1) for i in range(len(h)) for j in range(i, len(h))] or [0])


def word_break_count(s, words):
    ws = set(words)

    @lru_cache(None)
    def f(i):
        if i == len(s):
            return 1
        return sum(f(j) for j in range(i + 1, len(s) + 1) if s[i:j] in ws)
    return f(0)


def shortest_path_grid(grid):
    R, C = len(grid), len(grid[0])
    if grid[0][0] == "#" or grid[R - 1][C - 1] == "#":
        return -1
    dist = {(0, 0): 0}
    q = deque([(0, 0)])
    while q:
        x, y = q.popleft()
        if (x, y) == (R - 1, C - 1):
            return dist[(x, y)]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            u, v = x + dx, y + dy
            if 0 <= u < R and 0 <= v < C and grid[u][v] != "#" and (u, v) not in dist:
                dist[(u, v)] = dist[(x, y)] + 1
                q.append((u, v))
    return -1


def decode_ways(s):
    n = len(s)
    f = [0] * (n + 2)
    f[n] = 1
    for i in range(n - 1, -1, -1):
        if s[i] == "0":
            f[i] = 0
            continue
        f[i] = f[i + 1]
        if i + 1 < n and 10 <= int(s[i:i + 2]) <= 26:
            f[i] += f[i + 2]
        f[i] %= MOD
    return f[0] % MOD


def next_permutation(a):
    a = list(a)
    i = len(a) - 2
    while i >= 0 and a[i] >= a[i + 1]:
        i -= 1
    if i < 0:
        return sorted(a)
    j = len(a) - 1
    while a[j] <= a[i]:
        j -= 1
    a[i], a[j] = a[j], a[i]
    a[i + 1:] = reversed(a[i + 1:])
    return a


def evaluate(expr):
    toks = []
    i = 0
    while i < len(expr):
        c = expr[i]
        if c.isdigit():
            j = i
            while j < len(expr) and expr[j].isdigit():
                j += 1
            toks.append(int(expr[i:j]))
            i = j
        elif c in "+-*/()":
            toks.append(c)
            i += 1
        else:
            i += 1
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def eat():
        pos[0] += 1
        return toks[pos[0] - 1]

    def atom():
        t = eat()
        if t == "(":
            v = add()
            eat()
            return v
        if t == "-":
            return -atom()
        return t

    def mul():
        v = atom()
        while peek() in ("*", "/"):
            op = eat()
            w = atom()
            v = v * w if op == "*" else int(v / w)
        return v

    def add():
        v = mul()
        while peek() in ("+", "-"):
            op = eat()
            w = mul()
            v = v + w if op == "+" else v - w
        return v
    return add()


def int_to_roman(n):
    out = ""
    for v, s in ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"),
                 (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= v:
            out += s
            n -= v
    return out


def max_subarray_circular(a):
    n = len(a)
    return max(sum(a[(i + k) % n] for k in range(L)) for i in range(n) for L in range(1, n + 1))


def count_subarrays_sum_k(a, k):
    return sum(1 for i in range(len(a)) for j in range(i, len(a)) if sum(a[i:j + 1]) == k)


def topo_lex(n, edges):
    indeg = [0] * n
    adj = [[] for _ in range(n)]
    for u, v in edges:
        adj[u].append(v)
        indeg[v] += 1
    h = [i for i in range(n) if indeg[i] == 0]
    heapq.heapify(h)
    out = []
    while h:
        u = heapq.heappop(h)
        out.append(u)
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                heapq.heappush(h, v)
    return out if len(out) == n else []


def dijkstra(n, edges, src):
    adj = [[] for _ in range(n)]
    for u, v, w in edges:
        adj[u].append((v, w))
        adj[v].append((u, w))
    dist = [-1] * n
    h = [(0, src)]
    while h:
        d, u = heapq.heappop(h)
        if dist[u] != -1:
            continue
        dist[u] = d
        for v, w in adj[u]:
            if dist[v] == -1:
                heapq.heappush(h, (d + w, v))
    return dist


def lru_misses(capacity, accesses):
    c = OrderedDict()
    m = 0
    for x in accesses:
        if x in c:
            c.move_to_end(x)
        else:
            m += 1
            if capacity == 0:
                continue
            if len(c) >= capacity:
                c.popitem(last=False)
            c[x] = 1
    return m


def sliding_window_max(a, k):
    return [max(a[i:i + k]) for i in range(len(a) - k + 1)]


def lower_medians(a):
    return [sorted(a[:i + 1])[i // 2] for i in range(len(a))]


def coin_change_min(coins, amount):
    INF = float("inf")
    d = [0] + [INF] * amount
    for x in range(1, amount + 1):
        for c in coins:
            if c <= x and d[x - c] + 1 < d[x]:
                d[x] = d[x - c] + 1
    return -1 if d[amount] == INF else d[amount]


def can_partition(a):
    s = sum(a)
    if s % 2:
        return False
    reach = {0}
    for x in a:
        reach |= {r + x for r in reach}
    return s // 2 in reach


def longest_palindrome_len(s):
    return max([j - i for i in range(len(s)) for j in range(i + 1, len(s) + 1) if s[i:j] == s[i:j][::-1]] or [0])


def num_distinct_subseq(s, t):
    d = [1] + [0] * len(t)
    for ch in s:
        for j in range(len(t), 0, -1):
            if t[j - 1] == ch:
                d[j] = (d[j] + d[j - 1]) % MOD
    return d[len(t)]


def regex_match(s, p):
    import re
    return re.fullmatch(p, s) is not None


def wildcard_match(s, p):
    @lru_cache(None)
    def f(i, j):
        if j == len(p):
            return i == len(s)
        if p[j] == "*":
            return f(i, j + 1) or (i < len(s) and f(i + 1, j))
        return i < len(s) and p[j] in (s[i], "?") and f(i + 1, j + 1)
    return f(0, 0)


def is_bipartite(n, edges):
    color = [-1] * n
    adj = [[] for _ in range(n)]
    for u, v in edges:
        adj[u].append(v)
        adj[v].append(u)
    for s in range(n):
        if color[s] != -1:
            continue
        color[s] = 0
        q = deque([s])
        while q:
            u = q.popleft()
            for v in adj[u]:
                if color[v] == -1:
                    color[v] = 1 - color[u]
                    q.append(v)
                elif color[v] == color[u]:
                    return False
    return True


# ---------- 生成器 ----------

def _grid(rng, ch):
    R, C = rng.randint(1, 8), rng.randint(1, 8)
    return ["".join(rng.choice(ch) for _ in range(C)) for _ in range(R)]


def _regex_pat(rng):
    p = ""
    for _ in range(rng.randint(0, 6)):
        p += rng.choice("ab.")
        if rng.random() < 0.4:
            p += "*"
    return p


def _expr(rng, depth=0):
    if depth > 2 or rng.random() < 0.3:
        return str(rng.randint(1, 30))
    op = rng.choice("+-*/")
    a, b = _expr(rng, depth + 1), _expr(rng, depth + 1)
    if op == "/":
        b = str(rng.randint(1, 9))
    e = f"{a} {op} {b}"
    return f"({e})" if rng.random() < 0.5 else e


def _graph(rng, directed=False, weighted=False):
    n = rng.randint(1, 9)
    edges = []
    for _ in range(rng.randint(0, n * 2)):
        u, v = rng.randrange(n), rng.randrange(n)
        if u == v:
            continue
        if directed and rng.random() < 0.7 and u > v:
            u, v = v, u
        edges.append([u, v, rng.randint(1, 20)] if weighted else [u, v])
    return n, edges


TASKS = [
    ("longest_k_distinct", "longest_k_distinct(s: str, k: int) -> int: length of the longest substring of s containing at most k distinct characters (k >= 0).",
     longest_k_distinct, lambda r: [r_str(r, "abc", 0, 14), r.randint(0, 3)]),
    ("min_window", "min_window(s: str, t: str) -> str: the shortest substring of s that contains every character of t with multiplicity; if several have the same length return the leftmost; return \"\" if none. t is non-empty.",
     min_window, lambda r: [r_str(r, "abc", 0, 14), r_str(r, "abc", 1, 3)]),
    ("count_inversions", "count_inversions(a: list[int]) -> int: number of pairs i < j with a[i] > a[j].",
     count_inversions, lambda r: [r_list(r, 0, 30, -5, 5)]),
    ("lis_length", "lis_length(a: list[int]) -> int: length of the longest strictly increasing subsequence.",
     lis_length, lambda r: [r_list(r, 0, 25, 0, 10)]),
    ("edit_distance", "edit_distance(a: str, b: str) -> int: Levenshtein distance (insert, delete, substitute each cost 1).",
     edit_distance, lambda r: [r_str(r, "abc", 0, 9), r_str(r, "abc", 0, 9)]),
    ("num_islands", "num_islands(grid: list[str]) -> int: grid rows are strings of '1' (land) and '0' (water); count 4-directionally connected land components.",
     num_islands, lambda r: [_grid(r, "01")]),
    ("merge_intervals", "merge_intervals(iv: list[list[int]]) -> list[list[int]]: merge overlapping closed intervals [s, e] (touching intervals like [1,2],[2,3] merge); return them sorted by start.",
     merge_intervals, lambda r: [[sorted([r.randint(0, 20), r.randint(0, 20)]) for _ in range(r.randint(0, 8))]]),
    ("kth_smallest_pair_distance", "kth_smallest_pair_distance(nums: list[int], k: int) -> int: among all pairs i < j, the k-th smallest value of |nums[i] - nums[j]| (1-indexed). len(nums) >= 2 and 1 <= k <= number of pairs.",
     kth_smallest_pair_distance, None),
    ("trap_rain_water", "trap_rain_water(h: list[int]) -> int: total water trapped by the elevation map h (classic rain water problem).",
     trap_rain_water, lambda r: [r_list(r, 0, 20, 0, 6)]),
    ("largest_rectangle", "largest_rectangle(h: list[int]) -> int: area of the largest rectangle in a histogram with bar heights h (0 for empty input).",
     largest_rectangle, lambda r: [r_list(r, 0, 15, 0, 8)]),
    ("word_break_count", "word_break_count(s: str, words: list[str]) -> int: number of ways to split s into a sequence of words from the list (words may repeat; the empty string has 1 way).",
     word_break_count, lambda r: [r_str(r, "ab", 0, 14), list({r_str(r, "ab", 1, 3) for _ in range(5)})]),
    ("shortest_path_grid", "shortest_path_grid(grid: list[str]) -> int: '.' is open and '#' is a wall; the minimum number of 4-directional steps from the top-left cell to the bottom-right cell, or -1 if impossible (including when either endpoint is a wall).",
     shortest_path_grid, lambda r: [_grid(r, "..#")]),
    ("decode_ways", "decode_ways(s: str) -> int: number of ways to decode a digit string where 'A'..'Z' map to '1'..'26' (no leading-zero codes), modulo 1_000_000_007. Empty string -> 1.",
     decode_ways, lambda r: [r_str(r, "0112226", 0, 30)]),
    ("next_permutation", "next_permutation(a: list[int]) -> list[int]: the next lexicographic permutation of a (a may contain duplicates); if a is the last permutation, return it sorted ascending. Do not mutate the input.",
     next_permutation, lambda r: [r_list(r, 0, 7, 0, 3)]),
    ("evaluate", "evaluate(expr: str) -> int: evaluate an integer expression with + - * / and parentheses and spaces, standard precedence, left-associative; '/' is integer division truncating toward zero. Divisors are never zero.",
     evaluate, lambda r: [_expr(r)]),
    ("int_to_roman", "int_to_roman(n: int) -> str: standard Roman numeral for 1 <= n <= 3999 (subtractive forms like IV, IX, XL, XC, CD, CM).",
     int_to_roman, lambda r: [r.randint(1, 3999)]),
    ("max_subarray_circular", "max_subarray_circular(a: list[int]) -> int: maximum sum of a non-empty contiguous subarray of the circular array a (len(a) >= 1; each element used at most once).",
     max_subarray_circular, lambda r: [r_list(r, 1, 12, -10, 10)]),
    ("count_subarrays_sum_k", "count_subarrays_sum_k(a: list[int], k: int) -> int: number of non-empty contiguous subarrays whose sum equals k (values may be negative).",
     count_subarrays_sum_k, lambda r: [r_list(r, 0, 20, -3, 3), r.randint(-3, 3)]),
    ("topo_lex", "topo_lex(n: int, edges: list[list[int]]) -> list[int]: nodes 0..n-1, directed edges [u, v] meaning u before v; return the lexicographically smallest topological order, or [] if there is a cycle.",
     topo_lex, lambda r: list(_graph(r, directed=True))),
    ("dijkstra", "dijkstra(n: int, edges: list[list[int]], src: int) -> list[int]: undirected weighted edges [u, v, w] with w > 0 (parallel edges allowed); return shortest distances from src to every node, -1 for unreachable.",
     dijkstra, None),
    ("lru_misses", "lru_misses(capacity: int, accesses: list[int]) -> int: simulate an LRU cache of the given capacity (capacity may be 0) over the access sequence and return the number of misses.",
     lru_misses, lambda r: [r.randint(0, 4), r_list(r, 0, 30, 0, 6)]),
    ("sliding_window_max", "sliding_window_max(a: list[int], k: int) -> list[int]: the maximum of each window of size k (1 <= k <= len(a)).",
     sliding_window_max, None),
    ("lower_medians", "lower_medians(a: list[int]) -> list[int]: for each prefix a[:i+1], the lower median (the element at index i//2 of the sorted prefix).",
     lower_medians, lambda r: [r_list(r, 0, 20, -10, 10)]),
    ("coin_change_min", "coin_change_min(coins: list[int], amount: int) -> int: fewest coins (unlimited supply, positive denominations) summing to amount, or -1 if impossible; amount 0 -> 0.",
     coin_change_min, lambda r: [list({r.randint(1, 12) for _ in range(r.randint(1, 4))}), r.randint(0, 60)]),
    ("can_partition", "can_partition(a: list[int]) -> bool: whether the non-negative integers in a can be split into two multisets with equal sums (empty input -> True).",
     can_partition, lambda r: [r_list(r, 0, 10, 0, 15)]),
    ("longest_palindrome_len", "longest_palindrome_len(s: str) -> int: length of the longest palindromic substring (0 for empty).",
     longest_palindrome_len, lambda r: [r_str(r, "ab", 0, 16)]),
    ("num_distinct_subseq", "num_distinct_subseq(s: str, t: str) -> int: number of distinct index subsequences of s that equal t, modulo 1_000_000_007 (t may be empty -> 1).",
     num_distinct_subseq, lambda r: [r_str(r, "ab", 0, 16), r_str(r, "ab", 0, 4)]),
    ("regex_match", "regex_match(s: str, p: str) -> bool: full match where p contains letters, '.' (any single char) and '*' (zero or more of the preceding element); p is always well-formed. Do not use the re module.",
     regex_match, lambda r: [r_str(r, "ab", 0, 7), _regex_pat(r)]),
    ("wildcard_match", "wildcard_match(s: str, p: str) -> bool: full match where '?' matches any single char and '*' matches any sequence (including empty).",
     wildcard_match, lambda r: [r_str(r, "ab", 0, 8), r_str(r, "ab?*", 0, 6)]),
    ("is_bipartite", "is_bipartite(n: int, edges: list[list[int]]) -> bool: whether the undirected graph on nodes 0..n-1 is bipartite.",
     is_bipartite, lambda r: list(_graph(r))),
]


def _gen_kth(r):
    nums = r_list(r, 2, 10, 0, 20)
    return [nums, r.randint(1, len(nums) * (len(nums) - 1) // 2)]


def _gen_dij(r):
    n, e = _graph(r, weighted=True)
    return [n, e, r.randrange(n)]


def _gen_swm(r):
    a = r_list(r, 1, 15, -9, 9)
    return [a, r.randint(1, len(a))]


GEN_FIX = {"kth_smallest_pair_distance": _gen_kth, "dijkstra": _gen_dij, "sliding_window_max": _gen_swm}


def load():
    out = []
    for name, spec, ref, gen in TASKS:
        gen = gen or GEN_FIX[name]
        rng = random.Random(name)
        cases = []
        for _ in range(150):
            args = gen(rng)
            cases.append({"args": args, "expect": ref(*json.loads(json.dumps(args)))})
        out.append({"id": "c_" + name, "func": name, "spec": spec, "cases": cases})
    return out


def prompt(t):
    return (f"Implement this Python function in a file named solution.py in the working directory:\n\n"
            f"{t['spec']}\n\nUse only the standard library. Make sure it is correct on edge cases.")


CHECKER = r'''
import json, sys
sys.setrecursionlimit(10000)
cases = json.load(open(sys.argv[2]))
try:
    import solution
    f = getattr(solution, sys.argv[1])
except Exception as e:
    print(json.dumps({"pass": 0, "total": len(cases), "error": "import: " + repr(e)[:200]})); sys.exit()
ok = 0; first_fail = None
for c in cases:
    try:
        got = f(*c["args"])
        if isinstance(got, tuple): got = list(got)
        if got == c["expect"]: ok += 1
        elif first_fail is None: first_fail = {"args": c["args"], "expect": c["expect"], "got": repr(got)[:200]}
    except Exception as e:
        if first_fail is None: first_fail = {"args": c["args"], "error": repr(e)[:200]}
print(json.dumps({"pass": ok, "total": len(cases), "first_fail": first_fail}))
'''


if __name__ == "__main__":
    for t in load():
        print(t["id"], t["cases"][0])
