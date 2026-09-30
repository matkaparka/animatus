"""The two song sources: a folder of audio files, and the NetEase API server (a fake one on loopback)."""

import os
import socket
import threading
import time
import unittest
from unittest import mock

from singing_service.control import Cancel, Deadline
from singing_service.errors import Abandoned, SongRejected, SourceUnavailable
from singing_service.sources.local import LocalSource, song_from_path
from singing_service.sources.netease import NetEaseSource

from .fake_ncm import FakeNcm
from .support import TempCase, write_wav


class LocalFolder(TempCase):
    def make(self) -> str:
        root = self.tmpdir()
        write_wav(os.path.join(root, '周杰伦 - 晴天.wav'), seconds=0.5)
        write_wav(os.path.join(root, 'Solo Piece.wav'))
        write_wav(os.path.join(root, 'sub', 'Band A & Band B - Duet.wav'))
        open(os.path.join(root, 'notes.txt'), 'w').close()
        open(os.path.join(root, '.hidden.wav'), 'w').close()
        with open(os.path.join(root, '周杰伦 - 晴天.lrc'), 'w', encoding='utf-8') as handle:
            handle.write('[00:01.00]故事的小黄花')
        return root

    def source(self, root: str, **kw) -> LocalSource:
        return LocalSource(root, **kw)

    def test_names_come_from_the_file_name(self):
        root = self.tmpdir()
        song = song_from_path(root, os.path.join(root, 'Band A & Band B - Duet.mp3'))
        self.assertEqual((song['name'], song['artists']), ('Duet', ['Band A', 'Band B']))
        song = song_from_path(root, os.path.join(root, 'Only A Title.mp3'))
        self.assertEqual((song['name'], song['artists']), ('Only A Title', []))
        song = song_from_path(root, os.path.join(root, 'A feat. B, C - Song - Part 2.mp3'))
        self.assertEqual((song['name'], song['artists']), ('Song - Part 2', ['A', 'B', 'C']))

    def test_the_id_is_stable_safe_and_different_per_file(self):
        root = self.tmpdir()
        a = song_from_path(root, os.path.join(root, 'A.mp3'))['id']
        b = song_from_path(root, os.path.join(root, 'B.mp3'))['id']
        self.assertEqual(a, song_from_path(root, os.path.join(root, 'a.mp3'))['id'])  # Windows folds case
        self.assertNotEqual(a, b)
        self.assertRegex(a, r'^local_[0-9a-f]{12}$')

    def test_search_finds_files_by_title_or_artist_and_ignores_the_rest(self):
        src = self.source(self.make())
        deadline = Deadline(5)
        self.assertEqual([s['name'] for s in src.search('晴天', deadline)], ['晴天'])
        self.assertEqual([s['name'] for s in src.search('晴天 周杰伦', deadline)], ['晴天'])
        self.assertEqual([s['name'] for s in src.search('周杰伦', deadline)], ['晴天'])
        self.assertEqual([s['name'] for s in src.search('band b', deadline)], ['Duet'])
        self.assertEqual(src.search('nothing like it', deadline), [])
        names = {s['name'] for s in src.catalog()}
        self.assertEqual(names, {'晴天', 'Solo Piece', 'Duet'})  # not the .txt, not the hidden file

    def test_a_hit_carries_the_duration_the_header_gives(self):
        found = self.source(self.make()).search('晴天', Deadline(5))
        self.assertAlmostEqual(found[0]['duration'], 0.5, delta=0.05)

    def test_a_file_added_while_running_is_found_after_the_next_look(self):
        root = self.make()
        now = [0.0]
        src = self.source(root, rescan_sec=15, clock=lambda: now[0])
        self.assertEqual(src.search('new song', Deadline(5)), [])
        write_wav(os.path.join(root, 'New Song.wav'))
        self.assertEqual(src.search('new song', Deadline(5)), [])  # too soon to look again
        now[0] = 16.0
        self.assertEqual([s['name'] for s in src.search('new song', Deadline(5))], ['New Song'])

    def test_fetch_copies_the_file_and_its_lyrics(self):
        root = self.make()
        src = self.source(root)
        song = src.search('晴天', Deadline(5))[0]
        dest = self.tmpdir('song')
        src.fetch(song, dest, Cancel(), 30)
        self.assertEqual(sorted(os.listdir(dest)), ['lyric.lrc', 'orig.wav'])
        with open(os.path.join(dest, 'lyric.lrc'), encoding='utf-8') as handle:
            self.assertIn('故事的小黄花', handle.read())

    def test_a_song_without_lyrics_gets_an_empty_lyric_file(self):
        src = self.source(self.make())
        dest = self.tmpdir('song')
        src.fetch(src.search('Solo Piece', Deadline(5))[0], dest, Cancel(), 30)
        with open(os.path.join(dest, 'lyric.lrc'), encoding='utf-8') as handle:
            self.assertEqual(handle.read(), '')

    def test_a_file_that_vanished_is_a_rejection_with_its_own_code(self):
        root = self.make()
        src = self.source(root)
        song = src.search('晴天', Deadline(5))[0]
        os.remove(song['path'])
        with self.assertRaises(SongRejected) as caught:
            src.fetch(song, self.tmpdir('song'), Cancel(), 30)
        self.assertEqual(caught.exception.code, 'local_missing')

    def test_a_cancelled_copy_leaves_nothing_behind(self):
        root = self.make()
        src = self.source(root)
        song = src.search('晴天', Deadline(5))[0]
        dest = self.tmpdir('song')
        cancel = Cancel()
        cancel.set('removed')
        with self.assertRaises(Abandoned):
            src.fetch(song, dest, cancel, 30)
        self.assertEqual([n for n in os.listdir(dest) if n.startswith('orig')], [])

    def test_it_never_asks_for_a_network_and_has_nothing_to_resume(self):
        src = self.source(self.make())
        self.assertIsNone(src.precheck({'id': 'x', 'name': 'x', 'artists': []}))
        self.assertEqual(src.status()['kind'], 'local')
        src.resume()


class NetEase(TempCase):
    def setUp(self):
        self.api = FakeNcm()
        self.addCleanup(self.api.close)
        self.state = self.tmpdir()

    def source(self, **kw) -> NetEaseSource:
        kw.setdefault('min_interval', 0.0)
        kw.setdefault('timeout', 5.0)
        return NetEaseSource(kw.pop('base_url', self.api.base_url), kw.pop('cookie', ''), self.state, **kw)

    def deadline(self) -> Deadline:
        return Deadline(10)

    # ─── search, precheck, url ───

    def test_search_parses_the_songs_and_sends_the_documented_query(self):
        songs = self.source(search_limit=7).search('first song', self.deadline())
        self.assertEqual(songs[0], {'id': '111', 'name': 'First Song', 'artists': ['Artist A'], 'album': 'Album', 'duration': 215.0, 'fee': 0})
        query = self.api.requests[0]['query']
        self.assertEqual((query['keywords'], query['type'], query['limit']), ('first song', '1', '7'))

    def test_the_cookie_goes_in_the_header_only_when_there_is_one(self):
        self.source().search('x', self.deadline())
        self.assertIsNone(self.api.requests[-1]['cookie'])
        self.source(cookie='  a-session-cookie  ').search('x', self.deadline())
        self.assertEqual(self.api.requests[-1]['cookie'], 'a-session-cookie')

    def test_without_a_membership_the_search_result_alone_rejects_paid_songs(self):
        src = self.source()
        self.assertEqual(src.precheck({'id': '1', 'name': '', 'artists': [], 'fee': 1})[0], 'vip_only')  # type: ignore[index]
        self.assertEqual(src.precheck({'id': '1', 'name': '', 'artists': [], 'fee': 4})[0], 'paid_album')  # type: ignore[index]
        for fee in (0, 8, None):
            self.assertIsNone(src.precheck({'id': '1', 'name': '', 'artists': [], 'fee': fee}))
        with_cookie = self.source(cookie='c')
        self.assertIsNone(with_cookie.precheck({'id': '1', 'name': '', 'artists': [], 'fee': 1}))

    def test_a_song_with_no_url_or_only_a_trial_is_a_rejection_with_the_right_code(self):
        cases = [
            ({'code': 200, 'data': [{'url': None}]}, 'no_audio'),
            ({'code': 200, 'data': [{'url': None, 'fee': 4}]}, 'paid_album'),
            ({'code': 200, 'data': [{'url': 'http://x/y.mp3', 'freeTrialInfo': {'start': 0}}]}, 'vip_only'),
            ({'code': 200, 'data': []}, 'no_audio'),
        ]
        for body, code in cases:
            self.api.routes['/song/url/v1'] = lambda req, b=body: (200, b, {})
            with self.assertRaises(SongRejected, msg=code) as caught:
                self.source().audio_url('111', self.deadline(), None)
            self.assertEqual(caught.exception.code, code)
            self.assertFalse(caught.exception.retryable)

    def test_the_extension_from_the_server_is_sanitised(self):
        self.api.routes['/song/url/v1'] = lambda req: (200, {'code': 200, 'data': [{'url': 'http://x/a', 'type': '../evil'}]}, {})
        self.assertEqual(self.source().audio_url('1', self.deadline(), None)[1], 'mp3')

    # ─── (a) a failure of the source is never a rejection of the song ───

    def test_a_server_that_is_not_there_is_unavailable_and_may_be_retried(self):
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        src = self.source(base_url=f'http://127.0.0.1:{port}')
        with self.assertRaises(SourceUnavailable) as caught:
            src.search('x', self.deadline())
        self.assertEqual(caught.exception.code, 'source_down')
        self.assertTrue(caught.exception.auto_retry)
        self.assertTrue(caught.exception.retryable)
        self.assertNotIsInstance(caught.exception, SongRejected)

    def test_a_server_error_is_unavailable_not_a_rejection(self):
        self.api.routes['/song/url/v1'] = lambda req: (500, {'code': 500, 'message': 'boom'}, {})
        with self.assertRaises(SourceUnavailable) as caught:
            self.source().audio_url('111', self.deadline(), None)
        self.assertEqual(caught.exception.code, 'source_error')
        self.assertTrue(caught.exception.auto_retry)

    def test_an_answer_that_is_not_json_is_unavailable(self):
        self.api.routes['/cloudsearch'] = lambda req: (200, b'<html>not the api</html>', {})
        with self.assertRaises(SourceUnavailable) as caught:
            self.source().search('x', self.deadline())
        self.assertEqual(caught.exception.code, 'source_error')

    def test_a_slow_server_times_out_as_unavailable(self):
        self.api.delay = 1.0
        with self.assertRaises(SourceUnavailable) as caught:
            self.source(timeout=0.3).search('x', self.deadline())
        self.assertEqual(caught.exception.code, 'source_down')

    def test_no_proxy_of_the_environment_is_used(self):
        dead_proxy = 'http://127.0.0.1:9'
        env = {'HTTP_PROXY': dead_proxy, 'http_proxy': dead_proxy, 'HTTPS_PROXY': dead_proxy, 'ALL_PROXY': dead_proxy}
        with mock.patch.dict(os.environ, env):
            songs = self.source().search('x', self.deadline())
        self.assertEqual(songs[0]['id'], '111')

    def test_the_cookie_is_not_in_any_error_message(self):
        secret = 'made-up-' + 'session-' + 'value-1234'  # assembled: the repository never holds a full secret-looking string
        self.api.routes['/cloudsearch'] = lambda req: (500, {'code': 500, 'message': 'boom'}, {})
        with self.assertRaises(SourceUnavailable) as caught:
            self.source(cookie=secret).search('x', self.deadline())
        self.assertNotIn(secret, caught.exception.reason)
        self.assertNotIn(secret, str(caught.exception))

    # ─── the breaker ───

    def test_a_risk_control_answer_trips_the_breaker_and_no_further_request_is_made(self):
        self.api.routes['/cloudsearch'] = lambda req: (200, {'code': -460, 'message': 'cheating'}, {})
        src = self.source()
        with self.assertRaises(SourceUnavailable) as caught:
            src.search('x', self.deadline())
        self.assertEqual(caught.exception.code, 'source_halted')
        self.assertFalse(caught.exception.auto_retry)
        made = len(self.api.requests)
        with self.assertRaises(SourceUnavailable):
            src.search('y', self.deadline())
        with self.assertRaises(SourceUnavailable):
            src.audio_url('111', self.deadline(), None)
        self.assertEqual(len(self.api.requests), made)  # nothing more reached the server
        self.assertIn('-460', src.status()['halted']['reason'])

    def test_the_breaker_survives_a_restart_and_only_a_person_lifts_it(self):
        self.api.routes['/cloudsearch'] = lambda req: (200, {'code': 301, 'message': 'need login'}, {})
        with self.assertRaises(SourceUnavailable):
            self.source().search('x', self.deadline())
        self.api.routes['/cloudsearch'] = self.api._search
        again = self.source()  # a new process, as after a restart
        with self.assertRaises(SourceUnavailable) as caught:
            again.search('x', self.deadline())
        self.assertEqual(caught.exception.code, 'source_halted')
        again.resume()
        self.assertIsNone(again.status()['halted'])
        self.assertEqual(again.search('x', self.deadline())[0]['id'], '111')

    def test_risk_words_in_the_message_trip_it_too(self):
        self.api.routes['/cloudsearch'] = lambda req: (200, {'code': 200, 'message': '操作频繁，请稍后再试'}, {})
        with self.assertRaises(SourceUnavailable) as caught:
            self.source().search('x', self.deadline())
        self.assertEqual(caught.exception.code, 'source_halted')

    # ─── the download ───

    def test_a_download_writes_the_file_and_counts_toward_the_cap(self):
        src = self.source(max_new_downloads=1)
        dest = os.path.join(self.tmpdir(), 'orig.mp3')
        src.download(f'{self.api.base_url}/cdn/a.mp3', dest, Cancel(), 10)
        with open(dest, 'rb') as handle:
            self.assertEqual(handle.read(), self.api.cdn_bytes)
        self.assertEqual(src.new_downloads, 1)
        made = len(self.api.requests)
        with self.assertRaises(SourceUnavailable) as caught:
            src.download(f'{self.api.base_url}/cdn/a.mp3', dest + '2', Cancel(), 10)
        self.assertEqual(caught.exception.code, 'download_cap')
        self.assertFalse(caught.exception.auto_retry)
        self.assertEqual(len(self.api.requests), made)

    def test_a_file_that_ends_early_is_unavailable_and_leaves_no_part_file(self):
        self.api.routes['/cdn/a.mp3'] = lambda req: (200, b'short', {'Content-Length': '9999'})
        folder = self.tmpdir()
        with self.assertRaises(SourceUnavailable) as caught:
            self.source().download(f'{self.api.base_url}/cdn/a.mp3', os.path.join(folder, 'orig.mp3'), Cancel(), 10)
        self.assertTrue(caught.exception.auto_retry)
        self.assertEqual(os.listdir(folder), [])

    def test_a_cdn_that_no_longer_has_the_file_is_a_rejection_but_a_broken_cdn_is_not(self):
        folder = self.tmpdir()
        self.api.routes['/cdn/a.mp3'] = lambda req: (404, b'gone', {})
        with self.assertRaises(SongRejected) as caught:
            self.source().download(f'{self.api.base_url}/cdn/a.mp3', os.path.join(folder, 'o.mp3'), Cancel(), 10)
        self.assertEqual(caught.exception.code, 'no_audio')
        self.api.routes['/cdn/a.mp3'] = lambda req: (503, b'busy', {})
        with self.assertRaises(SourceUnavailable) as broken:
            self.source().download(f'{self.api.base_url}/cdn/a.mp3', os.path.join(folder, 'o.mp3'), Cancel(), 10)
        self.assertTrue(broken.exception.auto_retry)
        self.assertEqual(os.listdir(folder), [])

    def test_a_cancelled_download_stops_and_leaves_no_part_file(self):
        big = b'x' * (8 << 20)
        self.api.routes['/cdn/a.mp3'] = lambda req: (200, big, {})
        cancel = Cancel()
        folder = self.tmpdir()
        threading.Timer(0.0, cancel.set, args=('removed',)).start()
        time.sleep(0.05)
        with self.assertRaises(Abandoned):
            self.source().download(f'{self.api.base_url}/cdn/a.mp3', os.path.join(folder, 'o.mp3'), cancel, 30)
        self.assertEqual(os.listdir(folder), [])

    def test_fetch_gets_the_original_and_the_lyrics(self):
        dest = self.tmpdir('song')
        self.source().fetch({'id': '111', 'name': 'x', 'artists': []}, dest, Cancel(), 30)
        self.assertEqual(sorted(os.listdir(dest)), ['lyric.lrc', 'orig.mp3'])
        with open(os.path.join(dest, 'lyric.lrc'), encoding='utf-8') as handle:
            self.assertIn('hello', handle.read())

    def test_lyrics_that_cannot_be_fetched_do_not_fail_the_song(self):
        self.api.routes['/lyric'] = lambda req: (500, {'code': 500}, {})
        dest = self.tmpdir('song')
        self.source().fetch({'id': '111', 'name': 'x', 'artists': []}, dest, Cancel(), 30)
        with open(os.path.join(dest, 'lyric.lrc'), encoding='utf-8') as handle:
            self.assertEqual(handle.read(), '')
        self.assertTrue(os.path.exists(os.path.join(dest, 'orig.mp3')))

    # ─── the queue in front of the account ───

    def test_requests_are_spaced_by_the_minimum_interval_even_from_two_sources(self):
        first, second = self.source(min_interval=0.4), self.source(min_interval=0.4)  # two processes' worth
        threads = [threading.Thread(target=lambda s=s: s.search('x', self.deadline())) for s in (first, second, first)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        times = sorted(r['at'] for r in self.api.requests)
        self.assertEqual(len(times), 3)
        for a, b in zip(times, times[1:]):
            self.assertGreaterEqual(b - a, 0.35)

    def test_a_request_that_would_wait_longer_than_its_time_allows_gives_up_at_once(self):
        src = self.source(min_interval=5.0)
        src.search('x', self.deadline())
        t0 = time.monotonic()
        with self.assertRaises(SourceUnavailable) as caught:
            src.search('y', Deadline(0.5))
        self.assertLess(time.monotonic() - t0, 2)
        self.assertEqual(caught.exception.code, 'source_busy')
        self.assertTrue(caught.exception.auto_retry)

    def test_details_and_playlists_for_prefetch(self):
        src = self.source()
        self.assertEqual(src.details(['55'], self.deadline())[0]['name'], 'Song 55')
        with self.assertRaises(SongRejected) as caught:
            src.details(['999'], self.deadline())
        self.assertEqual(caught.exception.code, 'not_found')
        self.assertEqual([s['id'] for s in src.playlist('7', self.deadline())], ['111'])


if __name__ == '__main__':
    unittest.main()
