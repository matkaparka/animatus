"""Stand-ins for the tests of the forge service: a Forge server, a rating model, a settings mapping.

No picture and no model file is kept anywhere: the pictures are 2x2 PNGs made when a test runs.
"""

from __future__ import annotations

import asyncio
import base64
import io
from pathlib import Path
from typing import Any

from aiohttp import web
from aiohttp.test_utils import TestServer

from forge_service.settings import Settings, parse_settings

PROMPT_WORDS = ("1girl, solo, standing", "a dragon, mountains")


def make_png(color: tuple[int, int, int] = (200, 30, 30), size: tuple[int, int] = (2, 2)) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "PNG")
    return out.getvalue()


def settings_mapping(**over: Any) -> dict[str, Any]:
    """A valid settings mapping. The blocklist file is written by the test (`blocklist_files`)."""
    base: dict[str, Any] = {
        "forge_url": "http://127.0.0.1:1",
        "families": {
            "anime": {
                "match": ["anime-xl"],
                "arch": "sdxl",
                "rating_tag": "general",
                "extra_negative": "(sensitive, questionable:1.2)",
            },
            "pony": {
                "match": ["pony-real"],
                "arch": "sdxl",
                "rating_tag": "rating_safe",
                "extra_negative": "(rating_explicit:1.3)",
            },
            "heavy": {"match": ["flux-thing"], "arch": "flux1", "rating_tag": "general"},
        },
        "lora_allowlist": ["sword-lora"],
        "allow_sensitive_routes": ["self"],
        "tagger": {"retries": 1, "max_questionable_plus_explicit": 0.15},
        "limits": {"queue_max": 2, "queue_wait_sec": 5, "generate_timeout_sec": 5, "max_steps": 60},
        "forge_check_sec": 2,
        "thumb_side": 128,
    }
    base.update(over)
    return base


def make_settings(tmp: Path, **over: Any) -> Settings:
    words = tmp / "words.txt"
    if not words.exists():
        words.write_text("# test list\nnude\nnaked\nsex\n色情\nsee-through\n", encoding="utf-8")
    mapping = settings_mapping(blocklist_files=[str(words)], **over)
    return parse_settings(mapping, base_dir=tmp, data_dir=tmp / "data")


class FakeTagger:
    """`rate` answers from a script of rating dicts, then repeats the last one."""

    def __init__(self, *script: dict[str, float]) -> None:
        self.script = list(script) or [GOOD]
        self.calls = 0
        self.pngs: list[bytes] = []

    def rate(self, png: bytes) -> dict[str, float]:
        self.pngs.append(png)
        i = min(self.calls, len(self.script) - 1)
        self.calls += 1
        return dict(self.script[i])


GOOD = {"general": 0.9, "sensitive": 0.08, "questionable": 0.01, "explicit": 0.01}
SENSITIVE_TOP = {"general": 0.2, "sensitive": 0.7, "questionable": 0.05, "explicit": 0.05}
QUESTIONABLE = {"general": 0.3, "sensitive": 0.2, "questionable": 0.4, "explicit": 0.1}
NSFW_SENSITIVE = {"general": 0.1, "sensitive": 0.5, "questionable": 0.3, "explicit": 0.1}


class FakeForge:
    """An A1111-style server on a real local port. `txt2img_mode` picks how the next drawings go."""

    def __init__(self) -> None:
        self.models = [
            {"title": "anime-xl-v1.safetensors [abcd1234]", "model_name": "anime-xl-v1"},
            {"title": "sub/pony-real-v6.safetensors [ef567890]", "model_name": "pony-real-v6"},
            {"title": "flux-thing.safetensors [11112222]", "model_name": "flux-thing"},
            {"title": "anime-xl-v2.safetensors [33334444]", "model_name": "anime-xl-v2"},
            {"title": "misc-merge.safetensors [55556666]", "model_name": "misc-merge"},
        ]
        self.loras = [
            {"name": "sword-lora", "alias": "SwordStyle", "path": "x"},
            {"name": "other-lora", "alias": None, "path": "y"},
        ]
        self.txt2img_mode = "ok"
        self.png = make_png()
        self.txt2img_payloads: list[dict[str, Any]] = []
        self.gate: asyncio.Event | None = None
        self.started = asyncio.Event()
        self.running = 0
        self.peak = 0
        self.interrupts = 0
        self.unloads = 0
        self.pings = 0
        self.delay = 0.0
        self.server: TestServer | None = None

    @property
    def url(self) -> str:
        assert self.server is not None
        return str(self.server.make_url("")).rstrip("/")

    async def start(self) -> None:
        app = web.Application()
        app.router.add_get("/sdapi/v1/options", self._options)
        app.router.add_get("/sdapi/v1/sd-models", self._models)
        app.router.add_get("/sdapi/v1/loras", self._loras)
        app.router.add_post("/sdapi/v1/txt2img", self._txt2img)
        app.router.add_post("/sdapi/v1/interrupt", self._interrupt)
        app.router.add_post("/sdapi/v1/unload-checkpoint", self._unload)
        self.server = TestServer(app)
        await self.server.start_server()

    async def stop(self) -> None:
        if self.server is not None:
            await self.server.close()

    async def _options(self, _r: web.Request) -> web.Response:
        self.pings += 1
        return web.json_response({"sd_model_checkpoint": "anime-xl-v1"})

    async def _models(self, _r: web.Request) -> web.Response:
        return web.json_response(self.models)

    async def _loras(self, _r: web.Request) -> web.Response:
        return web.json_response(self.loras)

    async def _interrupt(self, _r: web.Request) -> web.Response:
        self.interrupts += 1
        if self.gate is not None:
            self.gate.set()
        return web.json_response({})

    async def _unload(self, _r: web.Request) -> web.Response:
        self.unloads += 1
        return web.json_response({})

    async def _txt2img(self, request: web.Request) -> web.Response:
        payload = await request.json()
        self.txt2img_payloads.append(payload)
        self.running += 1
        self.peak = max(self.peak, self.running)
        self.started.set()
        try:
            if self.gate is not None:
                await self.gate.wait()
            if self.delay:
                await asyncio.sleep(self.delay)
            mode = self.txt2img_mode
            if mode == "http500":
                return web.Response(status=500, text="CUDA out of memory")
            if mode == "notjson":
                return web.Response(text="<html>oops</html>", content_type="text/html")
            if mode == "noimages":
                return web.json_response({"images": []})
            if mode == "notpng":
                return web.json_response({"images": [base64.b64encode(b"GIF89a....").decode()]})
            if mode == "badbase64":
                return web.json_response({"images": ["!!!not base64!!!"]})
            return web.json_response({"images": [base64.b64encode(self.png).decode()], "info": "{}"})
        finally:
            self.running -= 1
