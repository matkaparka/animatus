"""The Win32 grabber against a real window. It makes its own small window (a solid red Tk window in the top-left corner
of the desktop, for about a second) and looks at nothing else. Off by default, because it needs an interactive Windows
desktop:

    set ANIMATUS_SCREENCAP_LIVE=1
    python -m unittest discover -s plugins/screencap -p "test_win32_live.py"
"""

import io
import os
import sys
import time
import unittest

from PIL import Image

LIVE = sys.platform == "win32" and os.environ.get("ANIMATUS_SCREENCAP_LIVE") == "1"

RED = (200, 30, 30)  # #c81e1e


def mean_color(image):
    return image.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))


@unittest.skipUnless(LIVE, "set ANIMATUS_SCREENCAP_LIVE=1 on Windows to run against a real window")
class RealWindow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tkinter

        from screencap.win32 import Win32Grabber

        cls.grabber = Win32Grabber()  # makes the process DPI aware, which has to happen before a window exists
        cls.title = f"animatus-screencap-test-{os.getpid()}"
        cls.root = tkinter.Tk()
        cls.root.title(cls.title)
        cls.root.geometry("320x200+40+40")
        cls.root.configure(background="#c81e1e")
        cls.root.attributes("-topmost", True)
        cls.pump()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.root.destroy()
        except Exception:  # noqa: BLE001 - already destroyed by a test
            pass

    @classmethod
    def pump(cls, seconds=0.4):
        """Tk paints only while its event loop runs; the grabber runs on this same thread, so keep it turning."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            cls.root.update()
            time.sleep(0.02)

    def mine(self):
        found = [w for w in self.grabber.list_windows() if w.title == self.title]
        self.assertEqual(len(found), 1, "the test window should be listed exactly once")
        return found[0]

    def test_the_grabber_can_work_here(self):
        self.assertIsNone(self.grabber.check())
        self.assertIn(self.grabber.dpi, ("per-monitor-v2", "per-monitor", "system", "unchanged"))

    def test_the_window_is_listed_with_its_process_and_size(self):
        info = self.mine()
        self.assertTrue(info.process.lower().startswith("python"), info.process)
        self.assertFalse(info.minimized)
        self.assertFalse(info.overlay)
        self.assertGreaterEqual(info.width, 300)
        self.assertGreaterEqual(info.height, 180)
        self.assertAlmostEqual(info.width / info.height, 1.6, delta=0.1)

    def test_printing_the_window_gives_its_own_colour(self):
        info = self.mine()
        image = self.grabber.grab(info.id, "printwindow")
        self.assertEqual(image.size, (info.width, info.height))
        for got, want in zip(mean_color(image), RED):
            self.assertAlmostEqual(got, want, delta=12)

    def test_copying_the_screen_gives_the_same_colour_when_nothing_covers_the_window(self):
        info = self.mine()
        image = self.grabber.grab(info.id, "screen")
        self.assertEqual(image.size, (info.width, info.height))
        for got, want in zip(mean_color(image), RED):
            self.assertAlmostEqual(got, want, delta=12)

    def test_the_whole_procedure_returns_a_lit_frame(self):
        from screencap.grabber import capture

        result = capture(
            self.grabber, self.title, max_width=160, quality=80, black_threshold=10.0, method="auto"
        )
        self.assertFalse(result.frame.black)
        self.assertEqual(result.window.title, self.title)
        self.assertEqual(result.frame.width, 160)

    def test_a_program_that_is_not_dpi_aware_is_copied_whole_whatever_the_display_scale(self):
        """A separate process that never asked for DPI awareness, like an old game or a Java program. On a scaled
        display Windows stretches its window, and printing it would fill only the top-left part of the picture."""
        import subprocess

        from screencap.errors import CaptureError
        from screencap.grabber import capture

        title = self.title + "-unaware"
        child = (
            "import sys, tkinter\n"
            "root = tkinter.Tk()\n"
            "root.title(sys.argv[1])\n"
            "root.geometry('320x200+420+300')\n"
            "root.configure(background='#1e1ec8')\n"
            "root.attributes('-topmost', True)\n"
            "root.after(10000, root.destroy)\n"
            "root.mainloop()\n"
        )
        proc = subprocess.Popen([sys.executable, "-c", child, title])
        self.addCleanup(proc.kill)
        deadline = time.monotonic() + 8
        while not [w for w in self.grabber.list_windows() if w.title == title]:
            self.assertLess(time.monotonic(), deadline, "the second program's window never appeared")
            time.sleep(0.1)
        time.sleep(0.5)  # let it paint

        result = capture(self.grabber, title, max_width=0, quality=80, black_threshold=10.0, method="auto")
        self.assertFalse(result.frame.black)
        image = Image.open(io.BytesIO(result.frame.jpeg)).convert("RGB")
        for got, want in zip(mean_color(image), (30, 30, 200)):
            self.assertAlmostEqual(got, want, delta=14)  # the whole window is blue, not a corner of it

        scaled = self.grabber.api.GetDpiForSystem() > 96
        self.assertEqual(result.method, "screen" if scaled else "printwindow")
        if scaled:
            with self.assertRaises(CaptureError) as caught:
                capture(self.grabber, title, max_width=0, quality=80, black_threshold=10.0, method="printwindow")
            self.assertEqual(caught.exception.code, "capture_failed")
            self.assertIn("DPI", caught.exception.message)

    def test_a_minimised_window_and_a_closed_one_are_errors_that_say_so(self):
        import tkinter

        from screencap.errors import CaptureError

        title = self.title + "-second"
        extra = tkinter.Toplevel(self.root)
        extra.title(title)
        extra.geometry("200x120+400+40")
        extra.configure(background="#1e1ec8")
        self.pump()
        find = lambda: [w for w in self.grabber.list_windows() if w.title == title]  # noqa: E731
        self.assertEqual(len(find()), 1)
        window_id = find()[0].id

        extra.iconify()
        self.pump(0.5)
        self.assertTrue(find()[0].minimized)
        with self.assertRaises(CaptureError) as caught:
            self.grabber.grab(window_id, "printwindow")
        self.assertEqual(caught.exception.code, "window_minimized")

        extra.destroy()
        self.pump(0.3)
        self.assertEqual(find(), [])
        with self.assertRaises(CaptureError) as caught:
            self.grabber.grab(window_id, "printwindow")
        self.assertEqual(caught.exception.code, "window_not_found")


if __name__ == "__main__":
    unittest.main()
