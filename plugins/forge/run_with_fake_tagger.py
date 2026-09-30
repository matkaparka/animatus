"""The service's own entry point, with a fake rating model, for the process tests (no model file, no download).

FORGE_TEST_RATING=questionable makes the fake model refuse every picture; the default passes every picture.
"""

import os
import sys

from fakes import GOOD, QUESTIONABLE, FakeTagger
from forge_service.app import main

if __name__ == "__main__":
    ratings = {"good": GOOD, "questionable": QUESTIONABLE}[os.environ.get("FORGE_TEST_RATING", "good")]
    sys.exit(main(sys.argv[1:], tagger_loader=lambda: FakeTagger(ratings)))
