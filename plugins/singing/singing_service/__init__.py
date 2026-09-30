"""The singing service: a queue of song requests and the pipeline that prepares each song.

A viewer asks for a song; the service finds it (a folder of audio files the operator keeps, or a NetEase API
server the operator runs), separates the vocals from the band, converts the voice with RVC, mixes the two tracks
and leaves them in the songs library, where the orchestrator serves them to the stage. The HTTP contract is in
docs/mode-sing.md; the code is stdlib-only apart from PyYAML (settings), so it starts in any Python 3.10+.
"""

__version__ = '0.1.0'
