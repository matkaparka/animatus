import asyncio
import base64
import dataclasses
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

from aiohttp import ClientSession
from aiohttp.test_utils import TestClient, TestServer

from fakes import (
    GOOD,
    NSFW_SENSITIVE,
    QUESTIONABLE,
    SENSITIVE_TOP,
    FakeForge,
    FakeTagger,
    make_settings,
)
from forge_service import app as service_app
from forge_service.app import ForgeService, main, serve
from forge_service.blocklist import Blocklist
from forge_service.tagger import TaggerError

HERE = Path(__file__).parent


def payload(**over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "checkpoint": "anime-xl-v1",
        "prompt": "1girl, armor, sword",
        "negative_prompt": "lowres",
        "width": 1024,
        "height": 1024,
        "steps": 30,
        "cfg_scale": 4.5,
        "sampler_name": "Euler a",
        "scheduler": "Automatic",
        "seed": -1,
        "loras": [],
        "route": "default",
    }
    body.update(over)
    return body


class ServiceCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.forge = FakeForge()
        await self.forge.start()
        self.addAsyncCleanup(self.forge.stop)
        self.tagger = FakeTagger()

    async def until(self, cond: Callable[[], bool], timeout: float = 3.0, what: str = "condition") -> None:
        end = time.monotonic() + timeout
        while not cond():
            if time.monotonic() > end:
                self.fail(f"timed out waiting for {what}")
            await asyncio.sleep(0.005)

    async def start(
        self,
        *,
        loader: Callable[[], Any] | None = None,
        wait_ready: bool = True,
        config_long_side: int = 1024,
        limits: dict[str, float] | None = None,
        blocklist: Blocklist | None = None,
        forge_url: str | None = None,
        watch: float | None = None,
        **over: Any,
    ) -> SimpleNamespace:
        settings = make_settings(self.dir, forge_url=forge_url or self.forge.url, **over)
        if limits:
            settings = dataclasses.replace(settings, limits=dataclasses.replace(settings.limits, **limits))
        if watch is not None:
            settings = dataclasses.replace(settings, forge_check_sec=watch)
        service = ForgeService(
            settings,
            config_long_side=config_long_side,
            tagger_loader=loader or (lambda: self.tagger),
            watch_forge=watch is not None,
            blocklist=blocklist,
            retry_tagger_sec=0.05,
        )
        client = TestClient(TestServer(service.make_app()))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        if wait_ready:
            await self.until(lambda: service.tagger.state == "ready", what="the rating model")
        return SimpleNamespace(client=client, service=service, settings=settings)

    async def post(self, rig: SimpleNamespace, path: str, body: Any = None, *, raw: bytes | None = None):
        if raw is None:
            res = await rig.client.post(path, json=body)
        else:
            res = await rig.client.post(path, data=raw, headers={"content-type": "application/json"})
        return res.status, await res.json()

    async def get(self, rig: SimpleNamespace, path: str):
        res = await rig.client.get(path)
        return res.status, await res.json()

    async def generate(self, rig: SimpleNamespace, **over: Any):
        return await self.post(rig, "/generate", payload(**over))


class HealthTest(ServiceCase):
    async def test_it_is_ready_when_the_layers_are_up_and_reports_its_state(self) -> None:
        rig = await self.start()
        await rig.service.check_forge()
        status, body = await self.get(rig, "/health")
        self.assertEqual(status, 200)
        self.assertEqual((body["ok"], body["ready"], body["service"]), (True, True, "forge"))
        self.assertNotIn("detail", body)
        cfg = body["config"]
        self.assertEqual(cfg["max_long_side"], 1024)
        self.assertEqual((cfg["forge_reachable"], cfg["rating_model"]), (True, "ready"))
        self.assertEqual((cfg["queue_waiting"], cfg["queue_max"], cfg["busy"]), (0, 2, False))
        self.assertEqual(cfg["blocklist_words"], 5)
        self.assertIsNone(cfg["last_error"])

    async def test_forge_being_away_is_reported_but_the_service_stays_ready(self) -> None:
        rig = await self.start(forge_url="http://127.0.0.1:1")
        await rig.service.check_forge()
        status, body = await self.get(rig, "/health")
        self.assertEqual((status, body["ok"], body["ready"]), (200, True, True))
        self.assertIs(body["config"]["forge_reachable"], False)
        self.assertIn("Forge is not reachable", body["detail"])

    async def test_it_is_not_ready_while_the_rating_model_loads_and_the_queue_does_not_wait_for_it(self) -> None:
        release = threading.Event()
        rig = await self.start(loader=lambda: (release.wait(10), self.tagger)[1], wait_ready=False)
        await self.until(lambda: rig.service.tagger.state == "loading")
        status, body = await self.get(rig, "/health")
        self.assertEqual((status, body["ok"], body["ready"]), (200, True, False))
        self.assertIn("loading the rating model", body["detail"])
        self.assertFalse(rig.service._lock.locked(), "the download must not hold the generation lock")
        status, body = await self.generate(rig)
        self.assertEqual((status, body["status"], body["reason"]), (503, "error", "not_ready"))
        self.assertTrue(body["error"]["retryable"])
        self.assertEqual(self.forge.txt2img_payloads, [])
        release.set()
        await self.until(lambda: rig.service.tagger.state == "ready")
        status, body = await self.generate(rig)
        self.assertEqual((status, body["status"]), (200, "ok"))

    async def test_a_rating_model_that_cannot_be_fetched_is_a_503_with_the_reason_and_is_tried_again(self) -> None:
        attempts = {"n": 0}

        def loader():
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise TaggerError("cannot fetch model.onnx")
            return self.tagger

        rig = await self.start(loader=loader, wait_ready=False)
        await self.until(lambda: rig.service.tagger.state == "failed")
        status, body = await self.get(rig, "/health")
        self.assertEqual((status, body["ok"], body["ready"]), (503, False, False))
        self.assertIn("cannot fetch model.onnx", body["detail"])
        status, body = await self.generate(rig)
        self.assertEqual((status, body["reason"]), (503, "unavailable"))
        await self.until(lambda: rig.service.tagger.state == "ready", what="the retry")
        self.assertEqual((await self.get(rig, "/health"))[0], 200)

    async def test_a_missing_blocklist_breaks_health_and_generation_and_a_restored_one_mends_it(self) -> None:
        rig = await self.start(blocklist=Blocklist([self.dir / "not-there.txt"], recheck_sec=0))
        status, body = await self.get(rig, "/health")
        self.assertEqual((status, body["ok"]), (503, False))
        self.assertIn("blocklist", body["detail"])
        status, body = await self.generate(rig)
        self.assertEqual((status, body["reason"]), (503, "unavailable"))
        self.assertEqual(self.forge.txt2img_payloads, [])
        (self.dir / "not-there.txt").write_text("nude\n", encoding="utf-8")
        self.assertEqual((await self.get(rig, "/health"))[0], 200)

    async def test_the_watcher_notices_forge_coming_and_going_and_leaves_it_alone_while_it_draws(self) -> None:
        rig = await self.start(watch=0.05)
        await self.until(lambda: rig.service.forge_reachable is True, what="Forge to be seen")
        self.forge.gate = asyncio.Event()
        task = asyncio.create_task(self.generate(rig))
        await self.until(lambda: rig.service.busy)
        await asyncio.sleep(0.15)  # a probe that was already on its way has arrived
        pings = self.forge.pings
        await asyncio.sleep(0.3)
        self.assertEqual(self.forge.pings, pings, "no probing while a picture is being drawn")
        self.forge.gate.set()
        await task
        await self.until(lambda: self.forge.pings > pings, what="probing to resume")
        await self.forge.stop()
        await self.until(lambda: rig.service.forge_reachable is False, timeout=8, what="Forge to be missed")

    async def test_a_bug_is_a_json_500_and_not_a_stack_trace(self) -> None:
        rig = await self.start()
        with mock.patch.object(rig.service.forge, "checkpoints", side_effect=RuntimeError("boom")):
            status, body = await self.generate(rig)
        self.assertEqual((status, body["status"], body["reason"]), (500, "error", "internal_error"))
        self.assertIn("boom", body["error"]["message"])
        self.assertEqual((await self.generate(rig))[0], 200)

    async def test_a_blocklist_that_starts_deleting_a_forced_tag_is_a_loud_500(self) -> None:
        words = self.dir / "words.txt"
        rig = await self.start(blocklist=Blocklist([words], recheck_sec=0))
        words.write_text("clothed\n", encoding="utf-8")
        os.utime(words, (time.time() + 5, time.time() + 5))
        status, body = await self.generate(rig)
        self.assertEqual((status, body["reason"]), (500, "safety_config"))
        self.assertIn("clothed", body["error"]["message"])
        self.assertEqual(self.forge.txt2img_payloads, [])

    async def test_last_error_is_kept_until_a_picture_succeeds(self) -> None:
        rig = await self.start()
        self.forge.txt2img_mode = "http500"
        await self.generate(rig)
        self.assertIn("CUDA", (await self.get(rig, "/health"))[1]["config"]["last_error"])
        self.forge.txt2img_mode = "ok"
        await self.generate(rig)
        self.assertIsNone((await self.get(rig, "/health"))[1]["config"]["last_error"])


class ConfigTest(ServiceCase):
    async def test_the_new_size_is_reported_and_used_for_the_next_picture(self) -> None:
        rig = await self.start()
        status, body = await self.post(rig, "/config", {"max_long_side": 768})
        self.assertEqual((status, body), (200, {"ok": True, "config": {"max_long_side": 768}}))
        self.assertEqual((await self.get(rig, "/health"))[1]["config"]["max_long_side"], 768)
        await self.generate(rig, width=1024, height=1024)
        sent = self.forge.txt2img_payloads[-1]
        self.assertEqual((sent["width"], sent["height"]), (768, 768))

    async def test_a_picture_in_progress_keeps_the_size_it_started_with(self) -> None:
        rig = await self.start()
        self.forge.gate = asyncio.Event()
        task = asyncio.create_task(self.generate(rig))
        await self.until(lambda: len(self.forge.txt2img_payloads) == 1)
        await self.post(rig, "/config", {"max_long_side": 512})
        self.forge.gate.set()
        status, body = await task
        self.assertEqual((status, body["width"]), (200, 1024))

    async def test_values_that_are_not_valid_are_refused_and_change_nothing(self) -> None:
        rig = await self.start()
        for bad, word in (
            (700, "multiple of 64"),
            (448, "at least 512"),
            (4096, "at most"),
            ("768", "whole number"),
            (768.0, "whole number"),
            (True, "whole number"),
        ):
            status, body = await self.post(rig, "/config", {"max_long_side": bad})
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_config"), bad)
            self.assertIn(word, body["error"]["message"])
        for body_in in ({}, {"max_long_side": 768, "hires": True}, [768]):
            status, body = await self.post(rig, "/config", body_in)
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"))
        status, body = await self.post(rig, "/config", raw=b"not json")
        self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"))
        self.assertEqual(rig.service.max_long_side, 1024)
        self.assertFalse(rig.service.state.path.exists())

    async def test_the_size_survives_a_restart_unless_the_configuration_changed_meanwhile(self) -> None:
        rig = await self.start()
        await self.post(rig, "/config", {"max_long_side": 768})
        self.assertEqual((await self.start(config_long_side=1024)).service.max_long_side, 768)
        self.assertEqual((await self.start(config_long_side=896)).service.max_long_side, 896)

    async def test_a_torn_state_file_is_ignored(self) -> None:
        state = self.dir / "data" / "state.json"
        state.parent.mkdir(parents=True)
        state.write_text('{"max_long_side": 76', encoding="utf-8")
        self.assertEqual((await self.start()).service.max_long_side, 1024)

    async def test_a_size_that_cannot_be_saved_is_not_applied_and_the_answer_says_so(self) -> None:
        (self.dir / "data").write_text("a file where the folder should be", encoding="utf-8")
        rig = await self.start()
        status, body = await self.post(rig, "/config", {"max_long_side": 768})
        self.assertEqual((status, body["error"]["code"]), (500, "state_not_saved"))
        self.assertEqual(rig.service.max_long_side, 1024)


class CatalogTest(ServiceCase):
    async def test_it_lists_what_forge_has_and_what_may_be_used(self) -> None:
        rig = await self.start()
        status, body = await self.get(rig, "/catalog")
        self.assertEqual(status, 200)
        by_name = {c["name"]: c for c in body["checkpoints"]}
        self.assertEqual((by_name["anime-xl-v1"]["family"], by_name["anime-xl-v1"]["allowed"]), ("anime", True))
        self.assertFalse(by_name["flux-thing"]["allowed"])
        self.assertIsNone(by_name["misc-merge"]["family"])
        self.assertEqual({e["name"]: e["allowed"] for e in body["loras"]}, {"sword-lora": True, "other-lora": False})
        self.assertEqual(body["families"], ["anime", "pony", "heavy"])
        self.assertEqual(body["max_long_side"], 1024)

    async def test_forge_being_away_is_a_loud_error_not_an_empty_catalog(self) -> None:
        rig = await self.start(forge_url="http://127.0.0.1:1")
        status, body = await self.get(rig, "/catalog")
        self.assertEqual((status, body["error"]["code"], body["error"]["retryable"]), (502, "forge_unreachable", True))
        self.assertIn("--api", body["error"]["message"])

    async def test_unknown_paths_and_methods_answer_json(self) -> None:
        rig = await self.start()
        status, body = await self.get(rig, "/nope")
        self.assertEqual((status, body["error"]["code"]), (404, "not_found"))
        status, body = await self.get(rig, "/generate")
        self.assertEqual((status, body["error"]["code"]), (405, "method_not_allowed"))


class GenerateTest(ServiceCase):
    async def test_a_picture_is_drawn_checked_and_returned(self) -> None:
        rig = await self.start()
        status, body = await self.generate(rig, seed=1234)
        self.assertEqual((status, body["status"]), (200, "ok"))
        self.assertEqual(base64.b64decode(body["image_b64"]), self.forge.png)
        from PIL import Image

        thumb = Image.open(io.BytesIO(base64.b64decode(body["thumb_b64"])))
        self.assertEqual(thumb.format, "JPEG")
        self.assertEqual((body["seed"], body["attempts"], body["family"]), (1234, 1, "anime"))
        self.assertEqual((body["width"], body["height"]), (1024, 1024))
        self.assertEqual(body["ratings"], GOOD)
        self.assertEqual(self.tagger.pngs, [self.forge.png])

    async def test_what_forge_is_asked_is_built_by_the_service_and_safe(self) -> None:
        rig = await self.start()
        await self.generate(rig, seed=77, steps=25, cfg_scale=5.5)
        sent = self.forge.txt2img_payloads[0]
        self.assertEqual(sent["prompt"], "general, clothed, 1girl, armor, sword")
        self.assertTrue(sent["negative_prompt"].startswith("(nsfw, explicit, nude, naked, nipples, genitals, sex:1.4)"))
        self.assertTrue(sent["negative_prompt"].endswith("lowres"))
        expected = {
            "seed": 77,
            "steps": 25,
            "cfg_scale": 5.5,
            "sampler_name": "Euler a",
            "scheduler": "Automatic",
            "width": 1024,
            "height": 1024,
            "batch_size": 1,
            "n_iter": 1,
            "enable_hr": False,
            "send_images": True,
            "save_images": False,
            "do_not_save_samples": True,
            "do_not_save_grid": True,
            "override_settings_restore_afterwards": False,
            "override_settings": {"sd_model_checkpoint": "anime-xl-v1.safetensors [abcd1234]"},
        }
        for key, value in expected.items():
            self.assertEqual(sent[key], value, key)

    async def test_a_random_seed_is_chosen_by_the_service_and_reported(self) -> None:
        rig = await self.start()
        _, body = await self.generate(rig)
        self.assertGreaterEqual(body["seed"], 0)
        self.assertEqual(self.forge.txt2img_payloads[0]["seed"], body["seed"])

    async def test_no_scheduler_means_none_is_sent(self) -> None:
        rig = await self.start()
        await self.generate(rig, scheduler=None)
        self.assertNotIn("scheduler", self.forge.txt2img_payloads[0])

    async def test_the_rating_model_runs_off_the_event_loop(self) -> None:
        seen: list[int] = []

        class Spy:
            def rate(_self, png: bytes) -> dict[str, float]:
                seen.append(threading.get_ident())
                return dict(GOOD)

        rig = await self.start(loader=lambda: Spy())
        await self.generate(rig)
        self.assertEqual(len(seen), 1)
        self.assertNotEqual(seen[0], threading.get_ident())

    # ── layers 1 and 2

    async def test_tags_on_the_blocklist_are_deleted_before_forge_sees_them(self) -> None:
        rig = await self.start()
        status, body = await self.generate(rig, prompt="1girl, (nude:1.3), sword, see_through, 色情图")
        self.assertEqual((status, body["status"], body["scrubbed"]), (200, "ok", 3))
        self.assertEqual(self.forge.txt2img_payloads[0]["prompt"], "general, clothed, 1girl, sword")

    async def test_a_prompt_that_is_all_blocklist_is_refused_without_calling_forge(self) -> None:
        rig = await self.start()
        status, body = await self.generate(rig, prompt="nude, naked, sex")
        self.assertEqual((status, body), (200, {"status": "rejected", "reason": "empty_prompt"}))
        self.assertEqual(self.forge.txt2img_payloads, [])

    async def test_and_so_is_one_whose_only_other_words_are_the_callers_own_prefix(self) -> None:
        rig = await self.start()
        status, body = await self.generate(rig, prompt="nude, sex", prefix="masterpiece, best quality")
        self.assertEqual((status, body), (200, {"status": "rejected", "reason": "empty_prompt"}))
        self.assertEqual(self.forge.txt2img_payloads, [])

    async def test_the_prefix_is_put_in_front_of_the_prompt_after_the_forced_tags(self) -> None:
        rig = await self.start()
        await self.generate(rig, prefix="masterpiece, best quality")
        self.assertEqual(
            self.forge.txt2img_payloads[0]["prompt"], "general, clothed, masterpiece, best quality, 1girl, armor, sword"
        )

    async def test_the_blocklist_is_read_again_when_its_file_changes(self) -> None:
        words = self.dir / "words.txt"
        rig = await self.start(blocklist=Blocklist([words], recheck_sec=0))
        # the rig wrote the default list into words.txt
        await self.generate(rig)
        self.assertIn("sword", self.forge.txt2img_payloads[-1]["prompt"])
        words.write_text("sword\n", encoding="utf-8")
        os.utime(words, (time.time() + 5, time.time() + 5))
        await self.generate(rig)
        self.assertNotIn("sword", self.forge.txt2img_payloads[-1]["prompt"])

    async def test_a_lora_written_into_the_prompt_never_reaches_forge(self) -> None:
        rig = await self.start()
        await self.generate(rig, prompt="1girl, <lora:smuggled:1>, <lyco:x:1>")
        self.assertNotIn("<", self.forge.txt2img_payloads[0]["prompt"])
        self.assertNotIn("smuggled", self.forge.txt2img_payloads[0]["prompt"])

    async def test_an_allowed_lora_is_attached_by_the_service(self) -> None:
        rig = await self.start()
        status, _ = await self.generate(rig, loras=[{"name": "sword-lora", "weight": 0.7}])
        self.assertEqual(status, 200)
        self.assertTrue(self.forge.txt2img_payloads[0]["prompt"].endswith(" <lora:sword-lora:0.7>"))

    async def test_a_lora_off_the_allowlist_or_missing_in_forge_is_an_error_that_says_which(self) -> None:
        rig = await self.start()
        status, body = await self.generate(rig, loras=[{"name": "other-lora", "weight": 0.7}])
        self.assertEqual((status, body["status"], body["reason"]), (422, "error", "lora_not_allowed"))
        self.forge.loras = []
        status, body = await self.generate(rig, loras=[{"name": "sword-lora", "weight": 0.7}])
        self.assertEqual((status, body["reason"]), (422, "lora_not_found"))
        self.assertEqual(self.forge.txt2img_payloads, [])

    async def test_checkpoints_that_cannot_be_used_say_why_and_forge_is_not_asked_to_draw(self) -> None:
        rig = await self.start()
        cases = (
            ("nothing-like-it", "checkpoint_not_found"),
            ("anime-xl", "checkpoint_not_found"),  # matches two
            ("misc-merge", "unknown_family"),
            ("flux-thing", "checkpoint_not_allowed"),
        )
        for name, reason in cases:
            status, body = await self.generate(rig, checkpoint=name)
            self.assertEqual((status, body["status"], body["reason"]), (422, "error", reason), name)
        self.assertEqual(self.forge.txt2img_payloads, [])

    async def test_a_partial_but_unique_name_finds_the_checkpoint(self) -> None:
        rig = await self.start()
        status, body = await self.generate(rig, checkpoint="pony")
        self.assertEqual((status, body["family"]), (200, "pony"))
        self.assertTrue(self.forge.txt2img_payloads[0]["prompt"].startswith("rating_safe, clothed"))

    # ── layer 3

    async def test_a_picture_the_rating_model_refuses_is_drawn_again_with_another_seed(self) -> None:
        self.tagger = FakeTagger(QUESTIONABLE, GOOD)
        rig = await self.start()
        status, body = await self.generate(rig, seed=5)
        self.assertEqual((status, body["status"], body["attempts"]), (200, "ok", 2))
        seeds = [p["seed"] for p in self.forge.txt2img_payloads]
        self.assertEqual(len(seeds), 2)
        self.assertEqual(seeds[0], 5)
        self.assertNotEqual(seeds[0], seeds[1])
        self.assertEqual(body["seed"], seeds[1])

    async def test_two_refusals_are_blocked_and_the_picture_goes_nowhere(self) -> None:
        self.tagger = FakeTagger(QUESTIONABLE)
        rig = await self.start()
        status, body = await self.generate(rig)
        self.assertEqual((status, body["status"], body["reason"], body["attempts"]), (200, "blocked", "rating", 2))
        self.assertNotIn("image_b64", body)
        self.assertNotIn("thumb_b64", body)
        self.assertNotIn(base64.b64encode(self.forge.png).decode(), json.dumps(body))
        written = [p for p in self.dir.rglob("*") if p.is_file() and p.name != "words.txt"]
        self.assertEqual(written, [], "no picture may be written anywhere")

    async def test_the_number_of_retries_is_a_setting(self) -> None:
        self.tagger = FakeTagger(QUESTIONABLE, GOOD)
        rig = await self.start(tagger={"retries": 0})
        _, body = await self.generate(rig)
        self.assertEqual((body["status"], body["attempts"]), ("blocked", 1))
        self.assertEqual(len(self.forge.txt2img_payloads), 1)

    async def test_the_limit_on_questionable_and_explicit_is_a_setting(self) -> None:
        edge = {"general": 0.6, "sensitive": 0.1, "questionable": 0.2, "explicit": 0.1}
        self.tagger = FakeTagger(edge)
        strict = await self.start(tagger={"retries": 0})
        self.assertEqual((await self.generate(strict))[1]["status"], "blocked")
        loose = await self.start(tagger={"retries": 0, "max_questionable_plus_explicit": 0.5})
        self.assertEqual((await self.generate(loose))[1]["status"], "ok")

    async def test_only_the_named_routes_may_pass_a_picture_the_model_calls_sensitive(self) -> None:
        self.tagger = FakeTagger(SENSITIVE_TOP)
        rig = await self.start(tagger={"retries": 0})
        self.assertEqual((await self.generate(rig, route="default"))[1]["status"], "blocked")
        self.assertEqual((await self.generate(rig, route="self"))[1]["status"], "ok")
        self.tagger.script = [NSFW_SENSITIVE]
        self.tagger.calls = 0
        self.assertEqual((await self.generate(rig, route="self"))[1]["status"], "blocked", "the questionable limit holds")

    # ── failures of Forge

    async def test_forge_being_away_is_a_502_before_anything_waits(self) -> None:
        rig = await self.start(forge_url="http://127.0.0.1:1")
        status, body = await self.generate(rig)
        self.assertEqual((status, body["status"], body["reason"]), (502, "error", "forge_unreachable"))
        self.assertTrue(body["error"]["retryable"])
        self.assertIs(rig.service.forge_reachable, False)

    async def test_what_forge_answers_that_is_not_a_picture_is_an_error_and_never_an_empty_success(self) -> None:
        rig = await self.start()
        for mode, word in (
            ("http500", "CUDA out of memory"),
            ("notjson", "not JSON"),
            ("noimages", "without a picture"),
            ("notpng", "not a PNG"),
            ("badbase64", "base64"),
        ):
            self.forge.txt2img_mode = mode
            status, body = await self.generate(rig)
            self.assertEqual((status, body["status"], body["reason"]), (502, "error", "forge_error"), mode)
            self.assertIn(word, body["error"]["message"], mode)
            self.assertNotIn("image_b64", body)
        self.forge.txt2img_mode = "ok"
        self.assertEqual((await self.generate(rig))[1]["status"], "ok", "and the service is still usable")

    async def test_a_picture_that_takes_too_long_is_a_504_and_forge_is_told_to_stop(self) -> None:
        rig = await self.start(limits={"generate_timeout_sec": 0.3})
        self.forge.gate = asyncio.Event()  # never opened by the test: only the interrupt opens it
        status, body = await self.generate(rig)
        self.assertEqual((status, body["reason"]), (504, "forge_timeout"))
        self.assertEqual(self.forge.interrupts, 1)
        self.assertFalse(rig.service.busy)
        self.assertFalse(rig.service._lock.locked())
        status, _ = await self.generate(rig)
        self.assertEqual(status, 200, "the next request is not stuck behind the one that timed out")

    async def test_a_caller_that_hangs_up_stops_forge_and_frees_the_turn(self) -> None:
        rig = await self.start()
        self.forge.gate = asyncio.Event()
        session = ClientSession()
        self.addAsyncCleanup(session.close)
        url = str(rig.client.make_url("/generate"))
        task = asyncio.create_task(session.post(url, json=payload()))
        await self.until(lambda: rig.service.busy, what="the picture to start")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await session.close()
        await self.until(lambda: self.forge.interrupts == 1, what="the interrupt")
        await self.until(lambda: not rig.service.busy, what="the turn to be free")
        self.assertFalse(rig.service._lock.locked())

    # ── one at a time

    async def test_pictures_are_drawn_one_at_a_time_and_the_queue_is_bounded(self) -> None:
        rig = await self.start()  # queue_max is 2
        self.forge.gate = asyncio.Event()
        first = asyncio.create_task(self.generate(rig, seed=1))
        await self.until(lambda: len(self.forge.txt2img_payloads) == 1)
        second = asyncio.create_task(self.generate(rig, seed=2))
        third = asyncio.create_task(self.generate(rig, seed=3))
        await self.until(lambda: rig.service.waiting == 2, what="two to wait")
        status, body = await self.generate(rig, seed=4)
        self.assertEqual((status, body["status"], body["reason"]), (503, "error", "busy"))
        self.assertTrue(body["error"]["retryable"])
        health = (await self.get(rig, "/health"))[1]["config"]
        self.assertEqual((health["busy"], health["queue_waiting"]), (True, 2))
        self.assertEqual(len(self.forge.txt2img_payloads), 1, "the others wait for their turn")
        self.forge.gate.set()
        results = await asyncio.gather(first, second, third)
        self.assertEqual([r[0] for r in results], [200, 200, 200])
        self.assertEqual([p["seed"] for p in self.forge.txt2img_payloads], [1, 2, 3], "in the order they came")
        self.assertEqual(self.forge.peak, 1, "Forge never had two pictures at once")
        self.assertEqual((rig.service.waiting, rig.service.busy), (0, False))

    async def test_a_request_that_waits_too_long_for_its_turn_gives_up_with_a_503(self) -> None:
        rig = await self.start(limits={"queue_wait_sec": 0.2})
        self.forge.gate = asyncio.Event()
        first = asyncio.create_task(self.generate(rig, seed=1))
        await self.until(lambda: len(self.forge.txt2img_payloads) == 1)
        status, body = await self.generate(rig, seed=2)
        self.assertEqual((status, body["reason"]), (503, "busy"))
        self.assertEqual(rig.service.waiting, 0)
        self.forge.gate.set()
        self.assertEqual((await first)[0], 200)

    async def test_a_waiting_request_whose_caller_hangs_up_leaves_the_queue(self) -> None:
        rig = await self.start()
        self.forge.gate = asyncio.Event()
        first = asyncio.create_task(self.generate(rig, seed=1))
        await self.until(lambda: len(self.forge.txt2img_payloads) == 1)
        session = ClientSession()
        self.addAsyncCleanup(session.close)
        waiting = asyncio.create_task(session.post(str(rig.client.make_url("/generate")), json=payload(seed=2)))
        await self.until(lambda: rig.service.waiting == 1)
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        await session.close()
        await self.until(lambda: rig.service.waiting == 0, what="the queue to shrink")
        self.forge.gate.set()
        self.assertEqual((await first)[0], 200)
        self.assertEqual(len(self.forge.txt2img_payloads), 1, "the one that hung up was never drawn")

    # ── what is accepted

    async def test_requests_are_checked_strictly(self) -> None:
        rig = await self.start()
        bad_bodies = [
            payload(override_settings={"sd_model_checkpoint": "x"}),
            payload(enable_hr=True),
            payload(alwayson_scripts={}),
            {k: v for k, v in payload().items() if k != "prompt"},
            payload(prompt=""),
            payload(prompt="x" * 4001),
            payload(prefix=5),
            payload(prefix="x" * 601),
            payload(checkpoint=5),
            payload(width="1024"),
            payload(width=32),
            payload(steps=61),
            payload(steps=True),
            payload(cfg_scale=99),
            payload(sampler_name="Euler a; rm -rf"),
            payload(seed=2**40),
            payload(route="Self"),
            payload(route=""),
            payload(loras=[{"name": "a", "weight": 1}] * 3),
            payload(loras=[{"name": "a", "weight": 9}]),
            payload(loras=[{"name": "a", "weight": 1, "extra": 1}]),
            payload(loras="a"),
        ]
        for body in bad_bodies:
            status, out = await self.post(rig, "/generate", body)
            self.assertEqual((status, out["status"], out["reason"]), (400, "error", "invalid_request"), body)
        for raw in (b"", b"not json", b"[1]", b'"text"', b"null"):
            status, out = await self.post(rig, "/generate", raw=raw)
            self.assertEqual((status, out["reason"]), (400, "invalid_request"), raw)
        status, out = await self.post(rig, "/generate", raw=b'{"prompt": "' + b"x" * 70000 + b'"}')
        self.assertEqual((status, out["reason"]), (413, "invalid_request"))
        self.assertEqual(self.forge.txt2img_payloads, [])

    async def test_all_the_problems_of_a_request_come_back_at_once(self) -> None:
        rig = await self.start()
        _, out = await self.post(rig, "/generate", payload(width="x", steps=0, route="No"))
        for part in ("width", "steps", "route"):
            self.assertIn(part, out["error"]["message"])


class ShutdownTest(ServiceCase):
    async def test_shutdown_answers_and_then_stops_the_service(self) -> None:
        rig = await self.start()
        status, body = await self.post(rig, "/shutdown")
        self.assertEqual((status, body), (200, {"ok": True}))
        await asyncio.wait_for(rig.service.stopping.wait(), 2)

    async def _run_serve(self, **over: Any) -> tuple[int, int]:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        settings = make_settings(self.dir, forge_url=self.forge.url, **over)
        task = asyncio.create_task(
            serve(settings, port=port, config_long_side=1024, tagger_loader=lambda: self.tagger)
        )
        async with ClientSession() as session:
            for _ in range(200):
                try:
                    async with session.get(f"http://127.0.0.1:{port}/health") as res:
                        if res.status == 200 and (await res.json())["ready"]:
                            break
                except OSError:
                    pass
                await asyncio.sleep(0.02)
            else:
                self.fail("the service did not come up")
            async with session.post(f"http://127.0.0.1:{port}/shutdown") as res:
                self.assertEqual(res.status, 200)
        return await asyncio.wait_for(task, 10), port

    async def test_stopping_asks_forge_to_free_the_checkpoint(self) -> None:
        code, _ = await self._run_serve()
        self.assertEqual(code, 0)
        self.assertEqual(self.forge.unloads, 1)

    async def test_that_is_a_setting(self) -> None:
        code, _ = await self._run_serve(unload_on_stop=False)
        self.assertEqual(code, 0)
        self.assertEqual(self.forge.unloads, 0)

    async def test_a_picture_still_being_drawn_when_the_service_stops_is_interrupted(self) -> None:
        self.forge.gate = asyncio.Event()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        settings = make_settings(self.dir, forge_url=self.forge.url)
        task = asyncio.create_task(serve(settings, port=port, config_long_side=1024, tagger_loader=lambda: self.tagger))
        base = f"http://127.0.0.1:{port}"
        async with ClientSession() as session:
            for _ in range(200):
                try:
                    async with session.get(f"{base}/health") as res:
                        if res.status == 200 and (await res.json())["ready"]:
                            break
                except OSError:
                    pass
                await asyncio.sleep(0.02)
            drawing = asyncio.create_task(session.post(f"{base}/generate", json=payload()))
            await self.until(lambda: len(self.forge.txt2img_payloads) == 1)
            async with session.post(f"{base}/shutdown") as res:
                self.assertEqual(res.status, 200)
            self.assertEqual(await asyncio.wait_for(task, 10), 0)
            drawing.cancel()
            await asyncio.gather(drawing, return_exceptions=True)
        self.assertGreaterEqual(self.forge.interrupts, 1)


class CommandLineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def settings_file(self, text: str) -> Path:
        f = self.dir / "settings.yaml"
        f.write_text(text, encoding="utf-8")
        return f

    def run_main(self, *args: str) -> tuple[int, str]:
        err = io.StringIO()
        with mock.patch("sys.stderr", err), mock.patch("sys.stdout", io.StringIO()):
            code = main(list(args))
        return code, err.getvalue()

    def test_bad_settings_exit_with_2_and_say_every_problem(self) -> None:
        f = self.settings_file("forge_ulr: x\n")
        code, err = self.run_main("--port", "1", "--data-dir", str(self.dir), "--settings", str(f), "--max-long-side", "1024")
        self.assertEqual(code, 2)
        self.assertIn("forge_ulr: unknown setting", err)
        self.assertIn("families: at least one", err)

    def test_a_bad_max_long_side_exits_with_2(self) -> None:
        f = self.settings_file("families: {a: {match: [a], rating_tag: general}}\n")
        code, err = self.run_main("--port", "1", "--data-dir", str(self.dir), "--settings", str(f), "--max-long-side", "1000")
        self.assertEqual(code, 2)
        self.assertIn("multiple of 64", err)

    def test_a_missing_settings_file_exits_with_2_and_names_it(self) -> None:
        code, err = self.run_main("--port", "1", "--data-dir", str(self.dir), "--settings", str(self.dir / "no.yaml"), "--max-long-side", "1024")
        self.assertEqual(code, 2)
        self.assertIn("no.yaml", err)

    def test_prepare_fetches_the_rating_model_and_reports_the_result(self) -> None:
        f = self.settings_file("families: {a: {match: [a], rating_tag: general}}\n")
        args = ("--data-dir", str(self.dir), "--settings", str(f), "--max-long-side", "1024", "--prepare")
        with mock.patch.object(service_app, "load_tagger", return_value=object()) as load:
            code, _ = self.run_main(*args)
        self.assertEqual(code, 0)
        self.assertEqual(load.call_args.args[0], self.dir / "forge" / "tagger")
        with mock.patch.object(service_app, "load_tagger", side_effect=TaggerError("no network")):
            code, err = self.run_main(*args)
        self.assertEqual(code, 1)
        self.assertIn("no network", err)

    def test_the_port_is_required_to_serve(self) -> None:
        f = self.settings_file("families: {a: {match: [a], rating_tag: general}}\n")
        code, err = self.run_main("--data-dir", str(self.dir), "--settings", str(f), "--max-long-side", "1024")
        self.assertEqual(code, 2)
        self.assertIn("--port", err)


class ProcessTest(unittest.TestCase):
    """The real entry point in a real process: arguments, start-up, /health, /shutdown, exit code."""

    def test_it_starts_answers_and_stops_on_request(self) -> None:
        import urllib.error
        import urllib.request

        with tempfile.TemporaryDirectory() as tmp:
            words = Path(tmp) / "words.txt"
            words.write_text("nude\n", encoding="utf-8")
            settings = Path(tmp) / "settings.yaml"
            settings.write_text(
                "forge_url: http://127.0.0.1:1\nblocklist_files: [words.txt]\n"
                "families: {a: {match: [a], rating_tag: general}}\n",
                encoding="utf-8",
            )
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                port = s.getsockname()[1]
            proc = subprocess.Popen(
                [
                    sys.executable,
                    str(HERE / "run_with_fake_tagger.py"),
                    "--port", str(port),
                    "--data-dir", tmp,
                    "--settings", str(settings),
                    "--max-long-side", "768",
                ],
                cwd=HERE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            try:
                base = f"http://127.0.0.1:{port}"
                health = None
                for _ in range(300):
                    try:
                        with urllib.request.urlopen(f"{base}/health", timeout=1) as res:
                            health = json.loads(res.read())
                            if health["ready"]:
                                break
                    except (urllib.error.URLError, OSError):
                        pass
                    if proc.poll() is not None:
                        self.fail("the service exited early:\n" + (proc.stdout.read().decode(errors="replace") if proc.stdout else ""))
                    time.sleep(0.05)
                self.assertTrue(health and health["ready"])
                self.assertEqual(health["config"]["max_long_side"], 768)
                req = urllib.request.Request(f"{base}/shutdown", method="POST")
                with urllib.request.urlopen(req, timeout=2) as res:
                    self.assertEqual(json.loads(res.read()), {"ok": True})
                self.assertEqual(proc.wait(timeout=15), 0)
            finally:
                if proc.poll() is None:
                    proc.kill()
                if proc.stdout:
                    proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
