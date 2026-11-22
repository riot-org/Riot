import pathlib, tempfile, unittest
from reader import read_rows

class T(unittest.TestCase):
    def test_quoted(self):
        p = pathlib.Path(tempfile.mkdtemp()) / "x.csv"
        p.write_bytes('city,note\n"北京, 朝阳","说 ""你好"""\n深圳,\n'.encode("utf-8"))
        self.assertEqual(read_rows(p), [["北京, 朝阳", '说 "你好"'], ["深圳", ""]])

    def test_reads_utf8_explicitly(self):
        src = pathlib.Path("reader.py").read_text(encoding="utf-8")
        self.assertIn("utf-8", src.lower().replace("utf8", "utf-8"))

if __name__ == "__main__":
    unittest.main()
