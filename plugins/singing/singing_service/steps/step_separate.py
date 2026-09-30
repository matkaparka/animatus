"""Vocal separation. Runs as a subprocess of the service (its models live and die with the process, so the GPU
memory is free again afterwards) in the interpreter that has `audio-separator`.

    python step_separate.py <song dir> --models-dir DIR --ffmpeg PATH --vocal-model M
                            [--karaoke-model M] --dereverb-model M [--no-split-backing]

Reads `<song dir>/orig.*` and, in order:
  1. vocals / band                       -> the full vocal, the instrumental
  2. lead / backing (optional)           -> the lead, the backing
  3. dereverb of the lead                -> vocals.wav, the dry lead that goes to the voice conversion
  4. inst.wav = the band plus the backing vocals
Intermediate files stay in `<song dir>/sep/`. The last line printed is JSON:
  {"vocal_ratio": vocal energy / original energy, "lead_ratio": ..., "duration": seconds, "models": [...]}

Standalone on purpose (no imports from the service): it is started by file path, possibly by another interpreter.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


def stem_of(path: str) -> str:
    """The stem name audio-separator puts in an output's file name: `song_(Vocals)_model.wav` gives `vocals`."""
    found = re.findall(r'_\(([^)]+)\)', os.path.basename(path))
    return found[-1].lower() if found else ''


def classify(stem: str) -> str:
    """`keep` for the stem that is wanted, `drop` for the other one, `?` when the name is not recognised."""
    s = stem.lower()
    # negations first: "No Reverb" is the dry vocal (keep), "No Vocals" is the band (drop)
    for word in ('no reverb', 'noreverb', 'no echo', 'noecho', 'dry'):
        if word in s:
            return 'keep'
    for word in ('no vocals', 'novocals', 'instrumental', 'other', 'backing', 'inst'):
        if word in s:
            return 'drop'
    for word in ('reverb', 'echo'):
        if word in s:
            return 'drop'
    for word in ('vocals', 'vocal', 'lead'):
        if word in s:
            return 'keep'
    return '?'


def run_model(sep: Any, model: str, src: str, workdir: str) -> tuple[str, str]:
    """Runs one model and returns (the wanted stem's file, the other one's)."""
    out = os.path.join(workdir, os.path.splitext(model)[0])
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(out):
        os.remove(os.path.join(out, name))
    sep.output_dir = out
    if getattr(sep, 'model_instance', None) is not None:
        sep.model_instance.output_dir = out
    sep.load_model(model_filename=model)
    sep.separate(src)
    files = sorted(os.path.join(out, n) for n in os.listdir(out) if n.lower().endswith('.wav'))
    keep = [f for f in files if classify(stem_of(f)) == 'keep']
    drop = [f for f in files if classify(stem_of(f)) == 'drop']
    if len(keep) != 1 or len(drop) != 1:
        raise RuntimeError(f'the output of {model} is not recognised: {[os.path.basename(f) for f in files]}')
    return keep[0], drop[0]


@dataclass
class Options:
    vocal_model: str
    dereverb_model: str
    karaoke_model: str = ''
    split_backing: bool = True


def _power(a: Any) -> float:
    import numpy as np

    return float(np.mean(np.square(a, dtype=np.float64)))


def separate_song(
    song_dir: str,
    options: Options,
    separator: Any,
    to_wav: Callable[[str, str], None],
) -> dict[str, Any]:
    """The whole step, with the separator and the converter passed in (the tests give it fakes)."""
    import soundfile as sf

    origs = sorted(
        os.path.join(song_dir, n) for n in os.listdir(song_dir) if n.startswith('orig.') and not n.endswith('.part')
    )
    if not origs:
        raise SystemExit(f'there is no orig.* in {song_dir}')
    work = os.path.join(song_dir, 'sep')
    os.makedirs(work, exist_ok=True)

    # everything after this is measured and added at one sample rate
    orig_wav = os.path.join(work, 'orig.wav')
    if not os.path.isfile(orig_wav):
        to_wav(origs[0], orig_wav)

    vocals_all, inst_raw = run_model(separator, options.vocal_model, orig_wav, work)
    lead, backing = vocals_all, None
    if options.split_backing:
        lead, backing = run_model(separator, options.karaoke_model, vocals_all, work)
    dry, _wet = run_model(separator, options.dereverb_model, lead, work)

    orig, rate = sf.read(orig_wav, always_2d=True, dtype='float32')
    inst, _ = sf.read(inst_raw, always_2d=True, dtype='float32')
    if backing:
        extra, _ = sf.read(backing, always_2d=True, dtype='float32')
        n = min(len(inst), len(extra))
        inst = inst[:n] + extra[:n]
    sf.write(os.path.join(song_dir, 'inst.wav'), inst, rate, subtype='FLOAT')
    shutil.copyfile(dry, os.path.join(song_dir, 'vocals.wav'))

    total = max(_power(orig), 1e-12)
    all_vocals, _ = sf.read(vocals_all, always_2d=True, dtype='float32')
    lead_audio, _ = sf.read(lead, always_2d=True, dtype='float32')
    models = [options.vocal_model] + ([options.karaoke_model] if backing else []) + [options.dereverb_model]
    return {
        'vocal_ratio': round(_power(all_vocals) / total, 4),
        'lead_ratio': round(_power(lead_audio) / total, 4),
        'duration': round(len(orig) / float(rate), 2),
        'models': models,
    }


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('song_dir')
    ap.add_argument('--models-dir', required=True)
    ap.add_argument('--ffmpeg', default='ffmpeg')
    ap.add_argument('--vocal-model', required=True)
    ap.add_argument('--karaoke-model', default='')
    ap.add_argument('--dereverb-model', required=True)
    ap.add_argument('--no-split-backing', action='store_true')
    args = ap.parse_args(argv)
    if not args.no_split_backing and not args.karaoke_model:
        ap.error('--karaoke-model is needed unless --no-split-backing is given')

    from audio_separator.separator import Separator  # only the audio environment has it

    song_dir = os.path.abspath(args.song_dir)
    separator = Separator(
        log_level=logging.WARNING,
        model_file_dir=args.models_dir,
        output_dir=os.path.join(song_dir, 'sep'),
        output_format='WAV',
        sample_rate=44100,
        normalization_threshold=1.0,  # no per-stem normalisation: keep the stems' levels relative to each other
        use_autocast=True,
    )

    def to_wav(src: str, dst: str) -> None:
        subprocess.run(
            [args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-ar', '44100', '-ac', '2', dst],
            check=True,
        )

    result = separate_song(
        song_dir,
        Options(args.vocal_model, args.dereverb_model, args.karaoke_model, not args.no_split_backing),
        separator,
        to_wav,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
