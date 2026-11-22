import unittest
from pagination import page

class T(unittest.TestCase):
    def test_pages(self):
        xs = list(range(10))
        self.assertEqual(page(xs, 0, 3), [0, 1, 2])
        self.assertEqual(page(xs, 3, 3), [9])
        self.assertEqual(page(xs, 4, 3), [])
        self.assertEqual(page([], 0, 5), [])

if __name__ == "__main__":
    unittest.main()
