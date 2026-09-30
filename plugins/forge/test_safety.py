import tempfile
import unittest
from pathlib import Path

from fakes import make_settings
from forge_service.blocklist import Blocklist
from forge_service.safety import EmptyPrompt, ForcedTagLost, build_prompts, fit_size, strip_networks


class StripNetworksTest(unittest.TestCase):
    def test_extra_network_tags_are_removed_wherever_they_are(self) -> None:
        self.assertEqual(
            strip_networks("1girl, <lora:evil:1.2>, armor <lyco:x:1> , <hypernet:h:0.5>sword"),
            "1girl, armor, sword",
        )

    def test_a_tag_with_its_closing_bracket_missing_is_no_tag_any_more(self) -> None:
        self.assertEqual(strip_networks("a <lora:x:1 and b c"), "a lora:x:1 and b c")
        self.assertEqual(strip_networks("a > b < c"), "a b c")

    def test_plain_prompts_only_lose_their_stray_commas_and_spaces(self) -> None:
        self.assertEqual(strip_networks(" a ,, b,  ,c "), "a, b, c")


class BuildPromptsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = make_settings(Path(self.tmp.name))
        self.block = Blocklist(self.settings.blocklist_files)
        self.family = next(f for f in self.settings.families if f.name == "anime")

    def build(
        self, prompt: str, negative: str = "", loras: list[tuple[str, float]] | None = None, prefix: str = ""
    ):
        return build_prompts(self.settings, self.family, self.block, prompt, negative, loras or [], prefix=prefix)

    def test_the_forced_tags_come_first_in_the_positive_prompt(self) -> None:
        built = self.build("masterpiece, 1girl, armor")
        self.assertEqual(built.prompt, "general, clothed, masterpiece, 1girl, armor")

    def test_the_forced_negatives_come_first_in_the_negative_prompt(self) -> None:
        built = self.build("1girl", "lowres, watermark")
        self.assertEqual(
            built.negative,
            "(nsfw, explicit, nude, naked, nipples, genitals, sex:1.4), (sensitive, questionable:1.2), lowres, watermark",
        )

    def test_a_tag_the_caller_wrote_that_hits_the_blocklist_is_deleted_and_counted(self) -> None:
        built = self.build("1girl, (nude:1.3), sword, sex")
        self.assertEqual(built.prompt, "general, clothed, 1girl, sword")
        self.assertEqual(built.scrubbed, ("(nude:1.3)", "sex"))

    def test_the_caller_cannot_turn_the_forced_negatives_off_through_the_text(self) -> None:
        built = self.build("1girl", "<lora:x:1>, nsfw")
        self.assertNotIn("<", built.negative)
        self.assertTrue(built.negative.startswith("(nsfw, explicit"))

    def test_nor_by_weighting_a_tag_at_zero_or_below(self) -> None:
        built = self.build("1girl", "(nsfw:-1), (explicit:0), (nude: 0.0), (blurry:0.5), (lowres:10), watermark")
        self.assertTrue(built.negative.endswith("(blurry:0.5), (lowres:10), watermark"))
        for gone in ("nsfw:-1", "explicit:0)", "nude: 0.0"):
            self.assertNotIn(gone, built.negative)

    def test_a_lora_written_into_the_prompt_is_removed_and_only_the_checked_ones_are_attached(self) -> None:
        built = self.build("1girl, <lora:smuggled:1>", loras=[("sword-lora", 0.7), ("b", 1.0)])
        self.assertNotIn("smuggled", built.prompt)
        self.assertTrue(built.prompt.endswith(" <lora:sword-lora:0.7> <lora:b:1>"))

    def test_nothing_left_after_the_blocklist_is_refused(self) -> None:
        with self.assertRaises(EmptyPrompt):
            self.build("nude, sex, <lora:x:1>")

    def test_the_callers_prefix_goes_between_the_forced_tags_and_the_prompt(self) -> None:
        built = self.build("1girl, armor", prefix="masterpiece, best quality, my_trigger")
        self.assertEqual(built.prompt, "general, clothed, masterpiece, best quality, my_trigger, 1girl, armor")

    def test_the_prefix_is_cleaned_and_scanned_like_the_rest(self) -> None:
        built = self.build("1girl", prefix="masterpiece, <lora:sneaky:1>, nude")
        self.assertEqual(built.prompt, "general, clothed, masterpiece, 1girl")
        self.assertEqual(built.scrubbed, ("nude",))

    def test_a_prefix_cannot_make_a_prompt_out_of_nothing(self) -> None:
        # the model's own words were all on the blocklist: the quality words of the configuration must not draw a picture
        with self.assertRaises(EmptyPrompt):
            self.build("nude, naked, sex", prefix="masterpiece, best quality")

    def test_underwear_is_never_forced(self) -> None:
        built = self.build("1girl")
        self.assertNotIn("underwear", built.prompt.lower())
        self.assertNotIn("underwear", built.negative.lower())

    def test_a_blocklist_that_would_delete_a_forced_tag_is_a_loud_error(self) -> None:
        (Path(self.tmp.name) / "words.txt").write_text("clothed\n", encoding="utf-8")
        block = Blocklist(self.settings.blocklist_files)
        with self.assertRaises(ForcedTagLost):
            build_prompts(self.settings, self.family, block, "1girl", "", [])

    def test_the_pony_family_forces_its_own_rating_tag(self) -> None:
        pony = next(f for f in self.settings.families if f.name == "pony")
        built = build_prompts(self.settings, pony, self.block, "score_9, 1girl", "", [])
        self.assertTrue(built.prompt.startswith("rating_safe, clothed, score_9"))
        self.assertIn("(rating_explicit:1.3)", built.negative)


class FitSizeTest(unittest.TestCase):
    def test_a_size_that_fits_is_kept(self) -> None:
        self.assertEqual(fit_size(1024, 1024, 1024), (1024, 1024))
        self.assertEqual(fit_size(832, 1216, 1280), (832, 1216))

    def test_the_long_side_is_brought_under_the_maximum_in_steps_of_64(self) -> None:
        self.assertEqual(fit_size(1024, 1024, 768), (768, 768))
        self.assertEqual(fit_size(1216, 832, 1024), (1024, 640))

    def test_sizes_are_rounded_to_64_and_never_below_512(self) -> None:
        self.assertEqual(fit_size(1000, 1000, 1024), (1024, 1024))
        self.assertEqual(fit_size(256, 300, 1024), (512, 512))
        self.assertEqual(fit_size(1024, 512, 512), (512, 512))

    def test_the_long_side_never_exceeds_the_maximum(self) -> None:
        for m in (512, 576, 640, 768, 1024, 2048):
            for w, h in ((1024, 1024), (1216, 832), (832, 1216), (1536, 640), (2048, 2048)):
                w2, h2 = fit_size(w, h, m)
                self.assertLessEqual(max(w2, h2), max(m, 512), (w, h, m))
                self.assertEqual((w2 % 64, h2 % 64), (0, 0))


if __name__ == "__main__":
    unittest.main()
