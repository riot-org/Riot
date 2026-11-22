import unittest
from stats import mean, median

class T(unittest.TestCase):
    def test_empty(self):
        self.assertIsNone(mean([]))
        self.assertIsNone(median([]))

    def test_values(self):
        self.assertEqual(mean([1, 2, 3, 4]), 2.5)
        self.assertEqual(median([3, 1, 2]), 2)
        self.assertEqual(median([4, 1, 3, 2]), 2.5)

    def test_no_mutation(self):
        xs = [3, 1, 2]
        median(xs)
        self.assertEqual(xs, [3, 1, 2])

if __name__ == "__main__":
    unittest.main()
