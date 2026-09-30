"""The service's own entry point, with a fake rating model, for the process test (no model file, no download)."""

import sys

from fakes import FakeTagger
from forge_service.app import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], tagger_loader=lambda: FakeTagger()))
