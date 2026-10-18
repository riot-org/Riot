"""E3 数学题。每题的答案由暴力程序算出，不靠记忆。

`python3 -I tasks/t_math.py` 打印全部答案用于自查。
"""

import itertools
import math
from fractions import Fraction
from functools import lru_cache


def _digsum(n):
    return sum(map(int, str(n)))


def _ndiv(n):
    c, i = 0, 1
    while i * i <= n:
        if n % i == 0:
            c += 1 if i * i == n else 2
        i += 1
    return c


def _isprime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True


def _phi(n):
    return sum(1 for k in range(1, n + 1) if math.gcd(k, n) == 1)


def _m2():
    # (0,0)->(8,8)，不碰 (k,k)，1<=k<=7
    @lru_cache(None)
    def f(x, y):
        if (x, y) == (8, 8):
            return 1
        if x > 8 or y > 8 or (x == y and 0 < x < 8):
            return 0
        return f(x + 1, y) + f(x, y + 1)
    return f(0, 0)


def _m3():
    return sum(1 for p in itertools.permutations(range(1, 9))
               if all(p[i] != i + 1 and p[i] != i + 2 for i in range(8)))


def _tz(n):
    c = 0
    while n:
        n //= 5
        c += n
    return c


def _m7():
    return sum(1 for d in itertools.combinations_with_replacement(range(10), 7) if d[0] >= 1 and sum(d) == 30)


def _m11():
    a = [1, 1]
    for _ in range(11):
        a.append(a[-1] + 2 * a[-2])
    return a[12]


def _m12():
    return sum(1 for s in itertools.product("01", repeat=20)
               if "111" not in "".join(s) and "00" not in "".join(s))


def _m17():
    good = sum(1 for r in itertools.product(range(1, 7), repeat=4) if max(r) - min(r) == 3)
    fr = Fraction(good, 6 ** 4)
    return fr.numerator + fr.denominator


def _m21():
    sq = [i * i for i in range(1, 11)]
    ways = [1] + [0] * 100
    for s in sq:
        for t in range(100, s - 1, -1):
            ways[t] += ways[t - s]
    return ways[100]


def _m23():
    rows = [r for r in itertools.product((0, 1), repeat=4) if sum(r) == 2]
    return sum(1 for m in itertools.product(rows, repeat=4) if all(sum(c) == 2 for c in zip(*m)))


def _m24():
    # 3x3 网格图的生成树个数：矩阵树定理
    nodes = [(i, j) for i in range(3) for j in range(3)]
    idx = {v: k for k, v in enumerate(nodes)}
    n = len(nodes)
    L = [[Fraction(0)] * n for _ in range(n)]
    for (i, j) in nodes:
        for di, dj in ((0, 1), (1, 0)):
            a, b = (i, j), (i + di, j + dj)
            if b in idx:
                x, y = idx[a], idx[b]
                L[x][x] += 1
                L[y][y] += 1
                L[x][y] -= 1
                L[y][x] -= 1
    M = [row[1:] for row in L[1:]]
    det = Fraction(1)
    m = len(M)
    for c in range(m):
        p = next(r for r in range(c, m) if M[r][c] != 0)
        if p != c:
            M[c], M[p] = M[p], M[c]
            det = -det
        det *= M[c][c]
        for r in range(c + 1, m):
            f = M[r][c] / M[c][c]
            for k in range(c, m):
                M[r][k] -= f * M[c][k]
    return int(det)


def _m26():
    return len({min(s[i:] + s[:i] for i in range(10)) for s in itertools.product("01", repeat=10)})


def _m33():
    def solve(row, cols, d1, d2):
        if row == 6:
            return 1
        return sum(solve(row + 1, cols | {c}, d1 | {row - c}, d2 | {row + c})
                   for c in range(6) if c not in cols and row - c not in d1 and row + c not in d2)
    return solve(0, set(), set(), set())


def _m37():
    @lru_cache(None)
    def f(n, last3):
        if n == 0:
            return 1
        t = 0
        for s in (1, 2, 3):
            if s <= n and not (s == 3 and last3):
                t += f(n - s, s == 3)
        return t
    return f(15, False)


PROBLEMS = [
    ("How many positive integers n <= 10000 have digit sum 20 and are divisible by 7?",
     lambda: sum(1 for n in range(1, 10001) if _digsum(n) == 20 and n % 7 == 0)),
    ("A lattice path goes from (0,0) to (8,8) using unit steps right or up. How many such paths never pass through any of the points (k,k) for 1 <= k <= 7?", _m2),
    ("How many permutations p of {1,...,8} satisfy p(i) != i and p(i) != i+1 for every i?", _m3),
    ("What is the smallest positive integer n such that n! ends in exactly 100 zeros?",
     lambda: next(n for n in range(1, 10000) if _tz(n) == 100)),
    ("Find the sum of all positive divisors d of 10! such that d leaves remainder 1 when divided by 7.",
     lambda: sum(d for d in range(1, math.factorial(10) + 1) if math.factorial(10) % d == 0 and d % 7 == 1)),
    ("How many subsets of {1, 2, ..., 15} (including the empty set) have a sum divisible by 5?",
     lambda: sum(1 for m in range(1 << 15) if sum(i + 1 for i in range(15) if m >> i & 1) % 5 == 0)),
    ("How many 7-digit positive integers have digits in non-decreasing order (left to right) and digit sum 30?", _m7),
    ("Find the remainder when 1^1 + 2^2 + 3^3 + ... + 100^100 is divided by 1000.",
     lambda: sum(pow(k, k, 1000) for k in range(1, 101)) % 1000),
    ("How many ordered pairs of integers (x, y) satisfy x^2 + xy + y^2 = 1729?",
     lambda: sum(1 for x in range(-60, 61) for y in range(-60, 61) if x * x + x * y + y * y == 1729)),
    ("How many distinct values does floor(n/2) + floor(n/3) + floor(n/5) take as n ranges over the integers 1 to 1000?",
     lambda: len({n // 2 + n // 3 + n // 5 for n in range(1, 1001)})),
    ("In how many ways can a 2x12 board be tiled using 1x2 dominoes (in either orientation) and 2x2 squares?", _m11),
    ("How many binary strings of length 20 contain neither three consecutive 1s nor two consecutive 0s?", _m12),
    ("How many non-congruent triangles with integer side lengths have perimeter 100?",
     lambda: sum(1 for a in range(1, 100) for b in range(a, 100) for c in [100 - a - b] if c >= b and a + b > c)),
    ("What is the largest prime factor of 2^30 - 1?",
     lambda: max(p for p in range(2, 40000) if (2 ** 30 - 1) % p == 0 and _isprime(p))),
    ("How many positive integers n <= 1000 are such that both n and n+1 have exactly 4 positive divisors?",
     lambda: sum(1 for n in range(1, 1001) if _ndiv(n) == 4 and _ndiv(n + 1) == 4)),
    ("Find the sum of all positive integers n <= 500 such that Euler's totient phi(n) divides n.",
     lambda: sum(n for n in range(1, 501) if n % _phi(n) == 0)),
    ("Four fair six-sided dice are rolled. The probability that the largest value minus the smallest value equals exactly 3 is m/n in lowest terms. Find m + n.", _m17),
    ("How many 5-card hands from a standard 52-card deck contain at least one card of every suit?",
     lambda: 4 * math.comb(13, 2) * 13 ** 3),
    ("How many ordered pairs (a, b) with 1 <= a, b <= 100 satisfy gcd(a, b) = 1 and a + b prime?",
     lambda: sum(1 for a in range(1, 101) for b in range(1, 101) if math.gcd(a, b) == 1 and _isprime(a + b))),
    ("How many positive integers n <= 100000 are palindromes both in base 10 and in base 2?",
     lambda: sum(1 for n in range(1, 100001) if str(n) == str(n)[::-1] and bin(n)[2:] == bin(n)[2:][::-1])),
    ("In how many ways can 100 be written as a sum of distinct positive perfect squares (order does not matter)?", _m21),
    ("Find the remainder when sum_{k=0}^{20} k * C(20,k)^2 is divided by 1000.",
     lambda: sum(k * math.comb(20, k) ** 2 for k in range(21)) % 1000),
    ("How many 4x4 matrices with entries 0 or 1 have every row sum and every column sum equal to 2?", _m23),
    ("How many spanning trees does the 3x3 grid graph (9 vertices, 12 edges) have?", _m24),
    ("How many integers from 1 to 1000000 are perfect squares or perfect cubes but not perfect sixth powers?",
     lambda: len(({i * i for i in range(1, 1001)} | {i ** 3 for i in range(1, 101)}) - {i ** 6 for i in range(1, 11)})),
    ("How many distinct necklaces of 10 beads can be made using beads of 2 colors, where two necklaces are the same if one is a rotation of the other (reflections are distinct)?", _m26),
    ("Find the last three digits of 7^(7^7).", lambda: pow(7, 7 ** 7, 1000)),
    ("How many positive integers less than 1000 have a base-3 representation that contains no digit 2?",
     lambda: sum(1 for n in range(1, 1000) if all(d != 2 for d in _b3(n)))),
    ("How many integers from 1 to 2026 inclusive can be written as the difference of the squares of two nonnegative integers?",
     lambda: len({a * a - b * b for a in range(0, 1100) for b in range(0, a + 1) if 1 <= a * a - b * b <= 2026})),
    ("How many 3-element subsets of {1, 2, ..., 30} have their elements forming an arithmetic progression (in some order)?",
     lambda: sum(1 for a, b, c in itertools.combinations(range(1, 31), 3) if b - a == c - b)),
    ("How many ordered triples of nonnegative integers (x, y, z) satisfy x + 2y + 5z = 100?",
     lambda: sum(1 for y in range(51) for z in range(21) if 2 * y + 5 * z <= 100)),
    ("Find the sum of all two-digit primes p such that the number formed by reversing the digits of p is also prime.",
     lambda: sum(p for p in range(10, 100) if _isprime(p) and _isprime(int(str(p)[::-1])))),
    ("In how many ways can 6 non-attacking queens be placed on a 6x6 chessboard?", _m33),
    ("What is the smallest integer n > 1 such that 1^2 + 2^2 + ... + n^2 is a perfect square?",
     lambda: next(n for n in range(2, 1000) if math.isqrt(n * (n + 1) * (2 * n + 1) // 6) ** 2 == n * (n + 1) * (2 * n + 1) // 6)),
    ("How many composite numbers n <= 10000 satisfy that n divides 2^n - 2?",
     lambda: sum(1 for n in range(4, 10001) if not _isprime(n) and pow(2, n, n) == 2 % n)),
    ("How many ordered quadruples (a, b, c, d) of digits 0-9 satisfy a + b = c + d?",
     lambda: sum(1 for a, b, c, d in itertools.product(range(10), repeat=4) if a + b == c + d)),
    ("A staircase has 15 steps. You climb 1, 2, or 3 steps at a time, but you may never take two 3-step moves in a row. How many ways can you reach the top?", _m37),
    ("For how many integers n with 1 <= n <= 1000 does the decimal expansion of 1/n terminate?",
     lambda: sum(1 for n in range(1, 1001) if _strip25(n) == 1)),
    ("How many axis-aligned rectangles formed by the grid lines of an 8x8 grid of unit squares are not squares?",
     lambda: math.comb(9, 2) ** 2 - sum(k * k for k in range(1, 9))),
    ("How many lattice points (x, y) with integer coordinates satisfy x^2 + y^2 < 100?",
     lambda: sum(1 for x in range(-10, 11) for y in range(-10, 11) if x * x + y * y < 100)),
]


def _b3(n):
    d = []
    while n:
        d.append(n % 3)
        n //= 3
    return d


def _strip25(n):
    for p in (2, 5):
        while n % p == 0:
            n //= p
    return n


def load():
    return [{"id": f"m{i + 1:02}", "question": q, "answer": int(f())} for i, (q, f) in enumerate(PROBLEMS)]


if __name__ == "__main__":
    for p in load():
        print(p["id"], p["answer"], "|", p["question"][:80])
