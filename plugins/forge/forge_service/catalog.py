"""What Forge has, and what this service lets it be used for: checkpoints with their family, LoRAs with the allowlist."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

from .settings import Family, Settings

_HASH_SUFFIX = re.compile(r"\s*\[[0-9a-fA-F]+\]\s*$")


class CatalogProblem(Exception):
    """A name the caller used does not lead to one usable checkpoint or LoRA."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def stem(name: str) -> str:
    """`folder\\model.safetensors [1a2b3c4d]` -> `model`."""
    base = _HASH_SUFFIX.sub("", str(name or "")).replace("\\", "/").rsplit("/", 1)[-1]
    return os.path.splitext(base)[0].lower()


def model_name(model: dict[str, Any]) -> str:
    return str(model.get("model_name") or stem(model["title"]))


def _haystack(model: dict[str, Any]) -> str:
    return f"{model['title']} {model_name(model)}".lower()


def find_checkpoint(models: list[dict[str, Any]], wanted: str) -> dict[str, Any]:
    """The Forge checkpoint a name means: exact (title, name or file stem) first, else the only one that contains it."""
    w = wanted.strip().lower()
    exact = [m for m in models if w in {m["title"].lower(), model_name(m).lower(), stem(m["title"])}]
    if exact:
        return exact[0]
    partial = [m for m in models if w in _haystack(m)]
    if len(partial) == 1:
        return partial[0]
    if partial:
        names = ", ".join(sorted(model_name(m) for m in partial)[:6])
        raise CatalogProblem("checkpoint_not_found", f'the checkpoint "{wanted}" matches several in Forge: {names}')
    raise CatalogProblem("checkpoint_not_found", f'Forge has no checkpoint called "{wanted}"')


def family_of(settings: Settings, model: dict[str, Any]) -> Family | None:
    text = _haystack(model)
    return next((f for f in settings.families if any(p.lower() in text for p in f.match)), None)


def checkpoint_verdict(settings: Settings, model: dict[str, Any]) -> tuple[Family | None, str | None]:
    """The family of a checkpoint and, when it may not be used, why."""
    family = family_of(settings, model)
    if family is None:
        return None, "it matches no family in the settings, so no safe tags can be chosen for it"
    if family.arch not in settings.allowed_archs:
        return family, f'its family "{family.name}" is architecture {family.arch}, which is not allowed'
    if settings.allowed_checkpoints and not any(a.lower() in _haystack(model) for a in settings.allowed_checkpoints):
        return family, "it is not in allowed_checkpoints"
    return family, None


def _lora_names(lora: dict[str, Any]) -> set[str]:
    return {str(lora.get("name", "")).lower(), str(lora.get("alias") or "").lower()} - {""}


def lora_allowed(settings: Settings, name: str) -> bool:
    return name.strip().lower() in {a.lower() for a in settings.lora_allowlist}


def check_loras(settings: Settings, installed: list[dict[str, Any]], names: list[str]) -> None:
    """Every LoRA of a request must be on the allowlist and installed in Forge."""
    for name in names:
        if not lora_allowed(settings, name):
            raise CatalogProblem("lora_not_allowed", f'the LoRA "{name}" is not in lora_allowlist')
        if not any(name.strip().lower() in _lora_names(lora) for lora in installed):
            raise CatalogProblem("lora_not_found", f'Forge has no LoRA called "{name}"')


@dataclass(frozen=True)
class CatalogView:
    checkpoints: list[dict[str, Any]]
    loras: list[dict[str, Any]]


def describe(settings: Settings, models: list[dict[str, Any]], installed: list[dict[str, Any]]) -> CatalogView:
    checkpoints = []
    for m in models:
        family, why = checkpoint_verdict(settings, m)
        checkpoints.append(
            {
                "name": model_name(m),
                "title": m["title"],
                "family": family.name if family else None,
                "allowed": why is None,
                **({"why_not": why} if why else {}),
            }
        )
    loras = [
        {
            "name": str(lora["name"]),
            **({"alias": lora["alias"]} if lora.get("alias") else {}),
            "allowed": any(lora_allowed(settings, n) for n in _lora_names(lora)),
        }
        for lora in installed
    ]
    return CatalogView(checkpoints, loras)
