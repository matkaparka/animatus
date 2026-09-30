"""The errors the service raises, and what each one means for a song.

Three kinds matter to the queue:

  SongRejected       this song cannot be sung (no rights, too long, no vocals). Asking again will not help.
  SourceUnavailable  the song may be fine but the source (or a tool) failed right now: a network blip, the
                     circuit breaker, the download cap. Asking again later can work, and the song is never
                     marked as rejected because of it.
  Abandoned          somebody removed or cancelled the entry while it was being worked on: stop quietly.

`code` is stable and documented; the text a viewer (and the model) is told is made from it (messages.py) and can be
replaced by the operator. `reason` is the technical detail behind it, in English, for the log and the panel; `fields`
are the values the viewer text may mention (a title, a limit).
"""

from __future__ import annotations

from typing import Any


class SingingError(Exception):
    default_code = 'error'
    default_retryable = False

    def __init__(
        self,
        reason: str,
        code: str | None = None,
        retryable: bool | None = None,
        **fields: Any,
    ) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code or self.default_code
        self.retryable = self.default_retryable if retryable is None else retryable
        self.fields: dict[str, Any] = fields


class SongRejected(SingingError):
    """This song cannot be sung, whatever is tried."""

    default_code = 'rejected'


class SourceUnavailable(SingingError):
    """The source or a tool failed for now. `auto_retry` says the worker may try again by itself (a blip);
    without it (a tripped breaker, a spent download cap) only a person can make it work again."""

    default_code = 'source_unavailable'
    default_retryable = True

    def __init__(self, reason: str, code: str | None = None, auto_retry: bool = False, **fields: Any) -> None:
        super().__init__(reason, code, True, **fields)
        self.auto_retry = auto_retry


class StepFailed(SingingError):
    """A pipeline step exited with an error or left no output."""

    default_code = 'step_failed'

    def __init__(self, step: str, reason: str, detail: str = '') -> None:
        super().__init__(reason, 'step_failed', False)
        self.step = step
        #: The end of the tool's output.
        self.detail = detail


class StepTimeout(SingingError):
    """A subprocess ran past its limit and was killed."""

    default_code = 'step_timeout'
    default_retryable = True


class GpuBusy(SingingError):
    """The GPU lock stayed taken for the whole wait."""

    default_code = 'gpu_busy'
    default_retryable = True


class NotConfigured(SingingError):
    """The settings do not describe a working pipeline."""

    default_code = 'not_configured'


class Abandoned(Exception):
    """The entry being worked on was removed or cancelled."""
