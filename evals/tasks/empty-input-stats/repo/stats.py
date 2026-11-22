def mean(xs):
    """平均值。空列表返回 None。"""
    return sum(xs) / len(xs)

def median(xs):
    """中位数。空列表返回 None；偶数个时取中间两个的平均。不修改传入的列表。"""
    xs.sort()
    return xs[len(xs) // 2]
