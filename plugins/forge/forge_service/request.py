"""The body of `POST /generate`, checked strictly.

Only the fields listed here are accepted, so a caller cannot slip anything else into the Forge request
(`override_settings`, `alwayson_scripts`, `script_name`, hires, a save path ...): the service builds that request itself.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .settings import Settings

_ROUTE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_SAMPLER = re.compile(r"^[A-Za-z0-9+ ._-]{1,64}$")

FIELDS = frozenset(
    {
        "checkpoint",
        "prompt",
        "negative_prompt",
        "width",
        "height",
        "steps",
        "cfg_scale",
        "sampler_name",
        "scheduler",
        "seed",
        "loras",
        "route",
    }
)


@dataclass(frozen=True)
class GenerateRequest:
    checkpoint: str
    prompt: str
    negative_prompt: str
    width: int
    height: int
    steps: int
    cfg_scale: float
    sampler_name: str
    scheduler: str | None
    seed: int
    loras: tuple[tuple[str, float], ...]
    route: str


def _number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _whole(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def parse_generate(raw: Any, settings: Settings) -> tuple[GenerateRequest | None, list[str]]:
    """The request, or the list of everything that is wrong with it."""
    if not isinstance(raw, dict):
        return None, ["the body must be a JSON object"]
    problems: list[str] = []
    for key in raw:
        if key not in FIELDS:
            problems.append(f"{key}: not a field of this request")

    def text(key: str, lo: int, hi: int, *, required: bool = True, default: str = "") -> str:
        v = raw.get(key)
        if v is None:
            if required:
                problems.append(f"{key}: required")
            return default
        if not isinstance(v, str) or not lo <= len(v.strip()) <= hi:
            problems.append(f"{key}: text of {lo} to {hi} characters expected")
            return default
        return v.strip()

    def whole(key: str, lo: int, hi: int, *, default: int | None = None) -> int:
        v = raw.get(key)
        if v is None and default is not None:
            return default
        if not _whole(v) or not lo <= v <= hi:
            problems.append(f"{key}: whole number from {lo} to {hi} expected")
            return lo
        return v

    checkpoint = text("checkpoint", 1, 300)
    prompt = text("prompt", 1, 4000)
    negative = text("negative_prompt", 0, 2000, required=False)
    width = whole("width", 64, 4096)
    height = whole("height", 64, 4096)
    steps = whole("steps", 1, settings.limits.max_steps)
    seed = whole("seed", -1, 2**32 - 1, default=-1)

    cfg = raw.get("cfg_scale")
    if not _number(cfg) or not 0 <= cfg <= 30:
        problems.append("cfg_scale: number from 0 to 30 expected")
        cfg = 0.0

    def name_of(key: str, *, required: bool) -> str | None:
        v = raw.get(key)
        if v is None:
            if required:
                problems.append(f"{key}: required")
            return None
        if not isinstance(v, str) or not _SAMPLER.match(v):
            problems.append(f"{key}: letters, digits and + . _ - only, up to 64 characters")
            return None
        return v

    sampler = name_of("sampler_name", required=True) or ""
    scheduler = name_of("scheduler", required=False)

    route = raw.get("route")
    if not isinstance(route, str) or not _ROUTE.match(route):
        problems.append("route: a lowercase name (letters, digits, - and _) expected")
        route = ""

    loras: list[tuple[str, float]] = []
    raw_loras = raw.get("loras", [])
    if not isinstance(raw_loras, list) or len(raw_loras) > settings.max_loras:
        problems.append(f"loras: a list of at most {settings.max_loras} entries expected")
    else:
        for i, item in enumerate(raw_loras):
            ok = isinstance(item, dict) and set(item) == {"name", "weight"}
            if not ok or not isinstance(item["name"], str) or not 1 <= len(item["name"]) <= 200:
                problems.append(f"loras[{i}]: {{name, weight}} expected")
            elif not _number(item["weight"]) or not 0.1 <= item["weight"] <= 1.5:
                problems.append(f"loras[{i}].weight: number from 0.1 to 1.5 expected")
            else:
                loras.append((item["name"], float(item["weight"])))

    if problems:
        return None, problems
    return (
        GenerateRequest(
            checkpoint=checkpoint,
            prompt=prompt,
            negative_prompt=negative,
            width=width,
            height=height,
            steps=steps,
            cfg_scale=float(cfg),
            sampler_name=sampler,
            scheduler=scheduler,
            seed=seed,
            loras=tuple(loras),
            route=route,
        ),
        [],
    )
