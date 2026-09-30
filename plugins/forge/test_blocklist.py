import json
import os
import tempfile
import unittest
from pathlib import Path

from forge_service.blocklist import BOM, Blocklist, BlocklistError, parse_words

CASES = json.loads((Path(__file__).parent / "blocklist_cases.json").read_text(encoding="utf-8"))


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class BlocklistTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write(self, name: str, *words: str) -> Path:
        p = self.dir / name
        p.write_text("\n".join(words) + "\n", encoding="utf-8")
        return p

    def test_shared_cases_agree_with_the_typescript_blocklist(self) -> None:
        bl = Blocklist([self.write("w.txt", *CASES["words"])])
        for case in CASES["cases"]:
            self.assertEqual(bl.hit(case["text"]), case["word"], case["text"])

    def test_comments_blank_lines_and_a_bom_are_skipped(self) -> None:
        self.assertEqual(parse_words(BOM + "# comment\n\n  nsfw  \n#nude\r\nsex\r\n"), ["nsfw", "sex"])

    def test_several_files_are_one_list(self) -> None:
        bl = Blocklist([self.write("a.txt", "alpha"), self.write("b.txt", "beta")])
        self.assertEqual(bl.words, 2)
        self.assertEqual(bl.hit("a beta thing"), "beta")
        self.assertEqual(bl.hit("gamma"), None)

    def test_hit_checks_every_text_in_order(self) -> None:
        bl = Blocklist([self.write("a.txt", "alpha", "beta")])
        self.assertEqual(bl.hit("nothing", "so beta"), "beta")

    def test_scrub_prompt_deletes_the_tags_that_hit_and_reports_them(self) -> None:
        bl = Blocklist([self.write("a.txt", "nude", "sex")])
        kept, dropped = bl.scrub_prompt("1girl, (nude:1.2), armor,, sex , sword")
        self.assertEqual(kept, "1girl, armor, sword")
        self.assertEqual(dropped, ["(nude:1.2)", "sex"])

    def test_a_missing_file_is_an_error_not_an_empty_list(self) -> None:
        bl = Blocklist([self.dir / "nope.txt"])
        self.assertIn("cannot be used", bl.error or "")
        with self.assertRaises(BlocklistError):
            bl.hit("anything")

    def test_a_list_without_words_is_an_error(self) -> None:
        bl = Blocklist([self.write("a.txt", "# only a comment")])
        self.assertIn("no words", bl.error or "")
        with self.assertRaises(BlocklistError):
            bl.check()

    def test_one_missing_file_among_good_ones_breaks_the_whole_list(self) -> None:
        bl = Blocklist([self.write("a.txt", "alpha"), self.dir / "gone.txt"])
        with self.assertRaises(BlocklistError):
            bl.hit("alpha")

    def test_an_edited_file_is_picked_up_and_a_deleted_one_is_an_error_until_it_comes_back(self) -> None:
        clock = Clock()
        path = self.write("a.txt", "alpha")
        bl = Blocklist([path], now=clock, recheck_sec=5)
        self.assertEqual(bl.hit("beta"), None)

        path.write_text("alpha\nbeta\n", encoding="utf-8")
        os.utime(path, (path.stat().st_atime, path.stat().st_mtime + 10))
        self.assertEqual(bl.hit("beta"), None, "not looked at yet: the recheck interval has not passed")
        clock.t = 6
        self.assertEqual(bl.hit("beta"), "beta")

        path.unlink()
        clock.t = 12
        with self.assertRaises(BlocklistError):
            bl.hit("alpha")
        path.write_text("gamma\n", encoding="utf-8")
        clock.t = 18
        self.assertEqual(bl.hit("gamma"), "gamma")
        self.assertIsNone(bl.error)

    def test_an_unreadable_encoding_is_an_error(self) -> None:
        p = self.dir / "bad.txt"
        p.write_bytes(b"\xff\xfe\x00 not utf-8 \x80\x81")
        self.assertIn("cannot be used", Blocklist([p]).error or "")


if __name__ == "__main__":
    unittest.main()
