"""The pipeline's tool scripts: what can be checked without a GPU, a model or a network.

The mix is checked on synthetic audio against the loudness a sine wave is defined to have; separation is checked
with a stand-in for `audio-separator` that writes files named the way the real one names them.
"""

import math
import os
import unittest

import numpy as np
import soundfile as sf

from singing_service.steps import step_f0, step_mix, step_separate

from .support import TempCase

SR = 44100


def sine(seconds: float, amplitude: float, channels: int = 2, freq: float = 997.0, rate: int = SR):
    t = np.arange(int(seconds * rate)) / rate
    wave = amplitude * np.sin(2 * math.pi * freq * t)
    return np.stack([wave] * channels, axis=1) if channels > 1 else wave


class Loudness(unittest.TestCase):
    def test_a_full_scale_stereo_sine_is_zero_lufs_and_half_amplitude_is_six_db_lower(self):
        self.assertAlmostEqual(step_mix.integrated_lufs(sine(3, 1.0), SR), 0.0, delta=0.1)
        self.assertAlmostEqual(step_mix.integrated_lufs(sine(3, 0.5), SR), -6.02, delta=0.1)

    def test_one_channel_is_three_db_below_two(self):
        two = step_mix.integrated_lufs(sine(3, 0.5, channels=2), SR)
        one = step_mix.integrated_lufs(sine(3, 0.5, channels=1), SR)
        self.assertAlmostEqual(two - one, 3.01, delta=0.1)

    def test_it_holds_at_other_sample_rates(self):
        self.assertAlmostEqual(step_mix.integrated_lufs(sine(3, 0.5, rate=48000), 48000), -6.02, delta=0.1)
        self.assertAlmostEqual(step_mix.integrated_lufs(sine(3, 0.5, rate=22050), 22050), -6.02, delta=0.15)

    def test_silence_is_the_floor_and_a_short_sound_is_one_block(self):
        self.assertEqual(step_mix.integrated_lufs(np.zeros((SR, 2)), SR), -70.0)
        self.assertAlmostEqual(step_mix.integrated_lufs(sine(0.2, 0.5), SR), -6.02, delta=0.6)

    def test_a_long_silence_does_not_pull_the_measure_down(self):
        loud = sine(3, 0.5)
        padded = np.vstack([loud, np.zeros((SR * 30, 2))])
        self.assertAlmostEqual(step_mix.integrated_lufs(padded, SR), step_mix.integrated_lufs(loud, SR), delta=0.3)


class Mix(TempCase):
    def song(self, vocal_amplitude=0.2, inst_amplitude=0.6) -> str:
        d = self.tmpdir()
        sf.write(os.path.join(d, 'vocals_rvc.wav'), sine(2.0, vocal_amplitude, channels=1, freq=440, rate=22050), 22050)
        sf.write(os.path.join(d, 'inst.wav'), sine(2.5, inst_amplitude, channels=2, freq=220), SR, subtype='FLOAT')
        return d

    def test_it_writes_a_mono_voice_and_a_stereo_band_at_the_target_level(self):
        d = self.song()
        info = step_mix.mix_song(d, target_lufs=-18.5, inst_offset_db=-2.0, preview=False)
        voice, voice_rate = sf.read(os.path.join(d, 'vocals_final.wav'), always_2d=True)
        band, band_rate = sf.read(os.path.join(d, 'inst_final.wav'), always_2d=True)
        self.assertEqual((voice.shape[1], band.shape[1], voice_rate, band_rate), (1, 2, SR, SR))
        self.assertEqual(len(voice), len(band))  # padded to the longer of the two
        mixed = band.copy()
        mixed[:, 0] += voice[:, 0]
        mixed[:, 1] += voice[:, 0]
        self.assertAlmostEqual(step_mix.integrated_lufs(mixed, SR), -18.5, delta=0.6)
        self.assertLessEqual(float(np.abs(mixed).max()), 10 ** (-1.0 / 20) + 0.01)
        self.assertAlmostEqual(info['duration'], 2.5, delta=0.01)
        self.assertEqual(info['preview'], 'skipped')
        self.assertFalse(os.path.exists(os.path.join(d, 'mix_tmp.wav')))

    def test_the_offsets_set_the_voice_against_the_band(self):
        d = self.song()
        step_mix.mix_song(d, vocal_offset_db=0.0, inst_offset_db=-6.0, preview=False)
        voice, _ = sf.read(os.path.join(d, 'vocals_final.wav'), always_2d=True)
        band, _ = sf.read(os.path.join(d, 'inst_final.wav'), always_2d=True)
        # the voice is measured as two channels, the band as two: the band sits 6 dB under the voice
        gap = step_mix.integrated_lufs(np.repeat(voice, 2, axis=1), SR) - step_mix.integrated_lufs(band, SR)
        self.assertAlmostEqual(gap, 6.0, delta=0.6)

    def test_the_peak_ceiling_wins_over_the_target_loudness(self):
        d = self.song(vocal_amplitude=0.9, inst_amplitude=0.9)
        step_mix.mix_song(d, target_lufs=-6.0, peak_limit_dbfs=-6.0, preview=False)
        voice, _ = sf.read(os.path.join(d, 'vocals_final.wav'), always_2d=True)
        band, _ = sf.read(os.path.join(d, 'inst_final.wav'), always_2d=True)
        self.assertLessEqual(float((band + voice).max()), 10 ** (-6.0 / 20) + 0.01)

    def test_a_failed_preview_never_fails_the_song(self):
        d = self.song()
        info = step_mix.mix_song(d, ffmpeg=os.path.join(self.tmpdir(), 'no-ffmpeg'), preview=True)
        self.assertTrue(info['preview'].startswith('failed'))
        self.assertTrue(os.path.isfile(os.path.join(d, 'vocals_final.wav')))
        self.assertFalse(os.path.exists(os.path.join(d, 'mix_tmp.wav')))

    def test_a_transposed_band_without_pedalboard_stops_with_a_clear_message(self):
        d = self.song()
        try:
            import pedalboard  # noqa: F401
        except ImportError:
            with self.assertRaises(SystemExit) as caught:
                step_mix.mix_song(d, shift=3, preview=False)
            self.assertIn('pedalboard', str(caught.exception))


class FakeSeparator:
    """Writes the stems the way `audio-separator` names them: `<input>_(<Stem>)_<model>.wav` in `output_dir`."""

    def __init__(self, stems: dict[str, tuple[str, str]], audio: dict[str, np.ndarray]) -> None:
        self.stems = stems  # model -> (kept stem name, dropped stem name)
        self.audio = audio  # stem name -> samples
        self.output_dir = ''
        self.model = ''
        self.loaded: list[str] = []

    def load_model(self, model_filename: str) -> None:
        self.model = model_filename
        self.loaded.append(model_filename)

    def separate(self, src: str) -> None:
        base = os.path.splitext(os.path.basename(src))[0]
        for stem in self.stems[self.model]:
            sf.write(os.path.join(self.output_dir, f'{base}_({stem})_{self.model}.wav'), self.audio[stem], SR, subtype='FLOAT')


class Separation(TempCase):
    def fake(self):
        n = SR
        audio = {
            'Vocals': sine(1, 0.3, freq=300)[:n],
            'Instrumental': sine(1, 0.1, freq=100)[:n],
            'Lead': sine(1, 0.2, freq=300)[:n],
            'Backing': sine(1, 0.05, freq=400)[:n],
            'No Reverb': sine(1, 0.19, freq=300)[:n],
            'Reverb': sine(1, 0.01, freq=300)[:n],
        }
        stems = {
            'vocal.ckpt': ('Vocals', 'Instrumental'),
            'karaoke.ckpt': ('Lead', 'Backing'),
            'dereverb.ckpt': ('No Reverb', 'Reverb'),
        }
        return FakeSeparator(stems, audio), audio

    def to_wav(self, audio):
        def convert(src: str, dst: str) -> None:
            sf.write(dst, audio['Vocals'] + audio['Instrumental'], SR, subtype='FLOAT')

        return convert

    def test_stems_are_recognised_by_name(self):
        self.assertEqual(step_separate.stem_of('/x/song_(Vocals)_model_v2.wav'), 'vocals')
        self.assertEqual(step_separate.stem_of('/x/song_(Vocals)_(No Reverb)_m.wav'), 'no reverb')
        self.assertEqual(step_separate.stem_of('/x/plain.wav'), '')
        cases = {'vocals': 'keep', 'lead': 'keep', 'no reverb': 'keep', 'dry': 'keep', 'instrumental': 'drop',
                 'no vocals': 'drop', 'backing': 'drop', 'reverb': 'drop', 'echo': 'drop', 'drums': '?', '': '?'}
        for stem, kind in cases.items():
            self.assertEqual(step_separate.classify(stem), kind, stem)

    def test_a_model_whose_output_is_not_recognised_stops_the_step(self):
        sep, audio = self.fake()
        sep.stems['vocal.ckpt'] = ('Vocals', 'Drums')
        audio['Drums'] = audio['Vocals']
        with self.assertRaisesRegex(RuntimeError, 'not recognised'):
            step_separate.run_model(sep, 'vocal.ckpt', self.write_input(), self.tmpdir())

    def write_input(self) -> str:
        path = os.path.join(self.tmpdir(), 'orig.wav')
        sf.write(path, np.zeros((SR, 2)), SR)
        return path

    def test_the_whole_step_with_backing_split(self):
        sep, audio = self.fake()
        d = self.tmpdir()
        with open(os.path.join(d, 'orig.mp3'), 'wb') as handle:
            handle.write(b'not really audio')
        result = step_separate.separate_song(
            d, step_separate.Options(*('vocal.ckpt', 'dereverb.ckpt', 'karaoke.ckpt', True)), sep, self.to_wav(audio)
        )
        self.assertEqual(sep.loaded, ['vocal.ckpt', 'karaoke.ckpt', 'dereverb.ckpt'])
        vocals, _ = sf.read(os.path.join(d, 'vocals.wav'), always_2d=True)
        inst, _ = sf.read(os.path.join(d, 'inst.wav'), always_2d=True)
        np.testing.assert_allclose(vocals, audio['No Reverb'], atol=1e-6)  # the dry lead goes on to the voice conversion
        np.testing.assert_allclose(inst, audio['Instrumental'] + audio['Backing'], atol=1e-6)  # backing joins the band
        self.assertEqual(result['models'], ['vocal.ckpt', 'karaoke.ckpt', 'dereverb.ckpt'])
        orig_power = np.mean((audio['Vocals'] + audio['Instrumental']) ** 2)
        self.assertAlmostEqual(result['vocal_ratio'], float(np.mean(audio['Vocals'] ** 2) / orig_power), places=3)
        self.assertLess(result['lead_ratio'], result['vocal_ratio'])
        self.assertAlmostEqual(result['duration'], 1.0, places=2)

    def test_without_the_split_the_whole_vocal_is_converted_and_the_band_is_untouched(self):
        sep, audio = self.fake()
        d = self.tmpdir()
        with open(os.path.join(d, 'orig.flac'), 'wb') as handle:
            handle.write(b'x')
        step_separate.separate_song(d, step_separate.Options('vocal.ckpt', 'dereverb.ckpt', '', False), sep, self.to_wav(audio))
        self.assertEqual(sep.loaded, ['vocal.ckpt', 'dereverb.ckpt'])
        inst, _ = sf.read(os.path.join(d, 'inst.wav'), always_2d=True)
        np.testing.assert_allclose(inst, audio['Instrumental'], atol=1e-6)

    def test_a_folder_without_an_original_is_an_error(self):
        sep, audio = self.fake()
        with self.assertRaises(SystemExit):
            step_separate.separate_song(self.tmpdir(), step_separate.Options('a', 'b', 'c', True), sep, self.to_wav(audio))


class PitchStatistics(unittest.TestCase):
    def test_the_summary_has_the_percentiles_and_a_hundred_and_one_quantiles(self):
        voiced = np.linspace(100.0, 300.0, 1001)
        stats = step_f0.summarize(voiced, files=1, frames=2000)
        self.assertEqual((stats['files'], stats['frames'], stats['voiced']), (1, 2000, 1001))
        self.assertAlmostEqual(stats['median_hz'], 200.0, places=1)
        self.assertEqual(len(stats['quantiles_hz']), 101)
        self.assertAlmostEqual(stats['quantiles_hz'][0], 100.0, places=1)
        self.assertAlmostEqual(stats['quantiles_hz'][100], 300.0, places=1)

    def test_a_vocal_with_no_voiced_frame_has_counts_only(self):
        stats = step_f0.summarize(np.zeros(0), files=1, frames=500)
        self.assertNotIn('median_hz', stats)
        self.assertEqual(stats['voiced'], 0)


if __name__ == '__main__':
    unittest.main()
