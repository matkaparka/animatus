"""The settings of the forge service, read from one YAML file (see settings.example.yaml).

Everything that decides what may be drawn lives here and nowhere else: the model families with their forced safe tags,
which checkpoints and LoRAs are allowed, the blocklist files, the rating model, the queue limits. A typo is an error
(unknown keys are refused), every problem is reported at once, and there are no private names in the code.

`max_long_side` is not here: the plugin config passes it on the command line, and the console changes it at run time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

#: the baseline list that ships with the service; the example settings point at it
DEFAULT_BLOCKLIST = Path(__file__).resolve().parent.parent / "blocklist.default.txt"

#: tags that must never be forced onto a prompt: in danbooru-style models `underwear` asks for underwear to be shown
NEVER_FORCED = frozenset({"underwear"})

MIN_LONG_SIDE = 512
MAX_LONG_SIDE = 2048


class SettingsError(Exception):
    """The settings cannot be used. The message lists every problem, one per line."""


@dataclass(frozen=True)
class Family:
    """A group of checkpoints that share how a safe picture is asked for (Pony, Illustrious, ...)."""

    name: str
    #: substrings of the checkpoint name (case-insensitive) that put a checkpoint in this family
    match: tuple[str, ...]
    arch: str
    #: the rating tag of this family, put first in the positive prompt (`rating_safe`, `general`)
    rating_tag: str
    #: added to the negative prompt for this family only
    extra_negative: str


@dataclass(frozen=True)
class TaggerSettings:
    repo: str
    dir: Path
    max_questionable_plus_explicit: float
    #: how many more pictures are tried, with another seed, after one is refused
    retries: int


@dataclass(frozen=True)
class Limits:
    #: requests that may wait behind the picture being drawn
    queue_max: int
    queue_wait_sec: float
    generate_timeout_sec: float
    max_steps: int


@dataclass(frozen=True)
class Settings:
    forge_url: str
    blocklist_files: tuple[Path, ...]
    families: tuple[Family, ...]
    allowed_archs: tuple[str, ...]
    #: name fragments; empty means every checkpoint of an allowed family
    allowed_checkpoints: tuple[str, ...]
    #: empty means no LoRA at all
    lora_allowlist: tuple[str, ...]
    max_loras: int
    extra_positive: str
    extra_negative: str
    #: route names that may pass a picture the rating model calls `sensitive` (a white breastplate looks like skin)
    allow_sensitive_routes: tuple[str, ...]
    tagger: TaggerSettings
    limits: Limits
    unload_on_stop: bool
    thumb_side: int
    forge_check_sec: float
    #: the service's own folder for state and the rating model
    data_dir: Path


def validate_max_long_side(value: Any) -> int:
    """A multiple of 64 between 512 and 2048. Raises ValueError with a sentence that says what is wrong."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("max_long_side must be a whole number")
    if value % 64 != 0:
        raise ValueError("max_long_side must be a multiple of 64")
    if value < MIN_LONG_SIDE:
        raise ValueError(f"max_long_side must be at least {MIN_LONG_SIDE}")
    if value > MAX_LONG_SIDE:
        raise ValueError(f"max_long_side must be at most {MAX_LONG_SIDE}")
    return value


_MISSING: Any = object()
_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_URL = re.compile(r"^https?://[^\s/]+[^\s]*$")


class _Reader:
    """Reads one mapping key by key. Problems are collected so the operator sees all of them in one go."""

    def __init__(self, raw: Any, path: str, problems: list[str]) -> None:
        self._path = path
        self._problems = problems
        self._seen: set[str] = set()
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            problems.append(f"{path or 'the settings'}: expected a mapping (key: value lines)")
            raw = {}
        self._raw: dict[str, Any] = raw

    def _name(self, key: str) -> str:
        return f"{self._path}.{key}" if self._path else key

    def _get(self, key: str, default: Any) -> Any:
        self._seen.add(key)
        if key in self._raw and self._raw[key] is not None:
            return self._raw[key]
        if default is _MISSING:
            self._problems.append(f"{self._name(key)}: required")
            return None
        return default

    def str(self, key: str, default: Any = _MISSING, *, allow_empty: bool = False) -> str:
        v = self._get(key, default)
        if v is None:
            return ""
        if not isinstance(v, str) or (not allow_empty and not v.strip()):
            self._problems.append(f"{self._name(key)}: expected {'text' if allow_empty else 'non-empty text'}")
            return ""
        return v.strip()

    def number(self, key: str, default: Any, lo: float, hi: float, *, integer: bool = False) -> float:
        v = self._get(key, default)
        ok = isinstance(v, (int, float)) and not isinstance(v, bool) and (not integer or float(v).is_integer())
        if not ok or not lo <= v <= hi:
            kind = "a whole number" if integer else "a number"
            self._problems.append(f"{self._name(key)}: expected {kind} from {lo:g} to {hi:g}")
            return default if default is not _MISSING else lo
        return int(v) if integer else float(v)

    def boolean(self, key: str, default: bool) -> bool:
        v = self._get(key, default)
        if not isinstance(v, bool):
            self._problems.append(f"{self._name(key)}: expected true or false")
            return default
        return v

    def strings(self, key: str, default: Any = (), *, min_items: int = 0) -> tuple[str, ...]:
        v = self._get(key, default)
        items = list(v) if isinstance(v, (list, tuple)) else None
        if items is None or not all(isinstance(x, str) and x.strip() for x in items):
            self._problems.append(f"{self._name(key)}: expected a list of non-empty text")
            return ()
        if len(items) < min_items:
            self._problems.append(f"{self._name(key)}: at least {min_items} entr{'y' if min_items == 1 else 'ies'} needed")
        return tuple(x.strip() for x in items)

    def mapping(self, key: str) -> dict[str, Any]:
        v = self._get(key, {})
        if not isinstance(v, dict):
            self._problems.append(f"{self._name(key)}: expected a mapping")
            return {}
        return v

    def section(self, key: str) -> _Reader:
        return _Reader(self._get(key, {}), self._name(key), self._problems)

    def done(self) -> None:
        for key in self._raw:
            if key not in self._seen:
                self._problems.append(f"{self._name(str(key))}: unknown setting (a typo?)")


def _resolve(base: Path, value: str) -> Path:
    p = Path(value).expanduser()
    return p if p.is_absolute() else (base / p).resolve()


def parse_settings(raw: Any, *, base_dir: Path, data_dir: Path) -> Settings:
    """Check a parsed settings mapping. Relative paths are relative to `base_dir` (the settings file's folder)."""
    problems: list[str] = []
    r = _Reader(raw, "", problems)

    forge_url = r.str("forge_url", "http://127.0.0.1:7860").rstrip("/")
    if forge_url and not _URL.match(forge_url):
        problems.append("forge_url: expected an http:// or https:// address")
    blocklist_files = tuple(
        _resolve(base_dir, p) for p in r.strings("blocklist_files", (str(DEFAULT_BLOCKLIST),), min_items=1)
    )

    families: list[Family] = []
    raw_families = r.mapping("families")
    if not raw_families:
        problems.append("families: at least one model family is needed (each says how a safe picture is asked for)")
    for name, body in raw_families.items():
        path = f"families.{name}"
        if not isinstance(name, str) or not _NAME.match(name):
            problems.append(f"{path}: a family name is lowercase letters, digits, - and _")
            continue
        fr = _Reader(body, path, problems)
        families.append(
            Family(
                name=name,
                match=fr.strings("match", min_items=1),
                arch=fr.str("arch", "sdxl"),
                rating_tag=fr.str("rating_tag"),
                extra_negative=fr.str("extra_negative", "", allow_empty=True),
            )
        )
        fr.done()

    allowed_archs = r.strings("allowed_archs", ("sdxl",), min_items=1)
    if families and allowed_archs and not any(f.arch in allowed_archs for f in families):
        problems.append("allowed_archs: none of the families has an allowed architecture, nothing could be drawn")
    extra_positive = r.str("extra_positive", "clothed", allow_empty=True)
    forced = [t.strip().lower() for f in families for t in (f.rating_tag, *extra_positive.split(","))]
    for bad in sorted(NEVER_FORCED.intersection(forced)):
        problems.append(f"the forced tag \"{bad}\" pushes pictures towards showing it; use another (e.g. clothed)")

    tagger = r.section("tagger")
    tagger_settings = TaggerSettings(
        repo=tagger.str("repo", "SmilingWolf/wd-vit-tagger-v3"),
        dir=_resolve(base_dir, tagger.str("dir", str(data_dir / "tagger"))),
        max_questionable_plus_explicit=tagger.number("max_questionable_plus_explicit", 0.15, 0.001, 1.0),
        retries=int(tagger.number("retries", 1, 0, 3, integer=True)),
    )
    tagger.done()

    limits = r.section("limits")
    limit_settings = Limits(
        queue_max=int(limits.number("queue_max", 3, 1, 50, integer=True)),
        queue_wait_sec=limits.number("queue_wait_sec", 600, 1, 3600),
        generate_timeout_sec=limits.number("generate_timeout_sec", 300, 5, 3600),
        max_steps=int(limits.number("max_steps", 100, 1, 300, integer=True)),
    )
    limits.done()

    settings = Settings(
        forge_url=forge_url,
        blocklist_files=blocklist_files,
        families=tuple(families),
        allowed_archs=allowed_archs,
        allowed_checkpoints=r.strings("allowed_checkpoints"),
        lora_allowlist=r.strings("lora_allowlist"),
        max_loras=int(r.number("max_loras", 2, 0, 8, integer=True)),
        extra_positive=extra_positive,
        extra_negative=r.str(
            "extra_negative", "(nsfw, explicit, nude, naked, nipples, genitals, sex:1.4)", allow_empty=True
        ),
        allow_sensitive_routes=r.strings("allow_sensitive_routes"),
        tagger=tagger_settings,
        limits=limit_settings,
        unload_on_stop=r.boolean("unload_on_stop", True),
        thumb_side=int(r.number("thumb_side", 512, 128, 2048, integer=True)),
        forge_check_sec=r.number("forge_check_sec", 10, 2, 300),
        data_dir=data_dir,
    )
    r.done()
    if problems:
        raise SettingsError("\n".join(f"  {p}" for p in problems))
    return settings


def load_settings(path: Path, *, data_dir: Path) -> Settings:
    """Read the settings file. A missing or unreadable file is an error that names it."""
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    except OSError as e:
        raise SettingsError(f"  the settings file cannot be read: {path} ({e.strerror or e})") from e
    except yaml.YAMLError as e:
        raise SettingsError(f"  the settings file is not valid YAML: {path} ({str(e).splitlines()[0]})") from e
    return parse_settings(raw, base_dir=path.resolve().parent, data_dir=data_dir)
