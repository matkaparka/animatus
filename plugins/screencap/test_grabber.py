"""The capture procedure: window matching, the choice of method, black detection and error mapping."""

import io
import unittest

from PIL import Image

from fake_grabber import FakeGrabber, solid, window
from screencap import grabber as capture_module
from screencap.errors import CaptureError, capture_failed, window_not_responding


def run(fake, query="game", **over):
    args = {"max_width": 768, "quality": 80, "black_threshold": 10.0, "method": "auto", **over}
    return capture_module.capture(fake, query, **args)


LIT = (200, 120, 40)
BLACK = (0, 0, 0)


class Methods(unittest.TestCase):
    def test_auto_takes_the_printed_window_when_it_is_not_black(self):
        fake = FakeGrabber([window("1", "Game")], {("1", "printwindow"): solid(LIT)})
        result = run(fake)
        self.assertEqual((result.method, result.frame.black, result.window.id), ("printwindow", False, "1"))
        self.assertEqual(fake.grabs, [("1", "printwindow")])

    def test_auto_copies_the_screen_when_the_printed_window_is_black(self):
        fake = FakeGrabber(
            [window("1", "Game")],
            {("1", "printwindow"): solid(BLACK), ("1", "screen"): solid(LIT)},
        )
        result = run(fake)
        self.assertEqual((result.method, result.frame.black), ("screen", False))
        self.assertEqual(fake.grabs, [("1", "printwindow"), ("1", "screen")])

    def test_when_both_are_black_the_brighter_one_is_reported_as_black(self):
        fake = FakeGrabber(
            [window("1", "Game")],
            {("1", "printwindow"): solid((1, 1, 1)), ("1", "screen"): solid((6, 6, 6))},
        )
        result = run(fake)
        self.assertEqual((result.method, result.frame.black), ("screen", True))

    def test_a_chosen_method_is_the_only_one_tried(self):
        fake = FakeGrabber([window("1", "Game")], {("1", None): solid(BLACK)})
        self.assertEqual(run(fake, method="printwindow").method, "printwindow")
        self.assertEqual(run(fake, method="screen").method, "screen")
        self.assertEqual(fake.grabs, [("1", "printwindow"), ("1", "screen")])

    def test_a_print_that_fails_moves_on_to_the_screen_copy(self):
        fake = FakeGrabber(
            [window("1", "Game")],
            {("1", "printwindow"): capture_failed("PrintWindow failed (Windows error 5)"), ("1", "screen"): solid(LIT)},
        )
        self.assertEqual(run(fake).method, "screen")

    def test_a_print_that_failed_and_a_black_screen_copy_reports_black_not_an_error(self):
        fake = FakeGrabber(
            [window("1", "Game")],
            {("1", "printwindow"): capture_failed("nope"), ("1", "screen"): solid(BLACK)},
        )
        result = run(fake)
        self.assertEqual((result.method, result.frame.black), ("screen", True))

    def test_when_every_way_fails_one_error_names_them_all(self):
        fake = FakeGrabber(
            [window("1", "Game")],
            {("1", "printwindow"): capture_failed("first reason"), ("1", "screen"): capture_failed("second reason")},
        )
        with self.assertRaises(CaptureError) as caught:
            run(fake)
        error = caught.exception
        self.assertEqual((error.code, error.status, error.retryable), ("capture_failed", 500, True))
        self.assertIn("printwindow: first reason", error.message)
        self.assertIn("screen: second reason", error.message)

    def test_a_single_method_that_fails_keeps_its_own_error(self):
        original = capture_failed("only reason")
        fake = FakeGrabber([window("1", "Game")], {("1", "screen"): original})
        with self.assertRaises(CaptureError) as caught:
            run(fake, method="screen")
        self.assertIs(caught.exception, original)

    def test_an_error_about_the_window_is_not_retried_with_another_method(self):
        fake = FakeGrabber([window("1", "Game")], {("1", None): window_not_responding()})
        with self.assertRaises(CaptureError) as caught:
            run(fake)
        self.assertEqual(caught.exception.code, "window_not_responding")
        self.assertEqual(fake.grabs, [("1", "printwindow")])

    def test_an_unknown_method_is_a_bad_request(self):
        with self.assertRaises(CaptureError) as caught:
            run(FakeGrabber([window("1", "Game")]), method="magic")
        self.assertEqual(caught.exception.status, 400)


class Windows(unittest.TestCase):
    def test_no_such_window(self):
        fake = FakeGrabber([window("1", "Other")])
        with self.assertRaises(CaptureError) as caught:
            run(fake)
        self.assertEqual((caught.exception.status, caught.exception.code), (404, "window_not_found"))
        self.assertEqual(fake.grabs, [])

    def test_a_minimised_window_is_reported_before_anything_is_grabbed(self):
        fake = FakeGrabber([window("1", "Game", minimized=True, size=(0, 0))])
        with self.assertRaises(CaptureError) as caught:
            run(fake)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "window_minimized"))
        self.assertEqual(fake.grabs, [])

    def test_a_picture_larger_than_any_window_should_be_is_refused(self):
        big = Image.new("1", (9000, 8000))  # 72 million pixels, one bit each
        fake = FakeGrabber([window("1", "Game")], {("1", None): big})
        with self.assertRaises(CaptureError) as caught:
            run(fake, method="printwindow")
        self.assertEqual((caught.exception.status, caught.exception.code), (422, "window_too_large"))


class Result(unittest.TestCase):
    def test_the_frame_is_resized_and_encoded_with_the_requested_numbers(self):
        fake = FakeGrabber([window("1", "Game")], {("1", "printwindow"): solid(LIT, (1600, 900))})
        result = run(fake, max_width=400, quality=50)
        self.assertEqual((result.frame.width, result.frame.height), (400, 225))
        self.assertEqual((result.frame.source_width, result.frame.source_height), (1600, 900))
        self.assertEqual(Image.open(io.BytesIO(result.frame.jpeg)).size, (400, 225))

    def test_the_threshold_reaches_the_black_check(self):
        fake = FakeGrabber([window("1", "Game")], {("1", None): solid((30, 30, 30))})
        self.assertFalse(run(fake, method="printwindow").frame.black)
        self.assertTrue(run(fake, method="printwindow", black_threshold=40).frame.black)


if __name__ == "__main__":
    unittest.main()
