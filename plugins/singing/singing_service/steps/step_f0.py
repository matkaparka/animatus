"""Pitch statistics of a vocal, with Applio's RMVPE. Runs as a subprocess in Applio's own interpreter (it has torch
and the model); the process ends when it is done, so its GPU memory does too.

    <applio python> step_f0.py --applio DIR --out stats.json <audio file or folder> ...

Writes (and prints as the last line) JSON:
  {"files", "frames", "voiced", "median_hz", "p2_hz", "p5_hz", "p95_hz", "p98_hz", "quantiles_hz": [101 values]}
`quantiles_hz` is the 0th to 100th percentile of the voiced frames' f0 (10 ms frames): from it the service works
out how much of a song would land outside the voice's range after a transposition, without needing numpy itself.
With several inputs all voiced frames are pooled.

Standalone on purpose (no imports from the service).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from typing import Any


def summarize(voiced: Any, files: int, frames: int) -> dict[str, Any]:
    """Statistics of the voiced f0 values (a numpy array, Hz)."""
    import numpy as np

    stats: dict[str, Any] = {'files': files, 'frames': int(frames), 'voiced': int(len(voiced))}
    if len(voiced):
        for name, q in (('p2_hz', 2), ('p5_hz', 5), ('median_hz', 50), ('p95_hz', 95), ('p98_hz', 98)):
            stats[name] = round(float(np.percentile(voiced, q)), 2)
        stats['quantiles_hz'] = [round(float(v), 2) for v in np.percentile(voiced, list(range(101)))]
    return stats


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--applio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('inputs', nargs='+')
    args = ap.parse_args(argv)

    files: list[str] = []
    for path in map(os.path.abspath, args.inputs):  # made absolute before the chdir below
        if os.path.isdir(path):
            files += sorted(glob.glob(os.path.join(glob.escape(path), '**', '*.wav'), recursive=True))
        else:
            files.append(path)
    out_path = os.path.abspath(args.out)

    applio = os.path.abspath(args.applio)
    os.chdir(applio)  # Applio finds its models by relative paths
    sys.path.insert(0, applio)
    import librosa
    import numpy as np
    import torch
    from rvc.lib.predictors.f0 import RMVPE

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = RMVPE(device=device, sample_rate=16000, hop_size=160, high_register={'enabled': False})

    voiced_all = []
    frames = 0
    for path in files:
        audio, _ = librosa.load(path, sr=16000, mono=True)
        f0 = model.get_f0(audio, filter_radius=0.03)
        frames += len(f0)
        voiced_all.append(f0[f0 > 0])

    voiced = np.concatenate(voiced_all) if voiced_all else np.zeros(0)
    stats = summarize(voiced, len(files), frames)
    with open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(stats, handle, ensure_ascii=False, indent=1)
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
