import json
import tempfile
import unittest
from pathlib import Path

from fakes import FakeForge, make_settings
from forge_service.catalog import (
    CatalogProblem,
    check_loras,
    checkpoint_verdict,
    describe,
    find_checkpoint,
    stem,
)
from forge_service.settings import validate_max_long_side
from forge_service.state import StateFile, effective_max_long_side


class CatalogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = make_settings(Path(self.tmp.name))
        self.models = FakeForge().models
        self.loras = FakeForge().loras

    def test_stem(self) -> None:
        self.assertEqual(stem("sub\\Model_V2.safetensors [ab12cd34]"), "model_v2")
        self.assertEqual(stem("plain"), "plain")

    def test_a_checkpoint_is_found_by_title_name_or_stem_and_by_a_unique_fragment(self) -> None:
        for wanted in ("anime-xl-v1", "ANIME-XL-V1", "anime-xl-v1.safetensors [abcd1234]", "sub/pony-real-v6.safetensors [ef567890]"):
            self.assertIn("anime-xl-v1" if "anime" in wanted.lower() else "pony", find_checkpoint(self.models, wanted)["title"])
        self.assertEqual(find_checkpoint(self.models, "flux")["model_name"], "flux-thing")

    def test_several_matches_and_no_match_are_errors_that_say_so(self) -> None:
        with self.assertRaises(CatalogProblem) as ctx:
            find_checkpoint(self.models, "anime-xl")
        self.assertEqual(ctx.exception.code, "checkpoint_not_found")
        self.assertIn("matches several", str(ctx.exception))
        self.assertIn("anime-xl-v2", str(ctx.exception))
        with self.assertRaises(CatalogProblem) as ctx:
            find_checkpoint(self.models, "nothing-like-it")
        self.assertIn("no checkpoint called", str(ctx.exception))

    def test_a_checkpoint_needs_a_family_and_an_allowed_architecture(self) -> None:
        by_name = {m["model_name"]: m for m in self.models}
        family, why = checkpoint_verdict(self.settings, by_name["anime-xl-v1"])
        self.assertEqual((family.name, why), ("anime", None))
        family, why = checkpoint_verdict(self.settings, by_name["misc-merge"])
        self.assertIsNone(family)
        self.assertIn("no family", why)
        family, why = checkpoint_verdict(self.settings, by_name["flux-thing"])
        self.assertEqual(family.name, "heavy")
        self.assertIn("architecture flux1", why)

    def test_allowed_checkpoints_narrows_it_down(self) -> None:
        settings = make_settings(Path(self.tmp.name), allowed_checkpoints=["anime-xl-v2"])
        by_name = {m["model_name"]: m for m in self.models}
        self.assertIsNone(checkpoint_verdict(settings, by_name["anime-xl-v2"])[1])
        self.assertIn("allowed_checkpoints", checkpoint_verdict(settings, by_name["anime-xl-v1"])[1])

    def test_loras_must_be_allowed_and_installed(self) -> None:
        check_loras(self.settings, self.loras, ["sword-lora"])
        check_loras(self.settings, self.loras, ["SWORD-LORA"])
        with self.assertRaises(CatalogProblem) as ctx:
            check_loras(self.settings, self.loras, ["other-lora"])
        self.assertEqual(ctx.exception.code, "lora_not_allowed")
        with self.assertRaises(CatalogProblem) as ctx:
            check_loras(self.settings, [], ["sword-lora"])
        self.assertEqual(ctx.exception.code, "lora_not_found")

    def test_an_empty_allowlist_allows_no_lora(self) -> None:
        settings = make_settings(Path(self.tmp.name), lora_allowlist=[])
        with self.assertRaises(CatalogProblem):
            check_loras(settings, self.loras, ["sword-lora"])

    def test_the_catalog_view_marks_what_may_be_used(self) -> None:
        view = describe(self.settings, self.models, self.loras)
        by_name = {c["name"]: c for c in view.checkpoints}
        self.assertTrue(by_name["anime-xl-v1"]["allowed"])
        self.assertFalse(by_name["flux-thing"]["allowed"])
        self.assertIn("why_not", by_name["misc-merge"])
        self.assertIsNone(by_name["misc-merge"]["family"])
        loras = {entry["name"]: entry for entry in view.loras}
        self.assertTrue(loras["sword-lora"]["allowed"])
        self.assertEqual(loras["sword-lora"]["alias"], "SwordStyle")
        self.assertFalse(loras["other-lora"]["allowed"])


class StateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file = StateFile(Path(self.tmp.name) / "sub" / "state.json")

    def test_a_missing_torn_or_odd_file_is_an_empty_state(self) -> None:
        self.assertEqual(self.file.load(), {})
        for content in ("{oops", "null", "[1, 2]", '"text"', ""):
            self.file.path.parent.mkdir(exist_ok=True)
            self.file.path.write_text(content, encoding="utf-8")
            self.assertEqual(self.file.load(), {}, content)

    def test_it_is_written_atomically_into_a_folder_that_is_made(self) -> None:
        self.file.save({"max_long_side": 768, "config_value": 1024})
        self.assertEqual(json.loads(self.file.path.read_text(encoding="utf-8"))["max_long_side"], 768)
        self.assertFalse(self.file.path.with_suffix(".tmp").exists())

    def test_a_saved_value_counts_only_while_the_configuration_still_says_what_it_did(self) -> None:
        saved = {"max_long_side": 768, "config_value": 1024}
        self.assertEqual(effective_max_long_side(1024, saved), 768)
        self.assertEqual(effective_max_long_side(896, saved), 896, "the operator edited the configuration since")

    def test_a_saved_value_that_is_not_valid_is_ignored(self) -> None:
        for bad in (700, "768", None, 100000, True):
            self.assertEqual(effective_max_long_side(1024, {"max_long_side": bad, "config_value": 1024}), 1024)
        self.assertEqual(effective_max_long_side(1024, {}), 1024)
        validate_max_long_side(effective_max_long_side(1024, {"max_long_side": 640, "config_value": 1024}))


if __name__ == "__main__":
    unittest.main()
