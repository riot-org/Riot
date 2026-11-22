import pathlib, unittest

class T(unittest.TestCase):
    def test_renamed(self):
        import utils, cart, report
        self.assertFalse(hasattr(utils, "calc_total"), "旧名字不该还在")
        self.assertEqual(utils.compute_total([(2, 3)]), 6)
        self.assertEqual(cart.checkout([(2, 3)], 1), 5)
        self.assertEqual(report.summary({"a": [(1, 1)]}), {"a": 1})
        for f in pathlib.Path(".").glob("*.py"):
            if f.name != "test_check.py":
                self.assertNotIn("calc_total", f.read_text(), f.name)

if __name__ == "__main__":
    unittest.main()
