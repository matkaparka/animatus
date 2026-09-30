"""The screen capture service: a small loopback HTTP server that returns one window as a JPEG.

    python service.py --port N

Started and stopped by the orchestrator (see plugin.yaml); the contract is in docs/mode-commentary.md. Standard
library and Pillow only, no GPU.
"""

from __future__ import annotations

import argparse
import sys

from PIL import Image

from screencap import SERVICE_NAME
from screencap.errors import CaptureError
from screencap.server import make_server
from screencap.windows import WindowInfo


class UnavailableGrabber:
    """Stands in when capture cannot work (not Windows, no desktop): /health says why, everything else fails loudly."""

    name = "unavailable"

    def __init__(self, reason: str):
        self.reason = reason

    def check(self) -> str | None:
        return self.reason

    def _refuse(self) -> CaptureError:
        return CaptureError("unsupported_platform", self.reason, 503)

    def list_windows(self) -> list[WindowInfo]:
        raise self._refuse()

    def grab(self, window_id: str, method: str) -> Image.Image:
        raise self._refuse()


def create_grabber():
    if sys.platform != "win32":
        return UnavailableGrabber("window capture is only implemented for Windows")
    try:
        from screencap.win32 import Win32Grabber

        return Win32Grabber()
    except Exception as e:  # noqa: BLE001 - the process stays up so that /health can say what is wrong
        return UnavailableGrabber(f"the Windows capture could not be set up: {type(e).__name__}: {e}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Capture one window as a JPEG (loopback HTTP).")
    parser.add_argument("--port", type=int, required=True, help="port on 127.0.0.1")
    args = parser.parse_args(argv)
    grabber = create_grabber()
    server = make_server(grabber, args.port)
    print(f"{SERVICE_NAME} listening on 127.0.0.1:{server.port} (grabber: {grabber.name})", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
