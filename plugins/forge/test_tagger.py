import asyncio
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np

from fakes import make_png
from forge_service.tagger import (
    MODEL_FILES,
    RatingTagger,
    TaggerError,
    TaggerHolder,
    ensure_files,
    rating_ok,
)

TAGS_CSV = "tag_id,name,category,count\n0,general,9,0\n1,sensitive,9,0\n2,questionable,9,0\n3,explicit,9,0\n4,1girl,0,100\n"


class StubSession:
    """Stands in for an onnxruntime session: remembers what it was asked to run."""

    def __init__(self, *_a, **_k) -> None:
        self.inputs: list[np.ndarray] = []

    def get_inputs(self):
        return [SimpleNamespace(name="input_1", shape=[None, 16, 16, 3])]

    def run(self, _outputs, feed):
        x = feed["input_1"]
        self.inputs.append(x)
        return [np.array([[0.7, 0.2, 0.06, 0.04, 0.9]], dtype=np.float32)]


class RatingOkTest(unittest.TestCase):
    def test_the_rule(self) -> None:
        good = {"general": 0.9, "sensitive": 0.05, "questionable": 0.03, "explicit": 0.02}
        self.assertTrue(rating_ok(good, allow_sensitive=False, max_bad=0.15))
        sens = {"general": 0.2, "sensitive": 0.7, "questionable": 0.05, "explicit": 0.05}
        self.assertFalse(rating_ok(sens, allow_sensitive=False, max_bad=0.15))
        self.assertTrue(rating_ok(sens, allow_sensitive=True, max_bad=0.15))
        # the limit on questionable + explicit holds even where sensitive may pass
        sens_bad = {"general": 0.1, "sensitive": 0.5, "questionable": 0.3, "explicit": 0.1}
        self.assertFalse(rating_ok(sens_bad, allow_sensitive=True, max_bad=0.15))
        questionable_top = {"general": 0.3, "sensitive": 0.2, "questionable": 0.4, "explicit": 0.1}
        self.assertFalse(rating_ok(questionable_top, allow_sensitive=True, max_bad=0.15))
        # general on top but too much of the bad ones
        edge = {"general": 0.5, "sensitive": 0.1, "questionable": 0.2, "explicit": 0.2}
        self.assertFalse(rating_ok(edge, allow_sensitive=False, max_bad=0.15))
        self.assertTrue(rating_ok(edge, allow_sensitive=False, max_bad=0.5))
        self.assertFalse(rating_ok({}, allow_sensitive=True, max_bad=1.0))


class RatingTaggerTest(unittest.TestCase):
    def test_a_picture_becomes_a_square_bgr_batch_and_the_four_ratings_come_back(self) -> None:
        session = StubSession()
        tagger = RatingTagger(session, {"general": 0, "sensitive": 1, "questionable": 2, "explicit": 3}, 16)
        ratings = tagger.rate(make_png((255, 0, 0), size=(8, 4)))
        self.assertEqual(set(ratings), {"general", "sensitive", "questionable", "explicit"})
        self.assertAlmostEqual(ratings["general"], 0.7, places=5)
        x = session.inputs[0]
        self.assertEqual(x.shape, (1, 16, 16, 3))
        self.assertEqual(x.dtype, np.float32)
        self.assertEqual(list(x[0, 8, 8]), [0.0, 0.0, 255.0], "the centre is red, stored as blue-green-red")
        self.assertEqual(list(x[0, 0, 8]), [255.0, 255.0, 255.0], "the padding of a wide picture is white")

    def test_from_files_reads_the_rating_rows_of_the_tag_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tags = Path(tmp) / "selected_tags.csv"
            tags.write_text(TAGS_CSV, encoding="utf-8")
            model = Path(tmp) / "model.onnx"
            model.write_bytes(b"x")
            with mock.patch("onnxruntime.InferenceSession", StubSession):
                tagger = RatingTagger.from_files(model, tags)
            ratings = tagger.rate(make_png())
            self.assertAlmostEqual(ratings["explicit"], 0.04, places=5)

    def test_a_tag_list_without_the_four_ratings_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tags = Path(tmp) / "selected_tags.csv"
            tags.write_text("tag_id,name,category,count\n0,general,9,0\n1,1girl,0,5\n", encoding="utf-8")
            model = Path(tmp) / "model.onnx"
            model.write_bytes(b"x")
            with mock.patch("onnxruntime.InferenceSession", StubSession):
                with self.assertRaises(TaggerError) as ctx:
                    RatingTagger.from_files(model, tags)
            self.assertIn("sensitive", str(ctx.exception))

    def test_a_model_file_that_cannot_be_loaded_says_how_to_fetch_it_again(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "selected_tags.csv").write_text(TAGS_CSV, encoding="utf-8")
            (Path(tmp) / "model.onnx").write_bytes(b"not a model")
            with self.assertRaises(TaggerError) as ctx:
                RatingTagger.from_files(Path(tmp) / "model.onnx", Path(tmp) / "selected_tags.csv")
            self.assertIn("delete model.onnx", str(ctx.exception))


class EnsureFilesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / "wd"
        self.fetched: list[str] = []

    def fetch(self, repo: str, name: str, dest: Path) -> None:
        self.fetched.append(f"{repo}:{name}")
        (dest / name).write_bytes(b"data")

    def test_missing_files_are_fetched_into_a_folder_that_is_made(self) -> None:
        model, tags = ensure_files(self.dir, "some/repo", self.fetch)
        self.assertEqual((model.name, tags.name), MODEL_FILES)
        self.assertEqual(self.fetched, ["some/repo:model.onnx", "some/repo:selected_tags.csv"])

    def test_files_that_are_there_are_not_fetched_again(self) -> None:
        ensure_files(self.dir, "some/repo", self.fetch)
        self.fetched.clear()
        ensure_files(self.dir, "some/repo", self.fetch)
        self.assertEqual(self.fetched, [])

    def test_an_empty_file_counts_as_missing(self) -> None:
        self.dir.mkdir()
        (self.dir / "model.onnx").write_bytes(b"")
        ensure_files(self.dir, "some/repo", self.fetch)
        self.assertEqual(self.fetched[0], "some/repo:model.onnx")

    def test_a_failed_fetch_names_the_folder_and_the_manual_way(self) -> None:
        def boom(*_a) -> None:
            raise OSError("connection reset")

        with self.assertRaises(TaggerError) as ctx:
            ensure_files(self.dir, "some/repo", boom)
        msg = str(ctx.exception)
        self.assertIn("connection reset", msg)
        self.assertIn("https://huggingface.co/some/repo", msg)
        self.assertIn(str(self.dir), msg)

    def test_a_fetch_that_leaves_nothing_behind_is_an_error(self) -> None:
        with self.assertRaises(TaggerError):
            ensure_files(self.dir, "some/repo", lambda *_a: None)


class TaggerHolderTest(unittest.IsolatedAsyncioTestCase):
    async def test_it_loads_in_a_thread_and_retries_after_a_failure(self) -> None:
        threads: list[int] = []
        attempts = {"n": 0}

        def loader():
            threads.append(threading.get_ident())
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise TaggerError("no network")
            return object()

        holder = TaggerHolder(loader, retry_sec=0.01)
        task = asyncio.create_task(holder.run())
        for _ in range(200):
            if holder.state == "failed":
                break
            await asyncio.sleep(0.005)
        self.assertEqual((holder.state, holder.error), ("failed", "no network"))
        await asyncio.wait_for(task, 2)
        self.assertEqual((holder.state, holder.error), ("ready", None))
        self.assertIsNotNone(holder.tagger)
        self.assertNotIn(threading.get_ident(), threads, "the loader must not run on the event loop")

    async def test_the_event_loop_stays_free_while_it_loads(self) -> None:
        release = threading.Event()
        holder = TaggerHolder(lambda: (release.wait(5), object())[1])
        task = asyncio.create_task(holder.run())
        await asyncio.sleep(0.05)
        self.assertEqual(holder.state, "loading")
        release.set()
        await asyncio.wait_for(task, 2)
        self.assertEqual(holder.state, "ready")


if __name__ == "__main__":
    unittest.main()
