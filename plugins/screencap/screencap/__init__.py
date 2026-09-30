"""Window capture for the screen commentary mode.

The pieces, from the inside out:

    errors      the one exception the service turns into a JSON error answer
    windows     what a window looks like to the service, and how a query finds one
    frames      resizing, JPEG encoding and black-frame detection (Pillow only)
    grabber     the interface a platform implements, and the capture procedure that uses it
    win32       the Windows implementation (ctypes: user32, gdi32, dwmapi)
    server      the HTTP surface

Everything but `win32` is plain Python and is tested with a fake grabber.
"""

SERVICE_NAME = "screencap"
VERSION = "0.1.0"
