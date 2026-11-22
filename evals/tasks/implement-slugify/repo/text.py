def slugify(s: str) -> str:
    """把标题变成 URL 片段：
    - 全部小写；
    - 字母和数字保留，其它任何字符（空格、标点、下划线）都视为分隔；
    - 连续的分隔合并成一个 '-'；
    - 开头和结尾不留 '-'；
    - 结果为空时返回 'untitled'。
    """
    raise NotImplementedError
