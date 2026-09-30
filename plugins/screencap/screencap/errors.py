"""The failures the service reports, each with the HTTP status and the machine-readable code it is answered with."""

from __future__ import annotations


class CaptureError(Exception):
    """A failure of real work. The server answers it with a non-2xx status and a `ServiceError` body, never a 200."""

    def __init__(self, code: str, message: str, status: int = 500, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable

    def body(self) -> dict:
        return {"error": {"code": self.code, "message": self.message, "retryable": self.retryable}}


def bad_request(message: str) -> CaptureError:
    return CaptureError("bad_request", message, 400)


def window_not_found(query: str) -> CaptureError:
    shown = query if len(query) <= 80 else query[:79] + "..."
    return CaptureError(
        "window_not_found",
        f'no visible window matches "{shown}" (it may be closed, minimised to a tray, or on another desktop)',
        404,
        retryable=True,
    )


def window_minimized() -> CaptureError:
    return CaptureError("window_minimized", "the window is minimised: restore it so it can be captured", 409, True)


def window_not_responding() -> CaptureError:
    return CaptureError("window_not_responding", "the window is not responding, so it cannot be captured", 409, True)


def window_too_small(width: int, height: int) -> CaptureError:
    return CaptureError(
        "window_too_small",
        f"the window's drawing area is only {width}x{height} pixels: there is nothing to capture",
        422,
        True,
    )


def window_too_large(width: int, height: int) -> CaptureError:
    return CaptureError("window_too_large", f"the window is {width}x{height} pixels, more than can be captured", 422)


def capture_failed(message: str) -> CaptureError:
    return CaptureError("capture_failed", message, 500, True)
