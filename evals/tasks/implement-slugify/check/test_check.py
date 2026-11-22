import unittest
from text import slugify

class T(unittest.TestCase):
    def test_rules(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("  --A__b  c-- "), "a-b-c")
        self.assertEqual(slugify("Rust 1.88 released"), "rust-1-88-released")
        self.assertEqual(slugify("!!!"), "untitled")
        self.assertEqual(slugify(""), "untitled")

if __name__ == "__main__":
    unittest.main()
