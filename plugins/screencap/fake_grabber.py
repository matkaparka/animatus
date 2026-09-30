"""A grabber made of dictionaries, for testing everything above the Win32 calls on any machine."""

from __future__ import annotations

from PIL import Image

from screencap.windows import WindowInfo


def solid(color, size=(320, 180)) -> Image.Image:
    return Image.new("RGB", size, color)


def window(id: str, title: str, *, process: str = "game.exe", size=(1280, 720), **flags) -> WindowInfo:  # noqa: A002
    return WindowInfo(id=id, title=title, process=process, width=size[0], height=size[1], **flags)


class FakeGrabber:
    """`images` maps (window id, method) to an Image, or to an exception to raise; (window id, None) covers any method."""

    name = "fake"

    def __init__(self, windows=None, images=None, problem: str | None = None):
        self.windows = list(windows or [])
        self.images = dict(images or {})
        self.problem = problem
        self.grabs: list[tuple[str, str]] = []
        self.listed = 0

    def check(self) -> str | None:
        return self.problem

    def list_windows(self) -> list[WindowInfo]:
        self.listed += 1
        return list(self.windows)

    def grab(self, window_id: str, method: str) -> Image.Image:
        self.grabs.append((window_id, method))
        item = self.images.get((window_id, method), self.images.get((window_id, None)))
        if item is None:
            raise AssertionError(f"the test gave no image for {(window_id, method)}")
        if isinstance(item, BaseException):
            raise item
        return item.copy()
