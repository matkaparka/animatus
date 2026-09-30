"""Settings of the singing service.

The plugin config names three things (the interpreter, the songs folder, and a YAML file); everything else is in
that file, with the same sections the legacy service had. Every key has a default and bounds, and a key this module
does not know is an error that names it: a typo must not silently change nothing. Relative paths in the file are
relative to the file's own folder.
"""

from __future__ import annotations

import dataclasses
import os
import shutil
from dataclasses import dataclass, field
from typing import Any, get_args, get_origin, get_type_hints

import yaml

DEFAULT_VOCAL_MODEL = 'vocals_mel_band_roformer.ckpt'
DEFAULT_KARAOKE_MODEL = 'mel_band_roformer_karaoke_becruily.ckpt'
DEFAULT_DEREVERB_MODEL = 'dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt'
DEFAULT_TRANSPOSE_CHOICES = (-12, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 12)
AUDIO_EXTENSIONS = ('.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus', '.aac', '.wma')


class SettingsError(ValueError):
    """The settings file is not usable; the message names the key."""


def _opt(default: Any, lo: float | None = None, hi: float | None = None, choices: tuple | None = None) -> Any:
    return field(default=default, metadata={'lo': lo, 'hi': hi, 'choices': choices})


def _seq(factory: Any, coerce_numbers: bool = False) -> Any:
    return field(default_factory=factory, metadata={'coerce_numbers': coerce_numbers})


@dataclass(frozen=True)
class Paths:
    #: The folder of audio files the `local` source searches. Sidecar `.lrc` files next to a file give its lyrics.
    local_music: str = ''
    #: `ffmpeg` on the PATH, or a full path.
    ffmpeg: str = 'ffmpeg'
    #: Where the separation models are kept (downloaded on first use). Empty: `models/` in the state folder.
    models: str = ''
    #: The Applio folder (the one that holds core.py).
    applio: str = ''
    #: Applio's own interpreter. Empty: the .venv inside the Applio folder.
    applio_python: str = ''


@dataclass(frozen=True)
class Ncm:
    #: Address of the NetEase API server you run (for example http://127.0.0.1:3300). Empty: not used.
    base_url: str = ''
    #: Every request to NetEase is serialised, this far apart, across processes.
    min_interval_sec: float = _opt(3.0, 0.5, 60.0)
    timeout_sec: float = _opt(20.0, 1.0, 120.0)
    level: str = _opt('exhigh', choices=('standard', 'higher', 'exhigh', 'lossless'))
    search_limit: int = _opt(10, 1, 30)
    #: New downloads per run of the service ("per show"); songs already in the library do not count.
    max_new_downloads_per_session: int = _opt(30, 0, 1000)


@dataclass(frozen=True)
class Separation:
    vocal_model: str = DEFAULT_VOCAL_MODEL
    #: Lead / backing split: the backing vocals go back into the instrumental and only the lead is converted.
    split_backing: bool = True
    karaoke_model: str = DEFAULT_KARAOKE_MODEL
    dereverb_model: str = DEFAULT_DEREVERB_MODEL


@dataclass(frozen=True)
class Voice:
    #: The median f0 of the voice's training material; 0 means unknown and every song is sung at its own pitch.
    f0_median_hz: float = _opt(0.0, 0.0, 2000.0)
    #: The range the voice is comfortable in; a song that lands outside it too often gets a warning.
    comfort_low_hz: float = _opt(0.0, 0.0, 2000.0)
    comfort_high_hz: float = _opt(0.0, 0.0, 4000.0)


@dataclass(frozen=True)
class Rvc:
    model_pth: str = ''
    index: str = ''
    f0_method: str = 'rmvpe'
    index_rate: float = _opt(0.5, 0.0, 1.0)
    protect: float = _opt(0.33, 0.0, 0.5)
    volume_envelope: float = _opt(1.0, 0.0, 1.0)
    embedder: str = 'contentvec'


@dataclass(frozen=True)
class Transpose:
    max_abs: int = _opt(12, 0, 24)
    #: Automatic transposition only picks one of these (whole octaves, or a few semitones).
    allowed: list[int] = _seq(lambda: list(DEFAULT_TRANSPOSE_CHOICES))
    #: A transposition that is not a whole octave is applied to the instrumental too, or the two would not agree.
    shift_instrumental: bool = True
    #: Song id to semitones, for the songs the automatic choice gets wrong.
    overrides: dict[str, int] = _seq(dict)


@dataclass(frozen=True)
class Reverb:
    enabled: bool = False
    room_size: float = _opt(0.25, 0.0, 1.0)
    wet_level: float = _opt(0.12, 0.0, 1.0)
    dry_level: float = _opt(0.9, 0.0, 1.0)


@dataclass(frozen=True)
class Mix:
    #: Loudness of the mixed song; the speaking voice's own loudness is the natural choice.
    target_lufs: float = _opt(-18.5, -40.0, -5.0)
    vocal_offset_db: float = _opt(0.0, -12.0, 12.0)
    inst_offset_db: float = _opt(-2.0, -12.0, 12.0)
    peak_limit_dbfs: float = _opt(-1.0, -12.0, 0.0)
    reverb: Reverb = field(default_factory=Reverb)
    mp3_bitrate: str = '192k'
    #: Also write a mixed mix.mp3 for listening by hand (needs ffmpeg; a failure there never fails the song).
    preview_mp3: bool = True


@dataclass(frozen=True)
class Qc:
    max_duration_sec: float = _opt(360.0, 30.0, 3600.0)
    #: Vocal energy over total energy after separation; below this the song is instrumental and refused.
    min_vocal_ratio: float = _opt(0.03, 0.0, 1.0)
    out_of_range_warn_ratio: float = _opt(0.25, 0.0, 1.0)


@dataclass(frozen=True)
class Queue:
    max_per_user: int = _opt(1, 1, 20)
    max_len: int = _opt(5, 1, 100)
    repeat_cooldown_min: float = _opt(30.0, 0.0, 1440.0)
    #: Song ids; YAML reads an unquoted 186016 as a number, which is accepted here.
    blacklist_ids: list[str] = _seq(list, coerce_numbers=True)
    blacklist_keywords: list[str] = _seq(list)
    #: After a restart only requests newer than this come back: last show's queue must not start singing at start-up.
    restore_within_min: float = _opt(20.0, 0.0, 1440.0)
    #: How long a failed entry stays in the queue view so the failure can be announced.
    failed_keep_sec: float = _opt(600.0, 30.0, 86400.0)
    #: How long a viewer's request may take before the service gives up on it (the caller may ask for less).
    request_timeout_sec: float = _opt(25.0, 1.0, 120.0)


@dataclass(frozen=True)
class Timeouts:
    """Every subprocess has one, and is killed (with its children) when it runs out."""

    download_sec: float = _opt(300.0, 5.0, 3600.0)
    separate_sec: float = _opt(1500.0, 30.0, 7200.0)
    analyze_sec: float = _opt(300.0, 10.0, 3600.0)
    convert_sec: float = _opt(900.0, 30.0, 7200.0)
    mix_sec: float = _opt(600.0, 10.0, 3600.0)
    preview_sec: float = _opt(120.0, 5.0, 900.0)
    #: How long a job waits for the GPU lock another process (a prefetch run) holds.
    gpu_lock_wait_sec: float = _opt(1800.0, 5.0, 14400.0)


@dataclass(frozen=True)
class Retry:
    #: A network blip while fetching is retried this many times in all (1 means never) ...
    max_attempts: int = _opt(3, 1, 10)
    #: ... after these delays (the last one repeats).
    backoff_sec: list[float] = _seq(lambda: [30.0, 120.0])


@dataclass(frozen=True)
class Settings:
    #: `auto` uses NetEase when `ncm.base_url` is set and the local folder otherwise.
    source: str = _opt('auto', choices=('auto', 'local', 'netease'))
    paths: Paths = field(default_factory=Paths)
    ncm: Ncm = field(default_factory=Ncm)
    separation: Separation = field(default_factory=Separation)
    voice: Voice = field(default_factory=Voice)
    rvc: Rvc = field(default_factory=Rvc)
    transpose: Transpose = field(default_factory=Transpose)
    mix: Mix = field(default_factory=Mix)
    qc: Qc = field(default_factory=Qc)
    queue: Queue = field(default_factory=Queue)
    timeouts: Timeouts = field(default_factory=Timeouts)
    retry: Retry = field(default_factory=Retry)
    #: Delete the separation's intermediate files (about 250 MB a song) once the song is ready.
    keep_intermediate: bool = False
    #: Replacement texts for the reasons in messages.py, by code.
    messages: dict[str, str] = _seq(dict)


# ─────────────────────────────── reading and checking ───────────────────────────────


def _number(value: Any, where: str, integer: bool) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SettingsError(f'{where}: expected {"an integer" if integer else "a number"}, got {value!r}')
    if integer and int(value) != value:
        raise SettingsError(f'{where}: expected an integer, got {value!r}')
    if value != value or value in (float('inf'), float('-inf')):
        raise SettingsError(f'{where}: not a finite number')
    return int(value) if integer else float(value)


def _check(value: Any, typ: Any, meta: Any, where: str) -> Any:
    origin = get_origin(typ)
    if typ is bool:
        if not isinstance(value, bool):
            raise SettingsError(f'{where}: expected true or false, got {value!r}')
        return value
    if typ is int or typ is float:
        number = _number(value, where, typ is int)
        lo, hi = meta.get('lo'), meta.get('hi')
        if lo is not None and number < lo:
            raise SettingsError(f'{where}: {number} is below the minimum {lo}')
        if hi is not None and number > hi:
            raise SettingsError(f'{where}: {number} is above the maximum {hi}')
        return number
    if typ is str:
        if meta.get('coerce_numbers') and isinstance(value, int) and not isinstance(value, bool):
            value = str(value)
        if not isinstance(value, str):
            raise SettingsError(f'{where}: expected text, got {value!r}')
        choices = meta.get('choices')
        if choices and value not in choices:
            raise SettingsError(f'{where}: "{value}" is not one of {", ".join(choices)}')
        return value
    if origin is list:
        if not isinstance(value, list):
            raise SettingsError(f'{where}: expected a list, got {value!r}')
        (inner,) = get_args(typ)
        return [_check(item, inner, meta, f'{where}[{i}]') for i, item in enumerate(value)]
    if origin is dict:
        if not isinstance(value, dict):
            raise SettingsError(f'{where}: expected a mapping, got {value!r}')
        _, inner = get_args(typ)
        # YAML reads an unquoted 186016 as a number; ids and codes are text here
        return {str(k): _check(v, inner, {}, f'{where}.{k}') for k, v in value.items()}
    raise SettingsError(f'{where}: unsupported setting type')  # a bug in this module, not in a file


def _build(cls: type, raw: Any, where: str) -> Any:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise SettingsError(f'{where.rstrip(".") or "(file)"}: expected a mapping, got {type(raw).__name__}')
    hints = get_type_hints(cls)
    known = {f.name for f in dataclasses.fields(cls)}
    for key in raw:
        if key not in known:
            raise SettingsError(f'{where}{key}: unknown setting (known: {", ".join(sorted(known))})')
    values: dict[str, Any] = {}
    for f in dataclasses.fields(cls):
        if f.name not in raw:
            continue
        typ = hints[f.name]
        if dataclasses.is_dataclass(typ):
            values[f.name] = _build(typ, raw[f.name], f'{where}{f.name}.')
        else:
            values[f.name] = _check(raw[f.name], typ, f.metadata, f'{where}{f.name}')
    return cls(**values)


def parse_settings(raw: Any) -> Settings:
    """Settings from an already-parsed mapping (what the YAML file holds). Raises SettingsError."""
    return _build(Settings, raw, '')


# ─────────────────────────────── the running configuration ───────────────────────────────


def _resolve(base: str, value: str) -> str:
    if not value:
        return ''
    return os.path.normpath(value if os.path.isabs(value) else os.path.join(base, value))


def _with_absolute_paths(s: Settings, base: str) -> Settings:
    ffmpeg = s.paths.ffmpeg
    if os.sep in ffmpeg or '/' in ffmpeg:
        ffmpeg = _resolve(base, ffmpeg)
    paths = dataclasses.replace(
        s.paths,
        local_music=_resolve(base, s.paths.local_music),
        models=_resolve(base, s.paths.models),
        applio=_resolve(base, s.paths.applio),
        applio_python=_resolve(base, s.paths.applio_python),
        ffmpeg=ffmpeg,
    )
    rvc = dataclasses.replace(
        s.rvc, model_pth=_resolve(base, s.rvc.model_pth), index=_resolve(base, s.rvc.index)
    )
    return dataclasses.replace(s, paths=paths, rvc=rvc)


@dataclass(frozen=True)
class Config:
    """What the service runs with: the settings file, and the two folders the plugin config names."""

    settings: Settings
    songs_dir: str
    state_dir: str

    @property
    def source_kind(self) -> str:
        if self.settings.source != 'auto':
            return self.settings.source
        return 'netease' if self.settings.ncm.base_url else 'local'

    @property
    def models_dir(self) -> str:
        return self.settings.paths.models or os.path.join(self.state_dir, 'models')

    @property
    def applio_python(self) -> str:
        if self.settings.paths.applio_python:
            return self.settings.paths.applio_python
        scripts = 'Scripts' if os.name == 'nt' else 'bin'
        exe = 'python.exe' if os.name == 'nt' else 'python'
        return os.path.join(self.settings.paths.applio, '.venv', scripts, exe)

    @property
    def ffmpeg(self) -> str:
        return self.settings.paths.ffmpeg

    def ffmpeg_found(self) -> bool:
        return os.path.isfile(self.ffmpeg) or shutil.which(self.ffmpeg) is not None

    def problems(self, pipeline: bool = True) -> list[str]:
        """What is wrong with the setup, one line each, most important first. Empty means it can work."""
        s = self.settings
        found: list[str] = []
        for label, folder in (('the songs folder', self.songs_dir), ('the state folder', self.state_dir)):
            try:
                os.makedirs(folder, exist_ok=True)
            except OSError as error:
                found.append(f'{label} cannot be created ({folder}): {error.strerror or error}')
        if self.source_kind == 'local':
            if not s.paths.local_music:
                found.append('paths.local_music is not set: the local source needs a folder of audio files')
            elif not os.path.isdir(s.paths.local_music):
                found.append(f'paths.local_music is not a folder: {s.paths.local_music}')
        elif not s.ncm.base_url.lower().startswith(('http://', 'https://')):
            found.append('ncm.base_url must be an http(s) address when the source is netease')
        if pipeline:
            if not os.path.isfile(os.path.join(s.paths.applio, 'core.py')):
                found.append(f'paths.applio: no core.py in "{s.paths.applio}" (the Applio folder)')
            if not os.path.isfile(self.applio_python):
                found.append(f'paths.applio_python: no interpreter at {self.applio_python}')
            if not os.path.isfile(s.rvc.model_pth):
                found.append(f'rvc.model_pth: no model file at "{s.rvc.model_pth}"')
            if s.rvc.index and not os.path.isfile(s.rvc.index):
                found.append(f'rvc.index: no index file at {s.rvc.index}')
            if not self.ffmpeg_found():
                found.append(f'paths.ffmpeg: "{self.ffmpeg}" is not a file and not on the PATH')
        return found

    def summary(self) -> dict[str, Any]:
        """Effective settings worth showing in the console. Nothing secret is in here."""
        s = self.settings
        return {
            'source': self.source_kind,
            'songs_dir': self.songs_dir,
            'max_per_user': s.queue.max_per_user,
            'max_len': s.queue.max_len,
            'rvc_model': os.path.basename(s.rvc.model_pth),
            'max_duration_sec': s.qc.max_duration_sec,
        }


def load_config(settings_file: str, songs_dir: str, state_dir: str) -> Config:
    """Reads the settings file (an empty name or a missing file means all defaults) and makes the paths absolute."""
    raw: Any = {}
    base = os.getcwd()
    if settings_file:
        base = os.path.dirname(os.path.abspath(settings_file))
        try:
            with open(settings_file, encoding='utf-8-sig') as handle:
                raw = yaml.safe_load(handle)
        except FileNotFoundError:
            raw = {}
        except (OSError, yaml.YAMLError) as error:
            lines = str(error).splitlines()
            raise SettingsError(f'{settings_file}: cannot be read: {lines[0] if lines else "unknown error"}') from None
    try:
        settings = parse_settings(raw)
    except SettingsError as error:
        raise SettingsError(f'{settings_file or "settings"}: {error}') from None
    return Config(
        settings=_with_absolute_paths(settings, base),
        songs_dir=os.path.abspath(songs_dir),
        state_dir=os.path.abspath(state_dir),
    )
