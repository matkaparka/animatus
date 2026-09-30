"""Layer 2: what is added to and taken out of the prompts before Forge sees them.

The order matters. The caller's prompt is stripped of extra-network tags and of listed tags first; the forced safe
tags are put in afterwards, at the front (then the caller's own prefix, then the prompt), so nothing that cleans a
prompt up can delete them (a clean-up treats `rating_safe` and friends as quality words and removes them). The
finished prompt is scanned once more.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .blocklist import Blocklist
from .settings import Family, Settings

_ANGLE_TAG = re.compile(r"<[^<>]*>")


class EmptyPrompt(Exception):
    """Nothing is left of the prompt once the listed tags are taken out."""


class ForcedTagLost(Exception):
    """A forced safe tag was deleted by the blocklist (it changed after the settings were checked)."""


def strip_networks(text: str) -> str:
    """Remove `<lora:..>`, `<lyco:..>`, `<hypernet:..>` and any other `<..>` tag, and stray angle brackets.

    Only this service attaches LoRAs, from a checked list; a LoRA written into the text of a prompt must not get through.
    """
    text = _ANGLE_TAG.sub(" ", text).replace("<", " ").replace(">", " ")
    return ", ".join(" ".join(part.split()) for part in text.split(",") if part.strip())


def _tags(text: str) -> list[str]:
    return [part.strip() for part in text.split(",") if part.strip()]


@dataclass(frozen=True)
class Built:
    prompt: str
    negative: str
    #: tags of the caller's prompt that the blocklist deleted (never shown to viewers; for the operator's log)
    scrubbed: tuple[str, ...]


def forced_positive(settings: Settings, family: Family) -> list[str]:
    return [t for t in (family.rating_tag, *_tags(settings.extra_positive)) if t]


def build_prompts(
    settings: Settings,
    family: Family,
    blocklist: Blocklist,
    prompt: str,
    negative: str,
    loras: list[tuple[str, float]],
    prefix: str = "",
) -> Built:
    """`prompt` is what the model wrote and `prefix` what the caller's own configuration adds in front of it (quality
    words, a LoRA's trigger words). They are kept apart so that a model whose every tag is on the blocklist gets no
    picture: the prefix alone must not make a prompt out of nothing."""
    scrubbed: list[str] = []
    body, dropped = blocklist.scrub_prompt(strip_networks(prompt))
    scrubbed.extend(dropped)
    if not body:
        raise EmptyPrompt("nothing is left of the prompt after the blocklist")

    forced = forced_positive(settings, family)
    front = strip_networks(prefix)
    positive, dropped = blocklist.scrub_prompt(", ".join(t for t in [*forced, front, body] if t))
    scrubbed.extend(dropped)
    kept = {t.lower() for t in _tags(positive)}
    lost = [t for t in forced if t.lower() not in kept]
    if lost:
        raise ForcedTagLost(f"the blocklist deletes the forced tag(s) {', '.join(lost)}")

    negatives = [t for t in (settings.extra_negative, family.extra_negative, strip_networks(negative)) if t]
    if loras:
        positive += " " + " ".join(f"<lora:{name}:{weight:g}>" for name, weight in loras)
    return Built(positive, ", ".join(negatives), tuple(scrubbed))


def fit_size(width: int, height: int, max_long_side: int) -> tuple[int, int]:
    """Both sides multiples of 64 and at least 512, the long side at most `max_long_side` (a multiple of 64)."""

    def round64(x: int) -> int:
        return max(512, int(round(x / 64)) * 64)

    w, h = round64(width), round64(height)
    long = max(w, h)
    if long > max_long_side:
        k = max_long_side / long
        w = max(512, int(w * k) // 64 * 64)
        h = max(512, int(h * k) // 64 * 64)
    return w, h
