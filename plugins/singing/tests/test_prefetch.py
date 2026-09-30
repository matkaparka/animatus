"""The prefetch command: preparing songs ahead of the show, into the library the service uses."""

import contextlib
import dataclasses
import io
import os
import unittest

from singing_service import library
from singing_service.control import Cancel
from singing_service.errors import SongRejected, SourceUnavailable
from singing_service.locks import FileLock
from singing_service.pipeline import Pipeline
from singing_service.prefetch import main, prefetch, stale_songs

from .fakes import FakeRunner, FakeSource, make_config, song
from .support import TempCase


class PrefetchCase(TempCase):
    def make(self, songs, **settings):
        self.root = self.tmpdir()
        self.cfg = make_config(self.root, **settings)
        self.source = FakeSource(songs)
        self.runner = FakeRunner()
        lock = FileLock(os.path.join(self.cfg.state_dir, 'locks', 'gpu.lock'))
        self.pipeline = Pipeline(self.cfg, self.source, self.runner, lock, python='py')

    def run_prefetch(self, songs=None, **kw):
        return prefetch(self.cfg, self.source, self.pipeline, self.source.songs if songs is None else songs, **kw)


class Prefetch(PrefetchCase):
    def test_every_song_is_prepared_and_ready(self):
        self.make([song('1', 'Alpha'), song('2', 'Beta')])
        report = self.run_prefetch()
        self.assertEqual(report.prepared, ['Alpha - Artist', 'Beta - Artist'])
        self.assertEqual((report.skipped, report.failed, report.stopped), ([], [], ''))
        for sid in ('1', '2'):
            self.assertTrue(library.is_current(library.read_meta(self.cfg.songs_dir, sid), self.cfg.settings.rvc))

    def test_songs_that_are_already_ready_are_skipped_and_nothing_is_done_for_them(self):
        self.make([song('1', 'Alpha'), song('2', 'Beta')])
        self.run_prefetch()
        self.runner.calls.clear()
        report = self.run_prefetch()
        self.assertEqual((report.prepared, len(report.skipped)), ([], 2))
        self.assertEqual(self.runner.calls, [])

    def test_a_dry_run_only_lists(self):
        self.make([song('1', 'Alpha')])
        report = self.run_prefetch(dry_run=True)
        self.assertEqual((report.prepared, report.failed), ([], []))
        self.assertEqual((self.source.fetch_calls, self.runner.calls), ([], []))

    def test_max_limits_the_new_downloads_of_one_run(self):
        self.make([song(str(i), f'Song{i}') for i in range(1, 5)])
        report = self.run_prefetch(max_new=2)
        self.assertEqual(len(report.prepared), 2)
        self.assertIn('--max 2', report.stopped)
        # a song whose original is already in the library costs no download, so it is not held back by the limit
        report = self.run_prefetch(max_new=2)
        self.assertEqual(len(report.prepared), 2)

    def test_a_song_that_cannot_be_sung_is_skipped_with_its_reason_and_the_run_goes_on(self):
        self.make([song('1', 'Paid'), song('2', 'Fine')])
        self.source.precheck_codes['1'] = ('vip_only', 'fee=1')
        report = self.run_prefetch()
        self.assertEqual(report.prepared, ['Fine - Artist'])
        self.assertEqual([t for t, _ in report.failed], ['Paid - Artist'])
        self.assertEqual(report.stopped, '')

    def test_a_tripped_breaker_or_a_spent_cap_stops_the_run(self):
        for code in ('source_halted', 'download_cap'):
            with self.subTest(code):
                self.make([song('1', 'Alpha'), song('2', 'Beta')])
                self.source.fetch_errors.append(SourceUnavailable('stopped', code=code))
                report = self.run_prefetch()
                self.assertEqual(report.prepared, [])
                self.assertTrue(report.stopped.startswith(code))
                self.assertEqual(self.source.fetch_calls, ['1'])  # Beta was not even tried

    def test_a_blip_skips_that_song_and_the_run_goes_on(self):
        self.make([song('1', 'Alpha'), song('2', 'Beta')])
        self.source.fetch_errors.append(SourceUnavailable('a blip', code='source_down', auto_retry=True))
        report = self.run_prefetch()
        self.assertEqual(report.prepared, ['Beta - Artist'])
        self.assertEqual(report.stopped, '')

    def test_a_bug_in_one_song_does_not_end_the_night(self):
        self.make([song('1', 'Alpha'), song('2', 'Beta')])
        self.runner.errors['separate'] = RuntimeError('boom')
        original = self.runner.run
        calls = {'n': 0}

        def once(cmd, **kw):
            calls['n'] += 1
            if calls['n'] > 1:
                self.runner.errors.clear()
            return original(cmd, **kw)

        self.runner.run = once  # type: ignore[method-assign]
        report = self.run_prefetch()
        self.assertEqual(report.prepared, ['Beta - Artist'])
        self.assertIn('boom', report.failed[0][1])

    def test_a_rejected_song_is_reported_not_raised(self):
        self.make([song('1', 'Alpha')])
        self.source.fetch_errors.append(SongRejected('no url', code='no_audio'))
        report = self.run_prefetch()
        self.assertEqual((report.prepared, len(report.failed)), ([], 1))


class Refresh(PrefetchCase):
    def test_only_songs_made_with_older_voice_settings_are_found_and_they_only_convert_and_mix_again(self):
        self.make([song('1', 'Alpha'), song('2', 'Beta')])
        self.run_prefetch()
        self.assertEqual(stale_songs(self.cfg), [])
        newer = dataclasses.replace(self.cfg.settings.rvc, protect=0.1)
        self.cfg = dataclasses.replace(self.cfg, settings=dataclasses.replace(self.cfg.settings, rvc=newer))
        self.pipeline.cfg = self.cfg
        stale = stale_songs(self.cfg)
        self.assertEqual({s['id'] for s in stale}, {'1', '2'})
        self.runner.calls.clear()
        self.source.fetch_calls.clear()
        report = self.run_prefetch(songs=stale)
        self.assertEqual(len(report.prepared), 2)
        self.assertEqual(sorted(set(self.runner.steps())), ['convert', 'mix'])
        self.assertEqual(self.source.fetch_calls, [])  # no network
        self.assertEqual(stale_songs(self.cfg), [])

    def test_folders_that_are_not_songs_and_songs_not_ready_are_not_stale(self):
        self.make([song('1', 'Alpha')])
        os.makedirs(os.path.join(self.cfg.songs_dir, 'not a song'))
        self.pipeline.fetch(self.source.songs[0], None, Cancel())
        self.assertEqual(stale_songs(self.cfg), [])  # downloaded, never prepared


class CommandLine(PrefetchCase):
    def run_main(self, *argv):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = main(list(argv))
        return code, err.getvalue()

    def test_a_settings_file_that_is_not_valid_is_exit_2_with_the_reason(self):
        root = self.tmpdir()
        bad = os.path.join(root, 'singing.yaml')
        with open(bad, 'w', encoding='utf-8') as handle:
            handle.write('queue:\n  max_len: 0\n')
        code, err = self.run_main('--songs-dir', os.path.join(root, 's'), '--state-dir', os.path.join(root, 'st'), '--settings', bad, '--all')
        self.assertEqual(code, 2)
        self.assertIn('queue.max_len', err)

    def test_a_setup_that_is_not_complete_says_what_is_missing_and_exits(self):
        root = self.tmpdir()
        code, err = self.run_main('--songs-dir', os.path.join(root, 's'), '--state-dir', os.path.join(root, 'st'), '--all')
        self.assertEqual(code, 2)
        self.assertIn('setup problem', err)
        self.assertIn('rvc.model_pth', err)

    def test_one_mode_is_required(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            main(['--songs-dir', 'a', '--state-dir', 'b'])


if __name__ == '__main__':
    unittest.main()
