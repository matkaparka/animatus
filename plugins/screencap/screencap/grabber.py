"""The interface a platform implements, and the procedure that turns a `window=` query into a picture.

The procedure (window matching, method fallback, resizing, black detection, error mapping) lives here so that it can
be tested with a fake grabber on any machine; `win32.py` only knows how to list windows and copy pixels.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from PIL import Image

from . import frames
from .errors import CaptureError, capture_failed, window_minimized, window_too_large
from .windows import WindowInfo, find_window

# How a window's pixels are obtained. `auto` asks the window to paint itself first and copies the screen only when
# that gives a black picture.
METHODS = ("auto", "printwindow", "screen")

# Well beyond 8K (33 million pixels); a larger window is a mistake, and the picture would need hundreds of MB.
MAX_PIXELS = 64_000_000


class Grabber(Protocol):
    name: str

    def check(self) -> str | None:
        """None when captures can work here; otherwise a sentence saying why not (shown by /health)."""
        ...

    def list_windows(self) -> list[WindowInfo]:
        """The windows a person could pick: visible, not cloaked, not tool windows. Top of the z-order first."""
        ...

    def grab(self, window_id: str, method: str) -> Image.Image:
        """The drawing area of one window as an RGB image, by `printwindow` or `screen`. Raises `CaptureError`."""
        ...


@dataclass(frozen=True)
class Capture:
    window: WindowInfo
    frame: frames.Frame
    method: str


def capture(
    grabber: Grabber,
    query: str,
    *,
    max_width: int,
    quality: int,
    black_threshold: float,
    method: str = "auto",
) -> Capture:
    if method not in METHODS:
        raise CaptureError("bad_request", f"method must be one of {', '.join(METHODS)}", 400)
    window = find_window(grabber.list_windows(), query)
    if window.minimized:
        raise window_minimized()

    order = ["printwindow", "screen"] if method == "auto" else [method]
    best: Capture | None = None
    failed: list[tuple[str, CaptureError]] = []
    for how in order:
        try:
            image = grabber.grab(window.id, how)
            if image.width * image.height > MAX_PIXELS:
                raise window_too_large(image.width, image.height)
            frame = frames.prepare(image, max_width=max_width, quality=quality, black_threshold=black_threshold)
        except CaptureError as e:
            # Only a copy that failed outright moves on to the next way: "the window is gone" would fail again.
            if e.code != "capture_failed":
                raise
            failed.append((how, e))
            continue
        found = Capture(window, frame, how)
        if not frame.black:
            return found
        if best is None or frame.brightness > best.frame.brightness:
            best = found

    if best is not None:
        return best  # every way that worked gave a black picture: report the least dark one
    if len(failed) == 1:
        raise failed[0][1]
    raise capture_failed("; ".join(f"{how}: {e.message}" for how, e in failed))
