import unittest

from fake_grabber import window
from screencap.errors import CaptureError
from screencap.windows import MAX_QUERY, find_window, match_windows


class Query(unittest.TestCase):
    def setUp(self):
        self.windows = [
            window("100", "Notes", process="notepad.exe", size=(600, 400)),
            window("200", "Some Game 1.2 - World A", process="javaw.exe", size=(1920, 1080)),
            window("300", "Some Game launcher", process="javaw.exe", size=(600, 300)),
            window("400", "2048", process="browser.exe", size=(800, 600)),
        ]

    def test_a_number_is_a_window_id(self):
        self.assertEqual(find_window(self.windows, "200").title, "Some Game 1.2 - World A")

    def test_leading_zeros_do_not_matter(self):
        self.assertEqual(find_window(self.windows, "0000100").id, "100")

    def test_a_number_that_is_no_window_id_is_read_as_a_title(self):
        self.assertEqual(find_window(self.windows, "2048").id, "400")

    def test_exe_names_every_window_of_a_program_and_the_biggest_wins(self):
        self.assertEqual([w.id for w in match_windows(self.windows, "exe:javaw")], ["200", "300"])
        self.assertEqual(find_window(self.windows, "EXE:JavaW.exe").id, "200")

    def test_exe_without_a_name_is_a_bad_request(self):
        with self.assertRaises(CaptureError) as caught:
            match_windows(self.windows, "exe:  ")
        self.assertEqual((caught.exception.status, caught.exception.code), (400, "bad_request"))

    def test_an_exact_title_beats_a_longer_one_that_contains_it(self):
        windows = [window("1", "Some Game launcher"), window("2", "Some Game"), window("3", "Some Game 1.2")]
        self.assertEqual([w.id for w in match_windows(windows, "some game")], ["2", "1", "3"])
        self.assertEqual(find_window(windows, "some game").id, "2")

    def test_a_part_of_the_title_matches_and_case_and_spacing_are_ignored(self):
        self.assertEqual(find_window(self.windows, "  world   a ").id, "200")

    def test_nothing_matching_is_a_retryable_not_found(self):
        with self.assertRaises(CaptureError) as caught:
            find_window(self.windows, "no such window")
        error = caught.exception
        self.assertEqual((error.status, error.code, error.retryable), (404, "window_not_found", True))
        self.assertIn("no such window", error.message)

    def test_a_long_query_is_cut_in_the_message(self):
        with self.assertRaises(CaptureError) as caught:
            find_window(self.windows, "x" * 200)
        self.assertLess(len(caught.exception.message), 200)

    def test_empty_and_oversized_queries_are_bad_requests(self):
        for query in ("", "   ", "y" * (MAX_QUERY + 1)):
            with self.subTest(query=query[:10]):
                with self.assertRaises(CaptureError) as caught:
                    match_windows(self.windows, query)
                self.assertEqual(caught.exception.status, 400)


class Ranking(unittest.TestCase):
    def test_a_minimised_window_comes_after_a_normal_one_whatever_its_size(self):
        windows = [
            window("1", "Game", size=(0, 0), minimized=True),
            window("2", "Game", size=(300, 200)),
        ]
        self.assertEqual([w.id for w in match_windows(windows, "game")], ["2", "1"])

    def test_an_overlay_comes_after_a_real_window(self):
        windows = [window("1", "Game overlay", size=(1920, 1080), overlay=True), window("2", "Game", size=(800, 600))]
        self.assertEqual([w.id for w in match_windows(windows, "game")], ["2", "1"])

    def test_windows_that_tie_keep_the_order_of_the_z_order(self):
        windows = [window("7", "Game"), window("8", "Game"), window("9", "Game")]
        self.assertEqual([w.id for w in match_windows(windows, "game")], ["7", "8", "9"])

    def test_the_only_match_being_minimised_is_still_returned_so_the_caller_can_say_so(self):
        found = find_window([window("1", "Game", minimized=True, size=(0, 0))], "game")
        self.assertTrue(found.minimized)


class Public(unittest.TestCase):
    def test_the_public_form_has_every_field_the_client_reads(self):
        self.assertEqual(
            window("5", "T", process="p.exe", size=(10, 20), overlay=True).public(),
            {
                "id": "5",
                "title": "T",
                "process": "p.exe",
                "width": 10,
                "height": 20,
                "minimized": False,
                "overlay": True,
            },
        )


if __name__ == "__main__":
    unittest.main()
