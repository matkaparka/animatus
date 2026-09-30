"""What the service keeps between runs: the maximum long side the console last set.

The plugin config gives the value the operator wrote in the configuration file; the console can change it while the
program runs (`POST /config`) and it must survive a restart. The saved value only counts while the configuration still
holds the number it was saved against: an operator who edits the configuration file later means the new number.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .settings import validate_max_long_side


class StateFile:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> dict[str, Any]:
        """The saved state, or an empty one when the file is missing, torn or not what was written."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def save(self, data: dict[str, Any]) -> None:
        """Write atomically. Raises OSError when the folder cannot be written: the caller must say so."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)


def effective_max_long_side(config_value: int, saved: dict[str, Any]) -> int:
    value = saved.get("max_long_side")
    if saved.get("config_value") != config_value:
        return config_value
    try:
        return validate_max_long_side(value)
    except ValueError:
        return config_value
