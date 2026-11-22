import unittest
from settings import load_settings
from defaults import DEFAULTS

class T(unittest.TestCase):
    def test_deep_merge(self):
        s = load_settings({"db": {"port": 6000, "options": {"ssl": True}}})
        self.assertEqual(s["db"]["host"], "localhost")
        self.assertEqual(s["db"]["port"], 6000)
        self.assertEqual(s["db"]["options"], {"timeout": 5, "ssl": True})
        self.assertEqual(s["log"], {"level": "info"})

    def test_defaults_untouched(self):
        load_settings({"db": {"port": 1}})
        self.assertEqual(DEFAULTS["db"]["port"], 5432)

    def test_new_keys_and_non_dict_override(self):
        s = load_settings({"extra": 1, "log": "off"})
        self.assertEqual(s["extra"], 1)
        self.assertEqual(s["log"], "off")

if __name__ == "__main__":
    unittest.main()
