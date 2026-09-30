"""Mixing: the converted voice and the band each brought to a level, then together to the target loudness.

    python step_mix.py <song dir> [--shift N] [--target-lufs X] [--vocal-offset-db X] [--inst-offset-db X]
                       [--peak-limit-dbfs X] [--reverb ROOM WET DRY] [--ffmpeg PATH] [--mp3-bitrate 192k]
                       [--no-preview]

Reads `vocals_rvc.wav` and `inst.wav` from the song folder and writes, next to them,
  vocals_final.wav   mono, 44.1 kHz. The stage plays it and the mouth follows it, so it stays apart from the band
  inst_final.wav     stereo, 44.1 kHz (transposed by --shift semitones when the voice was moved off a whole octave)
  mix.mp3            both added, for listening by hand (skipped with --no-preview; a failure of it never fails the step)
Played from second 0 together, the two WAVs sound like mix.mp3. The last line printed is JSON with the levels.

Loudness is measured the way ITU-R BS.1770 defines it (K-weighting, 400 ms blocks, absolute and relative gates), with
numpy and scipy, so this needs no loudness package. Only a transposed instrumental or a reverb needs `pedalboard`.
Standalone on purpose (no imports from the service).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from typing import Any

SR = 44100
_BLOCK_SEC = 0.4
_STEP_SEC = 0.1
_ABS_GATE_LUFS = -70.0


def _k_weighting(rate: float) -> tuple[tuple[list[float], list[float]], tuple[list[float], list[float]]]:
    """The two filters of BS.1770's K-weighting (a high shelf, then a high pass) for any sample rate, from the
    analog prototypes' parameters through the bilinear transform; at 48 kHz they are the standard's coefficients."""
    f0, gain_db, q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = math.tan(math.pi * f0 / rate)
    vh = 10 ** (gain_db / 20)
    vb = vh**0.4996667741545416
    a0 = 1 + k / q + k * k
    shelf = (
        [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
        [1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0],
    )
    f0, q = 38.13547087602444, 0.5003270373238773
    k = math.tan(math.pi * f0 / rate)
    den = 1 + k / q + k * k
    high_pass = ([1.0, -2.0, 1.0], [1.0, 2 * (k * k - 1) / den, (1 - k / q + k * k) / den])
    return shelf, high_pass


def integrated_lufs(x: Any, rate: int) -> float:
    """Integrated loudness in LUFS of audio shaped (samples,) or (samples, channels) with one or two channels."""
    import numpy as np
    from scipy.signal import lfilter

    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    shelf, high_pass = _k_weighting(rate)
    y = lfilter(*high_pass, lfilter(*shelf, x, axis=0), axis=0)

    block, step = int(round(_BLOCK_SEC * rate)), int(round(_STEP_SEC * rate))
    if len(y) < block:  # shorter than one block: it is one block
        z = np.mean(y**2, axis=0)[None, :]
    else:
        squares = np.vstack([np.zeros((1, y.shape[1])), np.cumsum(y**2, axis=0)])
        starts = np.arange((len(y) - block) // step + 1) * step
        z = (squares[starts + block] - squares[starts]) / block  # mean square per block and channel
    power = np.sum(z, axis=1)
    loudness = -0.691 + 10 * np.log10(np.maximum(power, 1e-20))
    above = z[loudness > _ABS_GATE_LUFS]
    if len(above) == 0:
        return _ABS_GATE_LUFS
    relative_gate = -0.691 + 10 * np.log10(np.mean(np.sum(above, axis=1))) - 10
    gated = z[loudness > max(_ABS_GATE_LUFS, relative_gate)]
    if len(gated) == 0:
        return _ABS_GATE_LUFS
    return float(-0.691 + 10 * np.log10(np.mean(np.sum(gated, axis=1))))


def _lufs(x: Any, rate: int) -> float:
    value = integrated_lufs(x, rate)
    return value if math.isfinite(value) else _ABS_GATE_LUFS


def _db(x: float) -> float:
    return 10 ** (x / 20)


def _load(path: str) -> Any:
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    audio, rate = sf.read(path, always_2d=True, dtype='float32')
    if rate != SR:
        g = math.gcd(rate, SR)
        audio = resample_poly(audio, SR // g, rate // g, axis=0).astype(np.float32)
    return audio


def _pitch_shift(audio: Any, semitones: float) -> Any:
    try:
        from pedalboard import PitchShift
    except ImportError:
        raise SystemExit('pedalboard is not installed in this environment, and this song needs its instrumental transposed') from None
    return PitchShift(semitones=semitones)(audio.T, SR).T.astype('float32')


def _reverb(audio: Any, room: float, wet: float, dry: float) -> Any:
    try:
        from pedalboard import Reverb
    except ImportError:
        raise SystemExit('pedalboard is not installed in this environment, and the reverb is switched on') from None
    return Reverb(room_size=room, wet_level=wet, dry_level=dry, width=0.0)(audio.T, SR).T.astype('float32')


def mix_song(
    song_dir: str,
    *,
    shift: int = 0,
    target_lufs: float = -18.5,
    vocal_offset_db: float = 0.0,
    inst_offset_db: float = -2.0,
    peak_limit_dbfs: float = -1.0,
    reverb: tuple[float, float, float] | None = None,
    ffmpeg: str = 'ffmpeg',
    mp3_bitrate: str = '192k',
    preview: bool = True,
) -> dict[str, Any]:
    import numpy as np
    import soundfile as sf

    vocals = _load(os.path.join(song_dir, 'vocals_rvc.wav')).mean(axis=1, keepdims=True)
    inst = _load(os.path.join(song_dir, 'inst.wav'))
    if inst.shape[1] == 1:
        inst = np.repeat(inst, 2, axis=1)
    if shift:
        inst = _pitch_shift(inst, shift)
    if reverb is not None:
        vocals = _reverb(vocals, *reverb)

    n = max(len(vocals), len(inst))
    vocals = np.pad(vocals, ((0, n - len(vocals)), (0, 0)))
    inst = np.pad(inst, ((0, n - len(inst)), (0, 0)))

    # A mono voice reaches both ears of the listener: measure it as two channels, as it will be heard.
    v_level = _lufs(np.repeat(vocals, 2, axis=1), SR)
    i_level = _lufs(inst, SR)
    vocals = vocals * _db(target_lufs + vocal_offset_db - v_level)
    inst = inst * _db(target_lufs + inst_offset_db - i_level)

    # Then both together to the target, without the sum passing the ceiling (the two tracks are added on playback).
    mix = inst + vocals
    gain = _db(target_lufs - _lufs(mix, SR))
    peak = float(np.abs(mix).max()) * gain
    ceiling = _db(peak_limit_dbfs)
    if peak > ceiling:
        gain *= ceiling / peak
    vocals, inst = vocals * gain, inst * gain
    mix = inst + vocals

    sf.write(os.path.join(song_dir, 'vocals_final.wav'), vocals[:, 0], SR, subtype='PCM_16')
    sf.write(os.path.join(song_dir, 'inst_final.wav'), inst, SR, subtype='PCM_16')
    preview_state = 'skipped'
    if preview:
        tmp = os.path.join(song_dir, 'mix_tmp.wav')
        sf.write(tmp, mix, SR, subtype='PCM_16')
        try:
            subprocess.run(
                [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-b:a', mp3_bitrate, os.path.join(song_dir, 'mix.mp3')],
                check=True,
                timeout=120,
            )
            preview_state = 'written'
        except (OSError, subprocess.SubprocessError) as error:
            preview_state = f'failed: {type(error).__name__}'
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    return {
        'vocals_lufs_in': round(v_level, 1),
        'inst_lufs_in': round(i_level, 1),
        'mix_lufs': round(_lufs(mix, SR), 1),
        'mix_peak_dbfs': round(20 * math.log10(max(float(np.abs(mix).max()), 1e-9)), 1),
        'inst_shift': shift,
        'duration': round(n / SR, 2),
        'preview': preview_state,
    }


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('song_dir')
    ap.add_argument('--shift', type=int, default=0)
    ap.add_argument('--target-lufs', type=float, default=-18.5)
    ap.add_argument('--vocal-offset-db', type=float, default=0.0)
    ap.add_argument('--inst-offset-db', type=float, default=-2.0)
    ap.add_argument('--peak-limit-dbfs', type=float, default=-1.0)
    ap.add_argument('--reverb', type=float, nargs=3, metavar=('ROOM', 'WET', 'DRY'))
    ap.add_argument('--ffmpeg', default='ffmpeg')
    ap.add_argument('--mp3-bitrate', default='192k')
    ap.add_argument('--no-preview', action='store_true')
    args = ap.parse_args(argv)
    result = mix_song(
        os.path.abspath(args.song_dir),
        shift=args.shift,
        target_lufs=args.target_lufs,
        vocal_offset_db=args.vocal_offset_db,
        inst_offset_db=args.inst_offset_db,
        peak_limit_dbfs=args.peak_limit_dbfs,
        reverb=tuple(args.reverb) if args.reverb else None,  # type: ignore[arg-type]
        ffmpeg=args.ffmpeg,
        mp3_bitrate=args.mp3_bitrate,
        preview=not args.no_preview,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
