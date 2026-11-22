def page(items, n, size):
    """第 n 页（从 0 开始），每页 size 个。越界返回空列表。"""
    start = n * size
    return items[start:start + size - 1]
