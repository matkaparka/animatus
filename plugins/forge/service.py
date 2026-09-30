"""Entry point of the Forge executor service: `python service.py --port N --data-dir D --settings S --max-long-side M`."""

import sys

from forge_service.app import main

if __name__ == "__main__":
    sys.exit(main())
