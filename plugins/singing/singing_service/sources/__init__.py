"""Song sources and how the settings choose one."""

from __future__ import annotations

import os

from ..settings import Config
from .base import SongSource
from .local import LocalSource


def make_source(config: Config, cookie: str = '') -> SongSource:
    """The adapter the settings ask for. NetEase is imported only when it is used, so a build without that module
    still runs the local source."""
    s = config.settings
    if config.source_kind == 'local':
        return LocalSource(s.paths.local_music, search_limit=s.ncm.search_limit)
    from .netease import NetEaseSource

    return NetEaseSource(
        s.ncm.base_url,
        cookie,
        config.state_dir,
        min_interval=s.ncm.min_interval_sec,
        timeout=s.ncm.timeout_sec,
        level=s.ncm.level,
        search_limit=s.ncm.search_limit,
        max_new_downloads=s.ncm.max_new_downloads_per_session,
    )


def cookie_from_environment() -> str:
    """The optional NetEase membership cookie. The orchestrator's secret store puts it in the environment of this
    process (the plugin manifest asks for it); nothing else ever supplies it."""
    return os.environ.get('NCM_COOKIE', '')


__all__ = ['SongSource', 'LocalSource', 'make_source', 'cookie_from_environment']
