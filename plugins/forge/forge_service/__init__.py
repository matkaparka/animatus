"""The Forge executor service: runs one picture at a time on a Forge server and guards what comes out.

The draw mode (in the orchestrator) plans; this service executes and is the last line of defence, so it enforces the
safety layers itself even though the mode does too. See docs/mode-draw.md for the HTTP contract.
"""

__version__ = "0.1.0"
