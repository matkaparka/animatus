"""The HTTP service: health, settings, catalog and the one generation that may run at a time.

Every failure of real work is a non-2xx answer with `{error: {code, message, retryable}}` (and, for `/generate`, also
`status: "error"` and `reason`); a refusal of the content (`rejected`, `blocked`) is a normal answer that says so.
Nothing answers 200 with an empty or silent result.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import io
import json
import logging
import random
import sys
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from aiohttp import web

from . import __version__
from .blocklist import Blocklist, BlocklistError
from .catalog import CatalogProblem, check_loras, checkpoint_verdict, describe, find_checkpoint
from .forge import ForgeClient, ForgeError, ForgeTimeout
from .request import GenerateRequest, parse_generate
from .safety import EmptyPrompt, ForcedTagLost, build_prompts, fit_size
from .settings import Settings, SettingsError, load_settings, validate_max_long_side
from .state import StateFile, effective_max_long_side
from .tagger import Rates, TaggerHolder, load_tagger, rating_ok

log = logging.getLogger("forge")

MAX_BODY_BYTES = 64 * 1024


class Busy(Exception):
    """The queue is full, or the wait for the turn ran out."""


def error_response(
    status: int, code: str, message: str, *, retryable: bool = False, generate: bool = False
) -> web.Response:
    body: dict[str, Any] = {"error": {"code": code, "message": message[:1000], "retryable": retryable}}
    if generate:
        body = {"status": "error", "reason": code, **body}
    return web.json_response(body, status=status)


def _forge_status(e: ForgeError) -> int:
    return 504 if isinstance(e, ForgeTimeout) else 502


@web.middleware
async def guard_errors(request: web.Request, handler: Callable[..., Any]) -> web.StreamResponse:
    """A bug or a stray request never becomes an HTML page or a stack trace on the wire."""
    generate = request.path == "/generate"
    try:
        return await handler(request)
    except web.HTTPRequestEntityTooLarge:
        return error_response(413, "invalid_request", "the request body is too large", generate=generate)
    except web.HTTPBadRequest as e:
        return error_response(400, "invalid_request", e.reason or "bad request", generate=generate)
    except web.HTTPNotFound:
        return error_response(404, "not_found", "no such path")
    except web.HTTPMethodNotAllowed:
        return error_response(405, "method_not_allowed", "no such method for this path")
    except web.HTTPException as e:
        return error_response(e.status, "http_error", e.reason or "error", generate=generate)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        log.exception("unexpected failure on %s %s", request.method, request.path)
        return error_response(500, "internal_error", f"{type(e).__name__}: {e}", generate=generate)


class ForgeService:
    def __init__(
        self,
        settings: Settings,
        *,
        config_long_side: int,
        tagger_loader: Callable[[], Rates] | None = None,
        forge: ForgeClient | None = None,
        blocklist: Blocklist | None = None,
        watch_forge: bool = True,
        retry_tagger_sec: float = 60.0,
    ) -> None:
        self.settings = settings
        self.config_long_side = config_long_side
        self.state = StateFile(settings.data_dir / "state.json")
        self.max_long_side = effective_max_long_side(config_long_side, self.state.load())
        self.forge = forge or ForgeClient(settings.forge_url)
        self.blocklist = blocklist or Blocklist(settings.blocklist_files)
        self.tagger = TaggerHolder(
            tagger_loader or (lambda: load_tagger(settings.tagger.dir, settings.tagger.repo)),
            retry_sec=retry_tagger_sec,
        )
        self.stopping = asyncio.Event()
        self._watch_forge = watch_forge
        self._tasks: list[asyncio.Task[None]] = []
        self._lock = asyncio.Lock()
        self.waiting = 0
        self.busy = False
        self.last_error: str | None = None
        self.forge_reachable: bool | None = None
        self.forge_error: str | None = None

    # ─────────────────────────────── application ───────────────────────────────

    def make_app(self) -> web.Application:
        app = web.Application(middlewares=[guard_errors], client_max_size=MAX_BODY_BYTES)
        app.router.add_get("/health", self.health)
        app.router.add_post("/config", self.set_config)
        app.router.add_get("/catalog", self.catalog)
        app.router.add_post("/generate", self.generate)
        app.router.add_post("/shutdown", self.shutdown)
        app.on_startup.append(self._start_background)
        app.on_cleanup.append(self._stop_background)
        return app

    async def _start_background(self, _app: web.Application) -> None:
        # the rating model is fetched and loaded here, in a thread, outside the queue
        self._tasks.append(asyncio.create_task(self.tagger.run()))
        if self._watch_forge:
            self._tasks.append(asyncio.create_task(self._watch()))

    async def _stop_background(self, _app: web.Application) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.forge.close()

    async def _watch(self) -> None:
        """Is Forge there? Asked in the background so that `/health` never waits for it; not while it is drawing."""
        while True:
            if not self.busy:
                await self.check_forge()
            await asyncio.sleep(self.settings.forge_check_sec)

    async def check_forge(self) -> None:
        try:
            await self.forge.ping()
            self.forge_reachable, self.forge_error = True, None
        except Exception as e:  # the watcher must never die, whatever the failure looks like
            self.forge_reachable, self.forge_error = False, str(e)

    async def _json(self, request: web.Request) -> Any:
        body = await request.read()
        try:
            return json.loads(body.decode("utf-8-sig"))
        except ValueError as e:
            raise web.HTTPBadRequest(reason="the body is not JSON") from e

    # ─────────────────────────────── health ───────────────────────────────

    def _readiness(self) -> tuple[bool, bool, str]:
        """(ok, ready, detail): ok is false when a safety layer is broken, ready is false while one is still loading."""
        try:
            self.blocklist.check()
        except BlocklistError as e:
            return False, False, str(e)
        if self.tagger.state == "failed":
            return False, False, f"the rating model is not available: {self.tagger.error}"
        if self.tagger.state != "ready":
            return True, False, "loading the rating model (the first start fetches about 400 MB)"
        if self.forge_reachable is False:
            return True, True, f"Forge is not reachable: {self.forge_error}"
        return True, True, ""

    async def health(self, _request: web.Request) -> web.Response:
        ok, ready, detail = self._readiness()
        body: dict[str, Any] = {
            "ok": ok,
            "ready": ready,
            "service": "forge",
            "version": __version__,
            "config": {
                "max_long_side": self.max_long_side,
                "forge_url": self.settings.forge_url,
                "forge_reachable": self.forge_reachable,
                "forge_error": self.forge_error,
                "rating_model": self.tagger.state,
                "queue_waiting": self.waiting,
                "queue_max": self.settings.limits.queue_max,
                "busy": self.busy,
                "blocklist_words": self.blocklist.words,
                "last_error": self.last_error,
            },
        }
        if detail:
            body["detail"] = detail
        return web.json_response(body, status=200 if ok else 503)

    # ─────────────────────────────── settings and catalog ───────────────────────────────

    async def set_config(self, request: web.Request) -> web.Response:
        raw = await self._json(request)
        if not isinstance(raw, dict) or set(raw) != {"max_long_side"}:
            return error_response(400, "invalid_request", "the body must be exactly {max_long_side: number}")
        try:
            value = validate_max_long_side(raw["max_long_side"])
        except ValueError as e:
            return error_response(400, "invalid_config", str(e))
        try:
            # written first: a value that could not be kept is not applied
            self.state.save({"max_long_side": value, "config_value": self.config_long_side})
        except OSError as e:
            return error_response(500, "state_not_saved", f"the setting could not be saved ({e.strerror or e})")
        self.max_long_side = value
        return web.json_response({"ok": True, "config": {"max_long_side": value}})

    async def catalog(self, _request: web.Request) -> web.Response:
        try:
            models = await self.forge.checkpoints()
            installed = await self.forge.loras()
        except ForgeError as e:
            return error_response(_forge_status(e), e.code, str(e), retryable=True)
        view = describe(self.settings, models, installed)
        return web.json_response(
            {
                "checkpoints": view.checkpoints,
                "loras": view.loras,
                "families": [f.name for f in self.settings.families],
                "max_long_side": self.max_long_side,
            }
        )

    async def shutdown(self, _request: web.Request) -> web.Response:
        asyncio.get_running_loop().call_later(0.05, self.stopping.set)
        return web.json_response({"ok": True})

    # ─────────────────────────────── one generation at a time ───────────────────────────────

    @contextlib.asynccontextmanager
    async def _turn(self) -> AsyncIterator[None]:
        """The turn at Forge: at most `queue_max` requests wait, none for longer than `queue_wait_sec`."""
        limits = self.settings.limits
        if self.waiting >= limits.queue_max:
            raise Busy(f"{self.waiting} requests are already waiting")
        self.waiting += 1
        try:
            await asyncio.wait_for(self._lock.acquire(), limits.queue_wait_sec)
        except (asyncio.TimeoutError, TimeoutError) as e:
            raise Busy(f"no turn within {limits.queue_wait_sec:g} s") from e
        finally:
            self.waiting -= 1
        self.busy = True
        try:
            yield
        finally:
            self.busy = False
            self._lock.release()

    async def _txt2img(self, payload: dict[str, Any]) -> bytes:
        try:
            return await self.forge.txt2img(payload, self.settings.limits.generate_timeout_sec)
        except (asyncio.CancelledError, ForgeTimeout):
            # whoever asked gave up (or Forge is too slow): Forge must stop drawing, or it keeps the card busy
            await self.forge.interrupt()
            raise

    async def _thumbnail(self, png: bytes) -> str | None:
        side = self.settings.thumb_side

        def make() -> str:
            from PIL import Image

            img = Image.open(io.BytesIO(png)).convert("RGB")
            img.thumbnail((side, side))
            out = io.BytesIO()
            img.save(out, "JPEG", quality=80)
            return base64.b64encode(out.getvalue()).decode("ascii")

        try:
            return await asyncio.to_thread(make)
        except Exception as e:  # the picture is fine without it; the caller falls back to the full picture
            log.warning("no thumbnail: %s", e)
            return None

    async def generate(self, request: web.Request) -> web.Response:
        started = time.monotonic()
        raw = await self._json(request)
        req, problems = parse_generate(raw, self.settings)
        if req is None:
            return error_response(400, "invalid_request", "; ".join(problems), generate=True)

        ok, ready, detail = self._readiness()
        if not ok:
            return error_response(503, "unavailable", detail, retryable=True, generate=True)
        if not ready:
            return error_response(503, "not_ready", detail, retryable=True, generate=True)

        try:
            prepared = await self._prepare(req)
        except CatalogProblem as e:
            return error_response(422, e.code, str(e), generate=True)
        except ForgeError as e:
            self._failed(e)
            return error_response(_forge_status(e), e.code, str(e), retryable=True, generate=True)
        except EmptyPrompt:
            return web.json_response({"status": "rejected", "reason": "empty_prompt"})
        except ForcedTagLost as e:
            self.last_error = str(e)
            return error_response(500, "safety_config", str(e), generate=True)
        payload, checkpoint, family, scrubbed, size = prepared

        try:
            async with self._turn():
                result = await self._draw(req, payload, checkpoint, family, scrubbed, size, started)
        except Busy as e:
            return error_response(503, "busy", str(e), retryable=True, generate=True)
        except ForgeError as e:
            self._failed(e)
            return error_response(_forge_status(e), e.code, str(e), retryable=True, generate=True)
        if result.get("status") == "ok":
            self.last_error = None
        return web.json_response(result)

    def _failed(self, e: Exception) -> None:
        self.last_error = str(e)
        if isinstance(e, ForgeError) and e.code == "forge_unreachable":
            self.forge_reachable, self.forge_error = False, str(e)

    async def _prepare(
        self, req: GenerateRequest
    ) -> tuple[dict[str, Any], str, str, tuple[str, ...], tuple[int, int]]:
        """Layers 1 and 2 and every check that needs Forge's lists; nothing here holds the turn."""
        models = await self.forge.checkpoints()
        model = find_checkpoint(models, req.checkpoint)
        family, why = checkpoint_verdict(self.settings, model)
        if family is None or why is not None:
            code = "unknown_family" if family is None else "checkpoint_not_allowed"
            raise CatalogProblem(code, f'the checkpoint "{req.checkpoint}" cannot be used: {why}')
        if req.loras:
            check_loras(self.settings, await self.forge.loras(), [name for name, _ in req.loras])
        built = build_prompts(
            self.settings, family, self.blocklist, req.prompt, req.negative_prompt, list(req.loras)
        )
        size = fit_size(req.width, req.height, self.max_long_side)
        payload: dict[str, Any] = {
            "prompt": built.prompt,
            "negative_prompt": built.negative,
            "steps": req.steps,
            "cfg_scale": req.cfg_scale,
            "sampler_name": req.sampler_name,
            "width": size[0],
            "height": size[1],
            "batch_size": 1,
            "n_iter": 1,
            "enable_hr": False,
            "restore_faces": False,
            "tiling": False,
            "send_images": True,
            "save_images": False,
            "do_not_save_samples": True,
            "do_not_save_grid": True,
            "override_settings": {"sd_model_checkpoint": model["title"]},
            # the checkpoint the route asked for stays loaded: the next picture on it needs no reload
            "override_settings_restore_afterwards": False,
        }
        if req.scheduler:
            payload["scheduler"] = req.scheduler
        return payload, model["title"], family.name, built.scrubbed, size

    async def _draw(
        self,
        req: GenerateRequest,
        payload: dict[str, Any],
        checkpoint: str,
        family: str,
        scrubbed: tuple[str, ...],
        size: tuple[int, int],
        started: float,
    ) -> dict[str, Any]:
        """Layer 3: draw, look at the picture, and draw again with another seed if it is not safe. Runs under the turn."""
        tag = self.settings.tagger
        allow_sensitive = req.route in self.settings.allow_sensitive_routes
        seed = req.seed if req.seed >= 0 else random.randrange(2**32)
        seen: list[dict[str, float]] = []
        for attempt in range(1 + tag.retries):
            payload = {**payload, "seed": seed}
            png = await self._txt2img(payload)
            rater = self.tagger.tagger
            if rater is None:
                raise ForgeError("the rating model is gone")  # cannot happen once ready; refuse rather than pass
            ratings = await asyncio.to_thread(rater.rate, png)
            seen.append(ratings)
            passed = rating_ok(
                ratings, allow_sensitive=allow_sensitive, max_bad=tag.max_questionable_plus_explicit
            )
            log.info(
                "route %s attempt %d: %s",
                req.route,
                attempt + 1,
                {k: round(v, 3) for k, v in ratings.items()} | {"passed": passed},
            )
            if passed:
                return {
                    "status": "ok",
                    "image_b64": base64.b64encode(png).decode("ascii"),
                    "thumb_b64": await self._thumbnail(png),
                    "width": size[0],
                    "height": size[1],
                    "seed": seed,
                    "attempts": attempt + 1,
                    "ratings": ratings,
                    "checkpoint": checkpoint,
                    "family": family,
                    "scrubbed": len(scrubbed),
                    "elapsed_ms": round((time.monotonic() - started) * 1000),
                }
            seed = random.randrange(2**32)
        # the picture is dropped here: it was never written anywhere and is not returned
        return {
            "status": "blocked",
            "reason": "rating",
            "attempts": len(seen),
            "ratings": seen[-1],
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }


# ─────────────────────────────── running it ───────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Forge executor service (see docs/mode-draw.md)")
    p.add_argument("--port", type=int, help="port to listen on (127.0.0.1)")
    p.add_argument("--data-dir", required=True, help="the program's data folder; the service uses <data-dir>/forge")
    p.add_argument("--settings", required=True, help="the settings YAML file")
    p.add_argument("--max-long-side", type=int, required=True, help="longest side of a picture, a multiple of 64")
    p.add_argument("--prepare", action="store_true", help="fetch and check the rating model, then exit")
    return p


async def serve(
    settings: Settings,
    *,
    port: int,
    config_long_side: int,
    tagger_loader: Callable[[], Rates] | None = None,
) -> int:
    service = ForgeService(settings, config_long_side=config_long_side, tagger_loader=tagger_loader)
    # a picture still being drawn when the service is told to stop gets a moment, then its handler is cancelled
    runner = web.AppRunner(
        service.make_app(), handler_cancellation=True, shutdown_timeout=1.0, access_log=None
    )
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    log.info("listening on http://127.0.0.1:%d (Forge at %s)", port, settings.forge_url)
    try:
        await service.stopping.wait()
    finally:
        if service.busy:
            # a picture is in the making: Forge is told to stop now, before the handlers are cut and the client closed
            await service.forge.interrupt()
        await runner.cleanup()
        if settings.unload_on_stop:
            await service.forge.unload()
        await service.forge.close()
    return 0


def prepare(settings: Settings) -> int:
    try:
        load_tagger(settings.tagger.dir, settings.tagger.repo)
    except Exception as e:
        print(f"forge: {e}", file=sys.stderr)
        return 1
    print(f"forge: the rating model is in {settings.tagger.dir} and loads")
    return 0


def main(argv: list[str] | None = None, *, tagger_loader: Callable[[], Rates] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        max_long_side = validate_max_long_side(args.max_long_side)
        settings = load_settings(Path(args.settings), data_dir=Path(args.data_dir) / "forge")
    except (SettingsError, ValueError) as e:
        print(f"forge: the settings cannot be used:\n{e}", file=sys.stderr)
        return 2
    if args.prepare:
        return prepare(settings)
    if args.port is None:
        print("forge: --port is required", file=sys.stderr)
        return 2
    try:
        return asyncio.run(
            serve(settings, port=args.port, config_long_side=max_long_side, tagger_loader=tagger_loader)
        )
    except KeyboardInterrupt:
        return 130
