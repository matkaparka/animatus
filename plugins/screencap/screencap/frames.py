"""From a captured image to the JPEG the model is shown: resize, encode, and say whether the picture is black."""

from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image

# The brightness check looks at a 32x18 thumbnail (each cell is the average of a block of the picture), so a few
# bright pixels in a black window (a mouse cursor, a clock) do not make it "not black".
THUMBNAIL = (32, 18)


@dataclass(frozen=True)
class Brightness:
    mean: float  # 0 (black) to 255 (white), of the whole thumbnail
    peak: int  # the brightest cell of the thumbnail


def brightness(image: Image.Image) -> Brightness:
    data = image.convert("L").resize(THUMBNAIL, Image.Resampling.BOX).tobytes()
    return Brightness(sum(data) / len(data), max(data))


def is_black(measured: Brightness, threshold: float) -> bool:
    """Black means dark on average and dark everywhere: exclusive-fullscreen games and some overlay windows give this.

    With the default threshold of 10 this is "the mean is under 10 and no cell is over 40". Raising the threshold
    also skips very dark scenes; 0 turns the check off.
    """
    return measured.mean < threshold and measured.peak < threshold * 4


def fit_width(image: Image.Image, max_width: int) -> Image.Image:
    """Shrink to `max_width` pixels wide, keeping the shape. Never enlarges; 0 keeps the size."""
    if max_width <= 0 or image.width <= max_width:
        return image
    height = max(1, round(image.height * max_width / image.width))
    return image.resize((max_width, height), Image.Resampling.LANCZOS)


def encode_jpeg(image: Image.Image, quality: int) -> bytes:
    out = io.BytesIO()
    image.convert("RGB").save(out, "JPEG", quality=quality)
    return out.getvalue()


@dataclass(frozen=True)
class Frame:
    jpeg: bytes
    width: int  # of the JPEG
    height: int
    source_width: int  # of the capture, before it was shrunk
    source_height: int
    brightness: float
    peak: int
    black: bool


def prepare(image: Image.Image, *, max_width: int, quality: int, black_threshold: float) -> Frame:
    source_width, source_height = image.size
    small = fit_width(image, max_width)
    measured = brightness(small)
    return Frame(
        jpeg=encode_jpeg(small, quality),
        width=small.width,
        height=small.height,
        source_width=source_width,
        source_height=source_height,
        brightness=round(measured.mean, 2),
        peak=measured.peak,
        black=is_black(measured, black_threshold),
    )
