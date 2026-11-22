def read_rows(path):
    """读 CSV，跳过表头，返回每行的字段列表。"""
    with open(path) as f:
        lines = f.read().splitlines()
    return [line.split(",") for line in lines[1:] if line]
