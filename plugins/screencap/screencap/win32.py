"""The Windows grabber: user32, gdi32 and dwmapi through ctypes, no third-party package.

Why not Pillow's `ImageGrab` (or mss, or pywin32)?  `ImageGrab` copies a rectangle of the screen, so whatever lies
over the game (the console, a chat window) ends up in the picture, and it cannot look at a window that is partly off
screen. `PrintWindow` asks the window itself to paint into a bitmap, which works for a window hidden behind others.
The service therefore prints the window first (`PW_RENDERFULLCONTENT`, so windows drawn by the compositor, browsers
and most windowed games, come out right) and copies that window's rectangle from the screen only when the printed
picture is black. Neither can see an exclusive-fullscreen game: that is the operator's to change (borderless or
windowed), and the black-frame flag says so.

The picture is the window's drawing area (its client rectangle): no title bar, no borders.
"""

from __future__ import annotations

import ctypes
import os
import sys
from ctypes import wintypes

from PIL import Image

from .errors import (
    CaptureError,
    capture_failed,
    window_minimized,
    window_not_found,
    window_not_responding,
    window_too_large,
    window_too_small,
)
from .windows import WindowInfo

IS_WINDOWS = sys.platform == "win32"

GWL_EXSTYLE = -20
GW_OWNER = 4
WS_EX_TOPMOST = 0x00000008
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WS_EX_LAYERED = 0x00080000
WS_EX_NOACTIVATE = 0x08000000
DWMWA_CLOAKED = 14
PW_CLIENTONLY = 0x1
PW_RENDERFULLCONTENT = 0x2
SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000
SM_CXVIRTUALSCREEN = 78
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

MIN_SIDE = 8  # a drawing area smaller than this in either direction is not a picture
LIST_MIN_SIDE = 16  # ...and one this small is not worth offering
MAX_TITLE = 300
SHELL_CLASSES = {"Progman"}  # the desktop itself


class _BitmapInfoHeader(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class _BitmapInfo(ctypes.Structure):
    _fields_ = [("bmiHeader", _BitmapInfoHeader), ("bmiColors", wintypes.DWORD * 3)]


def _sig(function, restype, *argtypes):
    function.restype = restype
    function.argtypes = list(argtypes)
    return function


def _optional(library, name, restype, *argtypes):
    """A function that older Windows versions do not have: None there."""
    try:
        return _sig(getattr(library, name), restype, *argtypes)
    except AttributeError:
        return None


class _Api:
    """The Win32 functions this module calls, with their real signatures (handles are pointer-sized)."""

    def __init__(self) -> None:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
        self.user32 = user32

        self.enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        self.EnumWindows = _sig(user32.EnumWindows, wintypes.BOOL, self.enum_proc, wintypes.LPARAM)
        self.IsWindow = _sig(user32.IsWindow, wintypes.BOOL, wintypes.HWND)
        self.IsWindowVisible = _sig(user32.IsWindowVisible, wintypes.BOOL, wintypes.HWND)
        self.IsIconic = _sig(user32.IsIconic, wintypes.BOOL, wintypes.HWND)
        self.IsHungAppWindow = _sig(user32.IsHungAppWindow, wintypes.BOOL, wintypes.HWND)
        self.GetWindowTextLengthW = _sig(user32.GetWindowTextLengthW, ctypes.c_int, wintypes.HWND)
        self.GetWindowTextW = _sig(user32.GetWindowTextW, ctypes.c_int, wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
        self.GetClassNameW = _sig(user32.GetClassNameW, ctypes.c_int, wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
        self.GetWindowLongW = _sig(user32.GetWindowLongW, wintypes.LONG, wintypes.HWND, ctypes.c_int)
        self.GetWindow = _sig(user32.GetWindow, wintypes.HWND, wintypes.HWND, wintypes.UINT)
        self.GetClientRect = _sig(user32.GetClientRect, wintypes.BOOL, wintypes.HWND, ctypes.POINTER(wintypes.RECT))
        self.ClientToScreen = _sig(user32.ClientToScreen, wintypes.BOOL, wintypes.HWND, ctypes.POINTER(wintypes.POINT))
        self.GetWindowThreadProcessId = _sig(
            user32.GetWindowThreadProcessId, wintypes.DWORD, wintypes.HWND, ctypes.POINTER(wintypes.DWORD)
        )
        self.GetDC = _sig(user32.GetDC, wintypes.HDC, wintypes.HWND)
        self.ReleaseDC = _sig(user32.ReleaseDC, ctypes.c_int, wintypes.HWND, wintypes.HDC)
        self.PrintWindow = _sig(user32.PrintWindow, wintypes.BOOL, wintypes.HWND, wintypes.HDC, wintypes.UINT)
        self.GetSystemMetrics = _sig(user32.GetSystemMetrics, ctypes.c_int, ctypes.c_int)
        # Windows 10 1607 and later; without them a DPI-unaware window cannot be recognised
        self.GetWindowDpiAwarenessContext = _optional(
            user32, "GetWindowDpiAwarenessContext", ctypes.c_void_p, wintypes.HWND
        )
        self.GetAwarenessFromDpiAwarenessContext = _optional(
            user32, "GetAwarenessFromDpiAwarenessContext", ctypes.c_int, ctypes.c_void_p
        )
        self.GetDpiForSystem = _optional(user32, "GetDpiForSystem", wintypes.UINT)

        self.CreateCompatibleDC = _sig(gdi32.CreateCompatibleDC, wintypes.HDC, wintypes.HDC)
        self.CreateCompatibleBitmap = _sig(
            gdi32.CreateCompatibleBitmap, wintypes.HBITMAP, wintypes.HDC, ctypes.c_int, ctypes.c_int
        )
        self.SelectObject = _sig(gdi32.SelectObject, wintypes.HGDIOBJ, wintypes.HDC, wintypes.HGDIOBJ)
        self.DeleteObject = _sig(gdi32.DeleteObject, wintypes.BOOL, wintypes.HGDIOBJ)
        self.DeleteDC = _sig(gdi32.DeleteDC, wintypes.BOOL, wintypes.HDC)
        self.BitBlt = _sig(
            gdi32.BitBlt,
            wintypes.BOOL,
            wintypes.HDC,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HDC,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.DWORD,
        )
        self.GetDIBits = _sig(
            gdi32.GetDIBits,
            ctypes.c_int,
            wintypes.HDC,
            wintypes.HBITMAP,
            wintypes.UINT,
            wintypes.UINT,
            ctypes.c_void_p,
            ctypes.POINTER(_BitmapInfo),
            wintypes.UINT,
        )

        self.OpenProcess = _sig(kernel32.OpenProcess, wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        self.QueryFullProcessImageNameW = _sig(
            kernel32.QueryFullProcessImageNameW,
            wintypes.BOOL,
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        )
        self.CloseHandle = _sig(kernel32.CloseHandle, wintypes.BOOL, wintypes.HANDLE)
        self.DwmGetWindowAttribute = _sig(
            dwmapi.DwmGetWindowAttribute, ctypes.c_long, wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD
        )

    def make_dpi_aware(self) -> str:
        """Without this, a scaled display (125%, 150%) reports window sizes in scaled units and the capture is cropped."""
        try:
            if _sig(self.user32.SetProcessDpiAwarenessContext, wintypes.BOOL, ctypes.c_void_p)(ctypes.c_void_p(-4)):
                return "per-monitor-v2"
        except (AttributeError, OSError):
            pass
        try:
            shcore = ctypes.WinDLL("shcore")
            if _sig(shcore.SetProcessDpiAwareness, ctypes.c_long, ctypes.c_int)(2) == 0:
                return "per-monitor"
        except (AttributeError, OSError):
            pass
        try:
            if _sig(self.user32.SetProcessDPIAware, wintypes.BOOL)():
                return "system"
        except (AttributeError, OSError):
            pass
        return "unchanged"  # already set by the process, or not settable: sizes are whatever Windows reports


class Win32Grabber:
    name = "win32"

    def __init__(self) -> None:
        if not IS_WINDOWS:
            raise OSError("window capture is only implemented for Windows")
        self.api = _Api()
        self.dpi = self.api.make_dpi_aware()

    # ─────────────────────────────── the interface ───────────────────────────────

    def check(self) -> str | None:
        if self.api.GetSystemMetrics(SM_CXVIRTUALSCREEN) <= 0:
            return "there is no desktop to capture (the service runs outside an interactive session)"
        return None

    def list_windows(self) -> list[WindowInfo]:
        found: list[WindowInfo] = []

        def visit(hwnd, _lparam):
            try:
                info = self._describe(hwnd)
            except (OSError, CaptureError):
                # the window closed while it was being looked at; that must not end the enumeration
                info = None
            if info is not None:
                found.append(info)
            return True

        callback = self.api.enum_proc(visit)  # kept in a name so it is not collected during the call
        if not self.api.EnumWindows(callback, 0):
            raise capture_failed(f"the window list could not be read (Windows error {ctypes.get_last_error()})")
        return found

    def grab(self, window_id: str, method: str) -> Image.Image:
        api = self.api
        try:
            hwnd = int(window_id)
        except ValueError:
            raise window_not_found(window_id) from None
        if not 0 < hwnd < 1 << 63 or not api.IsWindow(hwnd):
            raise window_not_found(window_id)
        if api.IsIconic(hwnd):
            raise window_minimized()
        if api.IsHungAppWindow(hwnd):
            raise window_not_responding()
        width, height = self._client_size(hwnd)
        if width < MIN_SIDE or height < MIN_SIDE:
            raise window_too_small(width, height)
        if width * height > 64_000_000:
            raise window_too_large(width, height)

        if method == "printwindow":
            if self._scaled_by_windows(hwnd):
                raise capture_failed(
                    "PrintWindow cannot copy this window: it does not scale itself to the display (it is not "
                    "DPI-aware), so only its top-left part would come out. The screen copy handles it."
                )
            return self._bitmap(
                width, height, "PrintWindow", lambda dc, _screen: api.PrintWindow(hwnd, dc, PW_CLIENTONLY | PW_RENDERFULLCONTENT)
            )
        if method == "screen":
            origin = wintypes.POINT(0, 0)
            if not api.ClientToScreen(hwnd, ctypes.byref(origin)):
                raise window_not_found(window_id)
            return self._bitmap(
                width,
                height,
                "the screen copy",
                lambda dc, screen: api.BitBlt(dc, 0, 0, width, height, screen, origin.x, origin.y, SRCCOPY | CAPTUREBLT),
            )
        raise capture_failed(f'unknown capture method "{method}"')

    # ─────────────────────────────── windows ───────────────────────────────

    def _describe(self, hwnd) -> WindowInfo | None:
        api = self.api
        if not api.IsWindowVisible(hwnd):
            return None
        style = api.GetWindowLongW(hwnd, GWL_EXSTYLE) & 0xFFFFFFFF
        if style & WS_EX_TOOLWINDOW and not style & WS_EX_APPWINDOW:
            return None
        # what the taskbar shows: a window that has an owner (a dialog, a popup) belongs to its owner's entry
        if api.GetWindow(hwnd, GW_OWNER) and not style & WS_EX_APPWINDOW:
            return None
        if self._cloaked(hwnd):
            return None  # a window of another virtual desktop, or a suspended store app
        title = self._text(api.GetWindowTextLengthW, api.GetWindowTextW, hwnd, MAX_TITLE)
        if not title.strip() or self._text(None, api.GetClassNameW, hwnd, 256) in SHELL_CLASSES:
            return None
        minimized = bool(api.IsIconic(hwnd))
        width = height = 0
        if not minimized:
            width, height = self._client_size(hwnd)
            if width < LIST_MIN_SIDE or height < LIST_MIN_SIDE:
                return None
        overlay = bool(style & WS_EX_TRANSPARENT) or bool(
            style & WS_EX_LAYERED and style & WS_EX_TOPMOST and style & WS_EX_NOACTIVATE
        )
        return WindowInfo(
            id=str(int(hwnd)),
            title=title,
            process=self._process_name(hwnd),
            width=width,
            height=height,
            minimized=minimized,
            overlay=overlay,
        )

    def _scaled_by_windows(self, hwnd) -> bool:
        """True for a window of a DPI-unaware program on a scaled display: Windows stretches its picture on screen, but
        `PrintWindow` gets the unstretched one and it fills only the top-left part of a bitmap of the real size."""
        api = self.api
        if not (api.GetWindowDpiAwarenessContext and api.GetAwarenessFromDpiAwarenessContext and api.GetDpiForSystem):
            return False
        awareness = api.GetAwarenessFromDpiAwarenessContext(api.GetWindowDpiAwarenessContext(hwnd))
        return awareness == 0 and api.GetDpiForSystem() > 96  # DPI_AWARENESS_UNAWARE

    def _cloaked(self, hwnd) -> bool:
        value = wintypes.DWORD(0)
        result = self.api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(value), ctypes.sizeof(value))
        return result == 0 and value.value != 0

    @staticmethod
    def _text(length_fn, text_fn, hwnd, limit: int) -> str:
        size = min(length_fn(hwnd), limit) if length_fn else limit
        if size <= 0:
            return ""
        buffer = ctypes.create_unicode_buffer(size + 1)
        text_fn(hwnd, buffer, size + 1)
        return buffer.value

    def _client_size(self, hwnd) -> tuple[int, int]:
        rect = wintypes.RECT()
        if not self.api.GetClientRect(hwnd, ctypes.byref(rect)):
            raise window_not_found(str(int(hwnd)))
        return rect.right - rect.left, rect.bottom - rect.top

    def _process_name(self, hwnd) -> str:
        api = self.api
        pid = wintypes.DWORD(0)
        api.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return ""
        handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not handle:
            return ""  # a process of higher integrity (an elevated game) does not let itself be asked
        try:
            size = wintypes.DWORD(1024)
            buffer = ctypes.create_unicode_buffer(size.value)
            if not api.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                return ""
            return os.path.basename(buffer.value)
        finally:
            api.CloseHandle(handle)

    # ─────────────────────────────── pixels ───────────────────────────────

    def _bitmap(self, width: int, height: int, what: str, paint) -> Image.Image:
        """Runs `paint(memory_dc, screen_dc)` into a fresh bitmap and returns it as an image."""
        api = self.api
        screen = api.GetDC(None)
        if not screen:
            raise capture_failed(f"{what} failed: there is no screen device context")
        memory = bitmap = previous = None
        try:
            memory = api.CreateCompatibleDC(screen)
            bitmap = api.CreateCompatibleBitmap(screen, width, height)
            if not memory or not bitmap:
                raise capture_failed(f"{what} failed: a {width}x{height} bitmap could not be made")
            previous = api.SelectObject(memory, bitmap)
            if not previous:
                raise capture_failed(f"{what} failed: the bitmap could not be selected")
            if not paint(memory, screen):
                raise capture_failed(f"{what} failed (Windows error {ctypes.get_last_error()})")
            api.SelectObject(memory, previous)  # GetDIBits wants the bitmap out of every device context
            previous = None
            return self._read(memory, bitmap, width, height, what)
        finally:
            if previous:
                api.SelectObject(memory, previous)
            if bitmap:
                api.DeleteObject(bitmap)
            if memory:
                api.DeleteDC(memory)
            api.ReleaseDC(None, screen)

    def _read(self, dc, bitmap, width: int, height: int, what: str) -> Image.Image:
        info = _BitmapInfo()
        header = info.bmiHeader
        header.biSize = ctypes.sizeof(_BitmapInfoHeader)
        header.biWidth = width
        header.biHeight = -height  # negative: rows from the top
        header.biPlanes = 1
        header.biBitCount = 32
        header.biCompression = 0  # BI_RGB
        buffer = ctypes.create_string_buffer(width * height * 4)
        lines = self.api.GetDIBits(dc, bitmap, 0, height, buffer, ctypes.byref(info), 0)
        if lines != height:
            raise capture_failed(f"{what} failed: only {lines} of {height} rows could be read")
        return Image.frombuffer("RGB", (width, height), buffer.raw, "raw", "BGRX", 0, 1)
