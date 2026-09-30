"""One song through the pipeline, with the tools simulated (see fakes.py).

The defects of the legacy pipeline each have a test here that fails on the old behaviour: a failure of the source
was written down as a rejection of the song; a step had no time limit; a removed song went on being prepared.
"""

import dataclasses
import os
import threading
import time
import unittest

from singing_service import library
from singing_service.control import Cancel
from singing_service.errors import Abandoned, GpuBusy, NotConfigured, SongRejected, SourceUnavailable, StepFailed, StepTimeout
from singing_service.locks import FileLock
from singing_service.pipeline import Pipeline, out_of_range_ratio, pick_transpose

from .fakes import FakeRunner, FakeSource, make_config, song
from .support import TempCase


class Harness(TempCase):
    def make(self, source: FakeSource | None = None, runner: FakeRunner | None = None, **settings):
        self.root = self.tmpdir()
        self.cfg = make_config(self.root, **settings)
        self.source = source or FakeSource([song('42', 'Song', ('Artist',))])
        self.runner = runner or FakeRunner()
        self.lock = FileLock(os.path.join(self.cfg.state_dir, 'locks', 'gpu.lock'))
        self.pipeline = Pipeline(self.cfg, self.source, self.runner, self.lock, python='py')
        return self.pipeline

    def prepare(self, sid: str = '42', cancel: Cancel | None = None) -> dict:
        cancel = cancel or Cancel()
        found = self.source.songs[0] if sid == '42' else next(s for s in self.source.songs if s['id'] == sid)
        self.pipeline.fetch(found, {'uid': '7', 'name': 'ann'}, cancel)
        return self.pipeline.process(sid, cancel)

    def meta(self, sid: str = '42') -> dict:
        return library.read_meta(self.cfg.songs_dir, sid) or {}

    def cmd(self, step: str) -> list[str]:
        return next(c for s, c in self.runner.calls if s == step)


class Fetch(Harness):
    def test_the_original_and_lyrics_land_in_the_library_and_the_requester_is_noted(self):
        self.make()
        meta = self.pipeline.fetch(self.source.songs[0], {'uid': '7', 'name': 'ann'}, Cancel())
        d = library.song_dir(self.cfg.songs_dir, '42')
        self.assertTrue(os.path.isfile(os.path.join(d, 'orig.mp3')))
        self.assertIn('first line', library.read_lyric_text(d))
        self.assertEqual(meta['status'], 'downloaded')
        self.assertEqual(self.meta()['steps']['download']['status'], 'done')
        self.assertEqual(self.meta()['requests'][0]['name'], 'ann')
        self.assertEqual(self.meta()['name'], 'Song')

    def test_a_song_already_downloaded_is_not_fetched_again(self):
        self.make()
        self.pipeline.fetch(self.source.songs[0], None, Cancel())
        self.pipeline.fetch(self.source.songs[0], {'uid': '8', 'name': 'bob'}, Cancel())
        self.assertEqual(self.source.fetch_calls, ['42'])
        self.assertEqual([r['name'] for r in self.meta()['requests']], ['bob'])

    def test_a_paid_song_is_refused_before_any_request_and_leaves_no_trace_in_the_library(self):
        self.make()
        self.source.precheck_codes['42'] = ('vip_only', 'fee=1')
        with self.assertRaises(SongRejected) as caught:
            self.pipeline.fetch(self.source.songs[0], None, Cancel())
        self.assertEqual(caught.exception.code, 'vip_only')
        self.assertEqual(self.source.fetch_calls, [])
        self.assertIsNone(library.read_meta(self.cfg.songs_dir, '42'))  # depends on the account, so not written down

    def test_too_long_by_the_length_the_search_gave(self):
        self.make(source=FakeSource([song('42', 'Long', duration=1000.0)]))
        with self.assertRaises(SongRejected) as caught:
            self.pipeline.fetch(self.source.songs[0], None, Cancel())
        self.assertEqual(caught.exception.code, 'too_long')
        self.assertEqual(self.source.fetch_calls, [])

    # ─── (a) the failure of a source is not the song's fault ───

    def test_a_source_that_failed_leaves_the_song_open_to_a_new_request(self):
        """The legacy pipeline turned every download error into a permanent rejection of the song."""
        self.make()
        for error in (
            SourceUnavailable('a blip', code='source_down', auto_retry=True),
            SourceUnavailable('breaker', code='source_halted'),
            SourceUnavailable('cap', code='download_cap'),
        ):
            self.source.fetch_errors.append(error)
            with self.assertRaises(SourceUnavailable):
                self.pipeline.fetch(self.source.songs[0], None, Cancel())
            meta = self.meta()
            self.assertNotEqual(meta.get('status'), 'rejected')
            self.assertEqual(meta['steps']['download']['status'], 'failed')
            self.assertEqual(meta['steps']['download']['code'], error.code)
        self.pipeline.fetch(self.source.songs[0], None, Cancel())  # and the next request works
        self.assertEqual(self.meta()['status'], 'downloaded')

    def test_what_the_source_says_it_cannot_give_is_not_written_down_either(self):
        self.make()
        self.source.fetch_errors.append(SongRejected('no url', code='no_audio'))
        with self.assertRaises(SongRejected):
            self.pipeline.fetch(self.source.songs[0], None, Cancel())
        self.assertNotEqual(self.meta().get('status'), 'rejected')

    def test_a_source_that_says_it_finished_but_left_nothing_is_a_failure(self):
        self.make()
        self.source.fetch_hook = lambda s, c: None
        original_fetch = self.source.fetch

        def empty_fetch(song_, dest, cancel, timeout):
            os.makedirs(dest, exist_ok=True)

        self.source.fetch = empty_fetch  # type: ignore[method-assign]
        with self.assertRaises(StepFailed):
            self.pipeline.fetch(self.source.songs[0], None, Cancel())
        self.source.fetch = original_fetch  # type: ignore[method-assign]

    def test_a_cancelled_fetch_is_marked_cancelled_and_raises_abandoned(self):
        self.make()
        cancel = Cancel()
        self.source.fetch_hook = lambda s, c: cancel.set('removed') or c.check()
        with self.assertRaises(Abandoned):
            self.pipeline.fetch(self.source.songs[0], None, cancel)
        self.assertEqual(self.meta()['steps']['download']['status'], 'cancelled')

    def test_a_setup_that_cannot_finish_a_song_does_not_start_it(self):
        self.make()
        os.remove(self.cfg.settings.rvc.model_pth)
        with self.assertRaises(NotConfigured) as caught:
            self.pipeline.fetch(self.source.songs[0], None, Cancel())
        self.assertIn('rvc.model_pth', caught.exception.fields['detail'])
        self.assertEqual(self.source.fetch_calls, [])  # nothing was downloaded for nothing


class Process(Harness):
    def test_the_steps_run_in_order_and_the_song_is_ready_with_its_files(self):
        self.make()
        meta = self.prepare()
        self.assertEqual(self.runner.steps(), ['separate', 'analyze', 'convert', 'mix'])
        self.assertEqual(meta['status'], 'ready')
        d = library.song_dir(self.cfg.songs_dir, '42')
        self.assertTrue(library.final_files_present(d))
        self.assertEqual(meta['duration'], 200.0)
        for step in ('download', 'separate', 'analyze', 'convert', 'mix'):
            self.assertEqual(self.meta()['steps'][step]['status'], 'done', step)
        self.assertTrue(library.is_current(meta, self.cfg.settings.rvc))

    def test_the_commands_carry_the_settings(self):
        index = os.path.join(self.tmpdir(), 'voice.index')
        open(index, 'w').close()
        self.make(
            separation={'vocal_model': 'v.ckpt', 'karaoke_model': 'k.ckpt', 'dereverb_model': 'd.ckpt'},
            rvc={'index': index, 'index_rate': 0.7, 'protect': 0.2},
            mix={'target_lufs': -20.0, 'inst_offset_db': -3.0, 'mp3_bitrate': '128k'},
        )
        self.prepare()
        sep, convert, mix = self.cmd('separate'), self.cmd('convert'), self.cmd('mix')
        self.assertEqual(sep[0], 'py')
        for flag, value in (('--vocal-model', 'v.ckpt'), ('--karaoke-model', 'k.ckpt'), ('--dereverb-model', 'd.ckpt')):
            self.assertEqual(sep[sep.index(flag) + 1], value)
        self.assertEqual(convert[1:3], ['core.py', 'infer'])
        self.assertEqual(convert[convert.index('--index-rate') + 1], '0.7')
        self.assertEqual(convert[convert.index('--protect') + 1], '0.2')
        self.assertIn('--index-path', convert)
        self.assertEqual(mix[mix.index('--target-lufs') + 1], '-20.0')
        self.assertEqual(mix[mix.index('--mp3-bitrate') + 1], '128k')
        self.assertNotIn('--reverb', mix)

    def test_optional_switches(self):
        self.make(separation={'split_backing': False}, mix={'reverb': {'enabled': True}, 'preview_mp3': False})
        self.prepare()
        sep, convert, mix = self.cmd('separate'), self.cmd('convert'), self.cmd('mix')
        self.assertIn('--no-split-backing', sep)
        self.assertNotIn('--karaoke-model', sep)
        self.assertNotIn('--index-path', convert)  # no index file is set
        self.assertEqual(mix[mix.index('--reverb') + 1:mix.index('--reverb') + 4], ['0.25', '0.12', '0.9'])
        self.assertIn('--no-preview', mix)

    def test_the_tools_do_not_see_the_account_cookie(self):
        self.make()
        seen: dict[str, str] = {}
        original = self.runner.run

        def spy(cmd, **kw):
            seen.update(kw['env'])
            return original(cmd, **kw)

        self.runner.run = spy  # type: ignore[method-assign]
        os.environ['NCM_COOKIE'] = 'made-up-cookie'
        self.addCleanup(os.environ.pop, 'NCM_COOKIE', None)
        self.prepare()
        self.assertNotIn('NCM_COOKIE', seen)
        self.assertEqual(seen['PYTHONIOENCODING'], 'utf-8')

    # ─── the transposition ───

    def test_the_song_is_moved_to_the_voice_and_the_band_follows_when_it_is_not_a_whole_octave(self):
        self.make(voice={'f0_median_hz': 261.63})  # a song at 220 Hz is three semitones below the voice
        self.prepare()
        self.assertEqual(self.meta()['transpose'], 3)
        self.assertEqual(self.cmd('convert')[self.cmd('convert').index('--pitch') + 1], '3')
        self.assertEqual(self.cmd('mix')[self.cmd('mix').index('--shift') + 1], '3')
        analyze = self.meta()['steps']['analyze']
        self.assertEqual((analyze['transpose_source'], analyze['inst_shift']), ('auto', 3))

    def test_a_whole_octave_moves_the_voice_only(self):
        self.make(voice={'f0_median_hz': 110.0})
        self.prepare()
        self.assertEqual(self.meta()['transpose'], -12)
        self.assertEqual(self.cmd('mix')[self.cmd('mix').index('--shift') + 1], '0')

    def test_the_band_is_left_alone_when_the_setting_says_so(self):
        self.make(voice={'f0_median_hz': 261.63}, transpose={'shift_instrumental': False})
        self.prepare()
        self.assertEqual(self.cmd('mix')[self.cmd('mix').index('--shift') + 1], '0')

    def test_an_override_wins_and_no_voice_pitch_means_no_change(self):
        self.make(transpose={'overrides': {'42': -5}})
        self.prepare()
        self.assertEqual(self.meta()['transpose'], -5)
        self.assertEqual(self.meta()['steps']['analyze']['transpose_source'], 'override')
        self.make(voice={'f0_median_hz': 0.0})
        self.prepare()
        self.assertEqual(self.meta()['transpose'], 0)
        self.assertEqual(self.meta()['steps']['analyze']['transpose_source'], 'no-f0')

    def test_pick_transpose_rounds_to_what_is_allowed_and_stops_at_the_limit(self):
        cfg = make_config(self.tmpdir(), voice={'f0_median_hz': 200.0}, transpose={'allowed': [-12, -5, 0, 5, 12], 'max_abs': 12})
        self.assertEqual(pick_transpose(cfg, 'x', 200.0)[:1], (0,))
        # the song is this many semitones below the voice, so it has to go up by that much
        self.assertEqual(pick_transpose(cfg, 'x', 200.0 / 2 ** (3 / 12))[0], 5)  # 3 up: 5 is two away, 0 is three
        self.assertEqual(pick_transpose(cfg, 'x', 200.0 / 2 ** (2 / 12))[0], 0)  # 2 up: 0 is two away, 5 is three
        self.assertEqual(pick_transpose(cfg, 'x', 200.0 * 2 ** (11 / 12))[0], -12)  # 11 down: -12 is the nearest allowed
        self.assertEqual(pick_transpose(cfg, 'x', 200.0 * 4)[0], -12)  # 24 down: cut to the limit (12) first

    def test_the_share_of_notes_out_of_range_is_read_off_the_quantiles(self):
        quantiles = [100.0 + i for i in range(101)]  # 100 .. 200 Hz, evenly
        self.assertAlmostEqual(out_of_range_ratio(quantiles, 0, 100.0, 200.0), 0.0, places=2)
        self.assertAlmostEqual(out_of_range_ratio(quantiles, 0, 150.0, 200.0), 0.5, places=2)
        self.assertAlmostEqual(out_of_range_ratio(quantiles, 0, 100.0, 150.0), 0.5, places=2)
        self.assertAlmostEqual(out_of_range_ratio(quantiles, 12, 100.0, 300.0), 0.5, places=2)  # doubled: 200..400, top half over
        self.assertEqual(out_of_range_ratio(None, 0, 100.0, 200.0), 0.0)
        self.assertEqual(out_of_range_ratio(quantiles, 0, 0.0, 0.0), 0.0)  # no range known

    def test_a_song_that_lands_out_of_the_voice_range_gets_a_warning_but_is_sung(self):
        self.make(voice={'comfort_low_hz': 200.0, 'comfort_high_hz': 400.0})  # the fake song spans 110..330 Hz
        meta = self.prepare()
        self.assertEqual(meta['status'], 'ready')
        self.assertEqual(len(meta['warnings']), 1)
        self.assertIn('%', meta['warnings'][0])
        self.assertGreater(self.meta()['steps']['analyze']['out_of_range_ratio'], 0.25)

    # ─── what is done again, and what is not ───

    def test_a_ready_song_only_needs_its_mix_when_prepared_again(self):
        self.make()
        self.prepare()
        self.runner.calls.clear()
        self.pipeline.process('42', Cancel())
        self.assertEqual(self.runner.steps(), ['mix'])

    def test_a_change_of_voice_settings_makes_the_song_stale_and_only_the_conversion_and_mix_run_again(self):
        self.make()
        meta = self.prepare()
        self.assertTrue(library.is_current(meta, self.cfg.settings.rvc))
        newer = dataclasses.replace(self.cfg.settings.rvc, index_rate=0.9)
        self.assertFalse(library.is_current(self.meta(), newer))
        self.cfg = dataclasses.replace(self.cfg, settings=dataclasses.replace(self.cfg.settings, rvc=newer))
        self.pipeline.cfg = self.cfg
        self.runner.calls.clear()
        again = self.pipeline.process('42', Cancel())
        self.assertEqual(self.runner.steps(), ['convert', 'mix'])
        self.assertTrue(library.is_current(again, newer))

    def test_a_different_transposition_converts_again(self):
        self.make()
        self.prepare()
        self.runner.calls.clear()
        self.cfg = dataclasses.replace(
            self.cfg,
            settings=dataclasses.replace(self.cfg.settings, transpose=dataclasses.replace(self.cfg.settings.transpose, overrides={'42': 2})),
        )
        self.pipeline.cfg = self.cfg
        self.pipeline.process('42', Cancel())
        self.assertEqual(self.runner.steps(), ['convert', 'mix'])

    def test_the_intermediate_files_of_the_separation_go_unless_kept(self):
        self.make()
        self.prepare()
        d = library.song_dir(self.cfg.songs_dir, '42')
        self.assertFalse(os.path.exists(os.path.join(d, 'sep')))
        self.assertTrue(os.path.isfile(os.path.join(d, 'vocals.wav')))  # what a re-conversion needs stays
        self.make(keep_intermediate=True)
        self.prepare()
        self.assertTrue(os.path.exists(os.path.join(library.song_dir(self.cfg.songs_dir, '42'), 'sep')))

    # ─── the checks ───

    def test_a_song_with_no_singing_in_it_is_refused_and_remembered(self):
        self.make(runner=FakeRunner(vocal_ratio=0.01))
        with self.assertRaises(SongRejected) as caught:
            self.prepare()
        self.assertEqual(caught.exception.code, 'instrumental')
        meta = self.meta()
        self.assertEqual((meta['status'], meta['reject_code']), ('rejected', 'instrumental'))
        self.assertEqual(meta['steps']['separate']['vocal_ratio'], 0.01)
        self.assertEqual(self.runner.steps(), ['separate'])  # nothing ran after the check

    def test_too_long_by_the_length_the_separation_measured_is_not_written_down(self):
        self.make(runner=FakeRunner(duration=500.0))
        with self.assertRaises(SongRejected) as caught:
            self.prepare()
        self.assertEqual(caught.exception.code, 'too_long')
        self.assertNotEqual(self.meta().get('status'), 'rejected')  # the limit may change, the song does not

    # ─── (b) no step can hold the worker and the GPU for ever ───

    def test_a_tool_that_times_out_stops_the_song_with_a_retryable_failure_and_frees_the_lock(self):
        self.make()
        self.runner.errors['convert'] = StepTimeout('the voice conversion ran longer than 900 s and was stopped')
        with self.assertRaises(StepTimeout) as caught:
            self.prepare()
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(self.runner.steps(), ['separate', 'analyze', 'convert'])
        with self.lock.hold(1):  # the GPU lock was let go
            pass

    def test_the_timeouts_given_to_the_tools_are_the_settings(self):
        self.make(timeouts={'separate_sec': 111.0, 'analyze_sec': 222.0, 'convert_sec': 333.0, 'mix_sec': 444.0})
        seen: dict[str, float] = {}
        original = self.runner.run

        def spy(cmd, **kw):
            seen[self.runner.step_of(cmd)] = kw['timeout']
            return original(cmd, **kw)

        self.runner.run = spy  # type: ignore[method-assign]
        self.prepare()
        self.assertEqual(seen, {'separate': 111.0, 'analyze': 222.0, 'convert': 333.0, 'mix': 444.0})

    def test_a_tool_that_leaves_no_output_is_a_failure_and_a_broken_stats_file_too(self):
        self.make()
        original = self.runner._simulate

        def no_convert_output(step, cmd):
            if step == 'convert':
                return 'nothing written'
            return original(step, cmd)

        self.runner._simulate = no_convert_output  # type: ignore[method-assign]
        with self.assertRaisesRegex(StepFailed, 'left no vocals_rvc.wav'):
            self.prepare()

        self.make()

        def bad_stats(step, cmd):
            out = original(step, cmd)
            if step == 'analyze':
                with open(self.runner.arg(cmd, '--out'), 'w') as handle:
                    handle.write('{not json')
            return out

        self.runner._simulate = bad_stats  # type: ignore[method-assign]
        with self.assertRaisesRegex(StepFailed, 'readable f0_src.json'):
            self.prepare()

    def test_a_gpu_lock_that_stays_taken_ends_in_a_retryable_failure_and_nothing_runs(self):
        self.make()
        self.cfg = dataclasses.replace(
            self.cfg, settings=dataclasses.replace(self.cfg.settings, timeouts=dataclasses.replace(self.cfg.settings.timeouts, gpu_lock_wait_sec=0.4))
        )
        self.pipeline.cfg = self.cfg
        self.pipeline.fetch(self.source.songs[0], None, Cancel())
        other = FileLock(self.lock.path)
        with other.hold(1):
            t0 = time.monotonic()
            with self.assertRaises(GpuBusy) as caught:
                self.pipeline.process('42', Cancel())
            self.assertLess(time.monotonic() - t0, 3)
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(self.runner.calls, [])

    # ─── (c) a removed song is not prepared any further ───

    def test_a_job_cancelled_before_it_starts_runs_no_tool(self):
        self.make()
        cancel = Cancel()
        self.pipeline.fetch(self.source.songs[0], None, cancel)
        cancel.set('removed')
        with self.assertRaises(Abandoned):
            self.pipeline.process('42', cancel)
        self.assertEqual(self.runner.calls, [])
        with self.lock.hold(1):
            pass

    def test_a_job_is_looked_at_before_every_step(self):
        """Cancelled while one step runs: that tool is killed and no later step starts."""
        for stop_during in ('separate', 'analyze', 'convert', 'mix'):
            with self.subTest(stop_during):
                self.make()
                cancel = Cancel()
                self.runner.block[stop_during] = threading.Event()
                self.pipeline.fetch(self.source.songs[0], None, cancel)
                failure: list[BaseException] = []

                def work():
                    try:
                        self.pipeline.process('42', cancel)
                    except BaseException as error:  # noqa: BLE001
                        failure.append(error)

                thread = threading.Thread(target=work)
                thread.start()
                self.assertTrue(self.runner.started_event(stop_during).wait(10))
                cancel.set('removed')
                thread.join(10)
                self.assertIsInstance(failure[0], Abandoned)
                self.assertEqual(self.runner.killed, [stop_during])
                order = ['separate', 'analyze', 'convert', 'mix']
                self.assertEqual(self.runner.steps(), order[: order.index(stop_during) + 1])
                self.assertNotEqual(self.meta()['status'], 'ready')
                with self.lock.hold(1):  # and the GPU lock was released
                    pass


if __name__ == '__main__':
    unittest.main()
