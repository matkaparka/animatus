import tempfile
import unittest
from pathlib import Path

import yaml

from forge_service.blocklist import BOM
from forge_service.settings import (
    DEFAULT_BLOCKLIST,
    SettingsError,
    load_settings,
    parse_settings,
    validate_max_long_side,
)

HERE = Path(__file__).parent


def minimal(**over):
    base = {"families": {"anime": {"match": ["anime"], "rating_tag": "general"}}}
    base.update(over)
    return base


class SettingsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def parse(self, raw):
        return parse_settings(raw, base_dir=self.dir, data_dir=self.dir / "data")

    def problems(self, raw) -> str:
        with self.assertRaises(SettingsError) as ctx:
            self.parse(raw)
        return str(ctx.exception)

    def test_the_example_settings_that_ship_load_and_force_safe_tags_only(self) -> None:
        s = load_settings(HERE / "settings.example.yaml", data_dir=self.dir)
        self.assertEqual({f.name for f in s.families}, {"illustrious", "pony"})
        self.assertEqual(s.blocklist_files, ((HERE / "blocklist.default.txt").resolve(),))
        forced = " ".join([s.extra_positive, *(f.rating_tag for f in s.families)]).lower()
        self.assertNotIn("underwear", forced)
        self.assertTrue(DEFAULT_BLOCKLIST.is_file())

    def test_everything_but_the_families_has_a_default(self) -> None:
        s = self.parse(minimal())
        self.assertEqual(s.forge_url, "http://127.0.0.1:7860")
        self.assertEqual(s.blocklist_files, (DEFAULT_BLOCKLIST,))
        self.assertEqual(s.allowed_archs, ("sdxl",))
        self.assertEqual((s.limits.queue_max, s.limits.generate_timeout_sec), (3, 300))
        self.assertEqual((s.tagger.retries, s.tagger.max_questionable_plus_explicit), (1, 0.15))
        self.assertEqual(s.tagger.dir, self.dir / "data" / "tagger")
        self.assertEqual(s.lora_allowlist, ())
        self.assertTrue(s.unload_on_stop)
        self.assertIn("nsfw", s.extra_negative)

    def test_relative_paths_are_relative_to_the_settings_file(self) -> None:
        s = self.parse(minimal(blocklist_files=["lists/mine.txt"], tagger={"dir": "models/wd"}))
        self.assertEqual(s.blocklist_files, ((self.dir / "lists" / "mine.txt").resolve(),))
        self.assertEqual(s.tagger.dir, (self.dir / "models" / "wd").resolve())

    def test_every_problem_is_reported_at_once_and_a_typo_is_one_of_them(self) -> None:
        text = self.problems(
            {
                "forge_ulr": "http://x",
                "families": {"anime": {"match": [], "rating_tag": ""}, "Bad Name": {}},
                "tagger": {"retries": 9, "surprise": 1},
                "limits": {"queue_max": 0},
            }
        )
        for part in (
            "forge_ulr: unknown setting",
            "families.anime.match: at least 1 entry needed",
            "families.anime.rating_tag",
            "families.Bad Name",
            "tagger.retries",
            "tagger.surprise: unknown setting",
            "limits.queue_max",
        ):
            self.assertIn(part, text)

    def test_at_least_one_family_is_needed(self) -> None:
        self.assertIn("families: at least one model family", self.problems({}))

    def test_the_family_must_have_an_allowed_architecture(self) -> None:
        text = self.problems(minimal(allowed_archs=["flux1"]))
        self.assertIn("allowed_archs", text)

    def test_underwear_cannot_be_a_forced_tag(self) -> None:
        self.assertIn("underwear", self.problems(minimal(extra_positive="clothed, Underwear")))
        raw = minimal()
        raw["families"]["anime"]["rating_tag"] = "underwear"
        self.assertIn("underwear", self.problems(raw))

    def test_wrong_types_are_named(self) -> None:
        text = self.problems(minimal(max_loras="two", unload_on_stop="yes", lora_allowlist="a"))
        self.assertIn("max_loras", text)
        self.assertIn("unload_on_stop: expected true or false", text)
        self.assertIn("lora_allowlist: expected a list", text)

    def test_the_forge_address_must_be_a_web_address(self) -> None:
        self.assertIn("forge_url", self.problems(minimal(forge_url="localhost:7860")))
        self.assertEqual(self.parse(minimal(forge_url="http://10.0.0.5:7860/")).forge_url, "http://10.0.0.5:7860")

    def test_a_missing_or_broken_file_says_which(self) -> None:
        with self.assertRaises(SettingsError) as ctx:
            load_settings(self.dir / "nope.yaml", data_dir=self.dir)
        self.assertIn("nope.yaml", str(ctx.exception))
        bad = self.dir / "bad.yaml"
        bad.write_text("families: [unclosed", encoding="utf-8")
        with self.assertRaises(SettingsError) as ctx:
            load_settings(bad, data_dir=self.dir)
        self.assertIn("not valid YAML", str(ctx.exception))
        empty = self.dir / "empty.yaml"
        empty.write_text("", encoding="utf-8")
        with self.assertRaises(SettingsError):
            load_settings(empty, data_dir=self.dir)

    def test_a_file_with_a_bom_loads(self) -> None:
        f = self.dir / "s.yaml"
        f.write_text(BOM + yaml.safe_dump(minimal()), encoding="utf-8")
        self.assertEqual(len(load_settings(f, data_dir=self.dir).families), 1)


class MaxLongSideTest(unittest.TestCase):
    def test_multiples_of_64_from_512_to_2048_pass(self) -> None:
        for v in (512, 576, 1024, 2048):
            self.assertEqual(validate_max_long_side(v), v)

    def test_everything_else_says_why_not(self) -> None:
        for v, word in ((448, "at least"), (2112, "at most"), (1000, "multiple of 64"), (1024.0, "whole"), ("1024", "whole"), (True, "whole"), (None, "whole")):
            with self.assertRaises(ValueError, msg=repr(v)) as ctx:
                validate_max_long_side(v)
            self.assertIn(word, str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
