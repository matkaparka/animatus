"""Putting the parts together for a configuration: what the service and the prefetch command both start from."""

from __future__ import annotations

import os

from .locks import FileLock
from .pipeline import Pipeline
from .runner import ProcessRunner
from .settings import Config
from .sources import make_source
from .sources.base import SongSource


def build(config: Config, cookie: str = '') -> tuple[SongSource, Pipeline]:
    """The song source the settings ask for and a pipeline that runs the real tools. The GPU lock lives in the state
    folder, so a prefetch run and the service, two processes, take turns on the GPU."""
    source = make_source(config, cookie)
    pipeline = Pipeline(config, source, ProcessRunner(), FileLock(os.path.join(config.state_dir, 'locks', 'gpu.lock')))
    return source, pipeline
