"""The Forge server (a Stable Diffusion WebUI started with --api), as far as this service uses it."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
from typing import Any

import aiohttp


class ForgeError(Exception):
    """Forge answered, but not with what was asked for (HTTP error, not JSON, no picture)."""

    code = "forge_error"


class ForgeUnreachable(ForgeError):
    code = "forge_unreachable"


class ForgeTimeout(ForgeError):
    code = "forge_timeout"


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class ForgeClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._session: aiohttp.ClientSession | None = None

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            # trust_env=False: Forge is on this machine or the LAN, a proxy from the environment must not be used
            self._session = aiohttp.ClientSession(trust_env=False)
        return self._session

    async def _call(self, method: str, path: str, *, body: Any = None, timeout: float) -> Any:
        url = f"{self.base_url}{path}"
        try:
            async with self._http().request(
                method, url, json=body, timeout=aiohttp.ClientTimeout(total=timeout)
            ) as res:
                text = await res.text()
                if res.status >= 400:
                    raise ForgeError(f"Forge answered {res.status} to {method} {path}: {' '.join(text.split())[:300]}")
        except ForgeError:
            raise
        except (asyncio.TimeoutError, TimeoutError) as e:
            raise ForgeTimeout(f"Forge did not answer {method} {path} within {timeout:g} s") from e
        except aiohttp.ClientConnectorError as e:
            raise ForgeUnreachable(f"cannot reach Forge at {self.base_url} ({e.strerror or e}); is it running with --api?") from e
        except aiohttp.ClientError as e:
            raise ForgeError(f"Forge failed {method} {path}: {e}") from e
        if not text.strip():
            return None
        try:
            return json.loads(text)
        except ValueError as e:
            raise ForgeError(f"Forge answered {method} {path} with something that is not JSON") from e

    # ─────────────────────────────── what the service asks ───────────────────────────────

    async def ping(self) -> None:
        await self._call("GET", "/sdapi/v1/options", timeout=3)

    async def checkpoints(self) -> list[dict[str, Any]]:
        data = await self._call("GET", "/sdapi/v1/sd-models", timeout=15)
        if not isinstance(data, list):
            raise ForgeError("Forge listed its checkpoints in a form this service does not understand")
        return [m for m in data if isinstance(m, dict) and isinstance(m.get("title"), str)]

    async def loras(self) -> list[dict[str, Any]]:
        data = await self._call("GET", "/sdapi/v1/loras", timeout=15)
        if not isinstance(data, list):
            raise ForgeError("Forge listed its LoRAs in a form this service does not understand")
        return [m for m in data if isinstance(m, dict) and isinstance(m.get("name"), str)]

    async def txt2img(self, payload: dict[str, Any], timeout: float) -> bytes:
        """One picture as PNG bytes. Anything else Forge returns is an error, never an empty picture."""
        data = await self._call("POST", "/sdapi/v1/txt2img", body=payload, timeout=timeout)
        images = data.get("images") if isinstance(data, dict) else None
        if not isinstance(images, list) or not images or not isinstance(images[0], str):
            raise ForgeError("Forge answered without a picture")
        try:
            png = base64.b64decode(images[0].split(",", 1)[-1], validate=True)
        except (binascii.Error, ValueError) as e:
            raise ForgeError("Forge returned a picture that is not valid base64") from e
        if not png.startswith(PNG_SIGNATURE):
            raise ForgeError("Forge returned a picture that is not a PNG")
        return png

    async def interrupt(self) -> None:
        """Stop what Forge is drawing. Best effort: the caller is already giving up."""
        try:
            await self._call("POST", "/sdapi/v1/interrupt", timeout=3)
        except ForgeError:
            pass

    async def unload(self) -> None:
        """Free the checkpoint's memory. Best effort."""
        try:
            await self._call("POST", "/sdapi/v1/unload-checkpoint", timeout=10)
        except ForgeError:
            pass
