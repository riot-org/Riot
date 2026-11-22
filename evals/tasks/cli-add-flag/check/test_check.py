import subprocess, sys, unittest

def run(*a):
    return subprocess.run([sys.executable, "cli.py", *a], capture_output=True, text=True).stdout.strip()

class T(unittest.TestCase):
    def test_flag(self):
        self.assertEqual(run("ada"), "Hello, ada.")
        self.assertEqual(run("ada", "--shout"), "HELLO, ADA!")
        self.assertEqual(run("--shout", "Bob"), "HELLO, BOB!")

if __name__ == "__main__":
    unittest.main()
