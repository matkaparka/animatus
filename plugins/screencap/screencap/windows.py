"""What the service knows about a window, and how a `window=` query picks one.

A query is one of

    197432          the window id (a decimal window handle), when some window has it; otherwise it is read as a title
    exe:javaw       every window of a program (the ".exe" is optional, case does not matter)
    Some title      the window called exactly that (case and spacing ignored), else any window whose title contains it

Several windows can match (a program with a main window and a splash screen, two browser windows). The best one wins:
not minimised, not an overlay, the biggest drawing area, then the one nearest the top of the z-order (the order the
grabber lists them in).
"""

from __future__ import annotations

from dataclasses import dataclass

from .errors import bad_request, window_not_found

MAX_QUERY = 300


@dataclass(frozen=True)
class WindowInfo:
    id: str
    title: str
    process: str
    # the size of the drawing area (the part a capture returns), in pixels
    width: int
    height: int
    minimized: bool = False
    # click-through or topmost layered windows (game overlays, streaming widgets): almost never what to capture
    overlay: bool = False

    def public(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "process": self.process,
            "width": self.width,
            "height": self.height,
            "minimized": self.minimized,
            "overlay": self.overlay,
        }


def _fold(text: str) -> str:
    return " ".join(text.split()).casefold()


def _ranked(windows: list[WindowInfo]) -> list[WindowInfo]:
    # sorted() is stable, so windows that tie on everything keep the grabber's z-order
    return sorted(windows, key=lambda w: (w.minimized, w.overlay, -(w.width * w.height)))


def match_windows(windows: list[WindowInfo], query: str) -> list[WindowInfo]:
    """Every window the query names, best first. Empty when none does; a malformed query is a `bad_request`."""
    q = query.strip()
    if not q:
        raise bad_request("window is empty: give a window id, part of its title, or exe:<program>")
    if len(q) > MAX_QUERY:
        raise bad_request(f"window is too long ({len(q)} characters, at most {MAX_QUERY})")

    if q.isascii() and q.isdigit():
        by_id = [w for w in windows if w.id == str(int(q))]
        if by_id:
            return by_id

    if q[:4].casefold() == "exe:":
        name = q[4:].strip().casefold()
        if not name:
            raise bad_request("exe: needs a program name, for example exe:javaw.exe")
        wanted = {name} if name.endswith(".exe") else {name, name + ".exe"}
        return _ranked([w for w in windows if w.process.casefold() in wanted])

    needle = _fold(q)
    exact = _ranked([w for w in windows if _fold(w.title) == needle])
    partial = _ranked([w for w in windows if needle in _fold(w.title) and _fold(w.title) != needle])
    return exact + partial


def find_window(windows: list[WindowInfo], query: str) -> WindowInfo:
    found = match_windows(windows, query)
    if not found:
        raise window_not_found(query.strip())
    return found[0]
