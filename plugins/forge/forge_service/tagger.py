"""Layer 3: a rating model looks at every picture before it leaves the service.

WD tagger v3 (an ONNX file, run by onnxruntime on the CPU) gives four ratings: general, sensitive, questionable,
explicit. A picture passes when `general` is the highest and questionable + explicit stays under a limit; a route
that is allowed to (a white breastplate reads as skin) may also pass when `sensitive` is the highest.

The model is fetched once and kept in a folder. Fetching and loading happen in `TaggerHolder`, in the background and
in a thread, never while a generation holds the lock: a 400 MB download must not stall the queue.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger("forge.tagger")

RATINGS = ("general", "sensitive", "questionable", "explicit")
MODEL_FILES = ("model.onnx", "selected_tags.csv")
#: the `category` column of selected_tags.csv that marks the four rating rows
RATING_CATEGORY = "9"


class TaggerError(Exception):
    """The rating model cannot be fetched or loaded."""


class Rates(Protocol):
    def rate(self, png: bytes) -> dict[str, float]: ...


def rating_ok(ratings: dict[str, float], *, allow_sensitive: bool, max_bad: float) -> bool:
    """`general` highest (or `sensitive` where allowed) and questionable + explicit under `max_bad`."""
    if not ratings:
        return False
    top = max(ratings, key=lambda k: ratings[k])
    if top != "general" and not (allow_sensitive and top == "sensitive"):
        return False
    return ratings.get("questionable", 0.0) + ratings.get("explicit", 0.0) < max_bad


class RatingTagger:
    """The WD tagger v3 ONNX model, read for its four rating outputs only."""

    def __init__(self, session: Any, rating_index: dict[str, int], size: int) -> None:
        self._session = session
        self._index = rating_index
        self._size = size

    @classmethod
    def from_files(cls, model: Path, tags: Path) -> RatingTagger:
        try:
            import onnxruntime as ort

            with tags.open(encoding="utf-8", newline="") as f:
                rows = list(csv.DictReader(f))
            index = {r["name"]: i for i, r in enumerate(rows) if r.get("category") == RATING_CATEGORY}
            missing = [n for n in RATINGS if n not in index]
            if missing:
                raise TaggerError(f"{tags.name} has no rating row for {', '.join(missing)}")
            session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
            shape = session.get_inputs()[0].shape
            size = shape[1] if isinstance(shape[1], int) else 448
        except TaggerError:
            raise
        except Exception as e:
            raise TaggerError(
                f"the rating model in {model.parent} cannot be loaded ({e}); delete model.onnx and "
                "selected_tags.csv there to fetch them again"
            ) from e
        return cls(session, index, size)

    def rate(self, png: bytes) -> dict[str, float]:
        import numpy as np
        from PIL import Image

        img = Image.open(io.BytesIO(png)).convert("RGBA")
        white = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(white, img).convert("RGB")
        w, h = img.size
        side = max(w, h)
        square = Image.new("RGB", (side, side), (255, 255, 255))
        square.paste(img, ((side - w) // 2, (side - h) // 2))
        square = square.resize((self._size, self._size), Image.Resampling.BICUBIC)
        # the model wants BGR, 0..255, NHWC
        x = np.ascontiguousarray(np.asarray(square, dtype=np.float32)[:, :, ::-1][None])
        probs = self._session.run(None, {self._session.get_inputs()[0].name: x})[0][0]
        return {name: float(probs[i]) for name, i in self._index.items() if name in RATINGS}


def _fetch_from_hub(repo: str, name: str, dest: Path) -> None:
    from huggingface_hub import hf_hub_download

    hf_hub_download(repo_id=repo, filename=name, local_dir=str(dest))


def ensure_files(
    folder: Path,
    repo: str,
    fetch: Callable[[str, str, Path], None] = _fetch_from_hub,
) -> tuple[Path, Path]:
    """The model file and the tag list in `folder`, fetched from `repo` for whichever is missing."""
    folder.mkdir(parents=True, exist_ok=True)
    for name in MODEL_FILES:
        target = folder / name
        if target.is_file() and target.stat().st_size > 0:
            continue
        log.info("fetching %s from %s (the model is about 400 MB, once)", name, repo)
        try:
            fetch(repo, name, folder)
        except Exception as e:
            raise TaggerError(
                f"could not fetch {name} from {repo} ({e}). Put model.onnx and selected_tags.csv from "
                f"https://huggingface.co/{repo} into {folder} by hand, or set a proxy (HTTPS_PROXY) for the orchestrator"
            ) from e
        if not target.is_file() or target.stat().st_size == 0:
            raise TaggerError(f"{name} is still missing in {folder} after the download")
    return folder / MODEL_FILES[0], folder / MODEL_FILES[1]


def load_tagger(folder: Path, repo: str) -> RatingTagger:
    model, tags = ensure_files(folder, repo)
    return RatingTagger.from_files(model, tags)


class TaggerHolder:
    """Loads the rating model in the background and says how far it is. Retries after a failure."""

    def __init__(self, loader: Callable[[], Rates], *, retry_sec: float = 60.0) -> None:
        self._loader = loader
        self._retry_sec = retry_sec
        self.state = "loading"
        self.error: str | None = None
        self.tagger: Rates | None = None

    async def run(self) -> None:
        while True:
            self.state = "loading"
            try:
                self.tagger = await asyncio.to_thread(self._loader)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.state = "failed"
                self.error = str(e)
                log.error("the rating model is not available: %s", e)
                await asyncio.sleep(self._retry_sec)
            else:
                self.state = "ready"
                self.error = None
                log.info("the rating model is loaded")
                return
