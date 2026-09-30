"""The pipeline's tools, each a script started as a subprocess (see runner.py). They are files of their own, with no
imports from the service, because they may run in another interpreter (Applio's, the audio environment's)."""
