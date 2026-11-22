import unittest
from users import create_user

class T(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(create_user("  Ann ", 30), {"name": "Ann", "age": 30})
        self.assertEqual(create_user("B", 0)["age"], 0)
        self.assertEqual(create_user("C", 150)["age"], 150)

    def test_bad(self):
        for name, age in [("", 1), ("   ", 1), ("x", -1), ("x", 151), ("x", 1.5), ("x", True), ("x", "3")]:
            with self.assertRaises(ValueError, msg=(name, age)):
                create_user(name, age)

if __name__ == "__main__":
    unittest.main()
