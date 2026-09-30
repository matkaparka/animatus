"""The queue: requests, limits, the worker, claiming and finishing a song, and what survives a restart.

Each of the legacy service's defects (brief section 9) has a test here that fails on the old behaviour:
  (a) a failure of the source marked the song as rejected for ever,
  (b) nothing bounded a step, so a hung tool held the worker and the GPU lock,
  (c) removing an entry did not stop it being prepared,
  (d) the limits were checked, the search ran, and the entry was inserted without checking again,
  (e) a caller that gave up (its timeout) still got its song queued.
The tools and the source are simulated (fakes.py); the worker is driven by `process_next` unless a test needs the thread.
"""

import json
import os
import threading
import time
import unittest

from singing_service import library
from singing_service.errors import GpuBusy, NotConfigured, SongRejected, SourceUnavailable, StepFailed, StepTimeout
from singing_service.locks import FileLock
from singing_service.pipeline import Pipeline
from singing_service.service import SingingService

from .fakes import FakeClock, FakeRunner, FakeSource, make_config, song
from .support import TempCase, wait_until


class ServiceCase(TempCase):
    def make(self, songs=None, autostart=False, root=None, **settings) -> SingingService:
        self.root = root or self.tmpdir()
        self.clock = FakeClock()
        self.cfg = make_config(self.root, **settings)
        self.source = FakeSource(
            songs
            if songs is not None
            else [song('1', 'Alpha'), song('2', 'Beta'), song('3', 'Gamma')]
        )
        self.runner = FakeRunner()
        lock = FileLock(os.path.join(self.cfg.state_dir, 'locks', 'gpu.lock'))
        pipeline = Pipeline(self.cfg, self.source, self.runner, lock, python='py')
        service = SingingService(self.cfg, self.source, pipeline, clock=self.clock, autostart=autostart)
        self.addCleanup(service.close)
        return service

    def ask(self, svc, keyword, uid='u1', name='ann', **kw):
        return svc.request(keyword, uid, name, **kw)

    def prepare_all(self, svc):
        while svc.process_next():
            pass

    def items(self, svc):
        return svc.queue()['items']

    def ready(self, svc, keyword='Alpha', uid='u1'):
        """Requests a song and prepares it; returns the request's answer."""
        answer = self.ask(svc, keyword, uid=uid, name=uid)
        self.assertEqual(answer['status'], 'queued', answer)
        self.prepare_all(svc)
        return answer


class Requests(ServiceCase):
    def test_a_request_is_queued_with_its_song_and_position_and_saved(self):
        svc = self.make()
        answer = self.ask(svc, 'Alpha')
        self.assertEqual(answer['status'], 'queued')
        self.assertEqual(answer['qid'], 1)
        self.assertEqual(answer['position'], 1)
        self.assertFalse(answer['cached'])
        self.assertEqual(answer['song'], {'id': '1', 'title': 'Alpha', 'artists': ['Artist'], 'duration': 200.0})
        item = self.items(svc)[0]
        self.assertEqual((item['title'], item['state'], item['requester_name']), ('Alpha', 'queued', 'ann'))
        with open(os.path.join(self.cfg.state_dir, 'queue.json'), encoding='utf-8') as handle:
            self.assertEqual(json.load(handle)['items'][0]['song_id'], '1')

    def test_the_position_counts_the_song_being_sung(self):
        svc = self.make()
        self.ready(svc, 'Alpha', 'u1')
        svc.claim('c')
        self.assertEqual(self.ask(svc, 'Beta', 'u2')['position'], 1 + 1)
        self.assertEqual(self.ask(svc, 'Gamma', 'u3')['position'], 2 + 1)

    def test_nothing_found_is_a_rejection_that_names_the_keyword(self):
        svc = self.make()
        answer = self.ask(svc, 'Omega')
        self.assertEqual((answer['status'], answer['code']), ('rejected', 'not_found'))
        self.assertIn('Omega', answer['reason'])
        self.assertEqual(self.items(svc), [])

    def test_an_empty_keyword_is_refused_without_a_search(self):
        svc = self.make()
        self.assertEqual(self.ask(svc, '   ')['code'], 'empty_keyword')
        self.assertEqual(self.source.search_calls, [])

    def test_blacklists_by_keyword_before_the_search_and_by_song_or_artist_after_it(self):
        svc = self.make(
            songs=[song('1', 'Alpha', ('Bad Band',)), song('2', 'Beta'), song('3', 'Gamma')],
            queue={'blacklist_keywords': ['forbidden', 'bad band'], 'blacklist_ids': [3]},
        )
        self.assertEqual(self.ask(svc, 'a Forbidden word')['code'], 'blacklisted')
        self.assertEqual(self.source.search_calls, [])  # the keyword alone was enough
        self.assertEqual(self.ask(svc, 'Alpha')['code'], 'blacklisted')  # by the artist of the song found
        self.assertEqual(self.ask(svc, 'Gamma', 'u3')['code'], 'blacklisted')  # by the id
        self.assertEqual(self.ask(svc, 'Beta', 'u2')['status'], 'queued')

    def test_a_viewer_has_one_song_waiting_at_a_time_but_others_are_not_held_back(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        second = self.ask(svc, 'Beta')
        self.assertEqual((second['status'], second['code']), ('rejected', 'per_user_limit'))
        self.assertIn('Alpha', second['reason'])
        self.assertEqual(self.ask(svc, 'Beta', 'u2')['status'], 'queued')
        self.assertEqual(self.source.search_calls.count('Beta'), 1)  # the first refusal came before the search

    def test_a_failed_entry_or_the_song_being_sung_does_not_count_against_the_viewer(self):
        svc = self.make()
        self.ready(svc, 'Alpha')
        svc.claim('c')  # u1's song is being sung now
        self.assertEqual(self.ask(svc, 'Beta')['status'], 'queued')
        self.source.fetch_errors.append(SongRejected('nope', code='no_audio'))
        self.prepare_all(svc)  # Beta fails
        self.assertEqual(svc.queue()['failed'][0]['title'], 'Beta')
        self.assertEqual(self.ask(svc, 'Gamma')['status'], 'queued')

    def test_a_full_queue_says_so(self):
        svc = self.make(queue={'max_len': 2})
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        answer = self.ask(svc, 'Gamma', 'u3')
        self.assertEqual((answer['status'], answer['code']), ('rejected', 'queue_full'))
        self.assertIn('2', answer['reason'])

    def test_a_song_already_waiting_or_being_sung_or_sung_a_moment_ago_is_refused(self):
        svc = self.make()
        self.ask(svc, 'Alpha', 'u1')
        self.assertEqual(self.ask(svc, 'Alpha', 'u2')['code'], 'already_queued')
        self.prepare_all(svc)
        svc.claim('c')
        self.assertEqual(self.ask(svc, 'Alpha', 'u3')['code'], 'playing_now')
        svc.done(1, 'done')
        cooldown = self.ask(svc, 'Alpha', 'u3')
        self.assertEqual(cooldown['code'], 'cooldown')
        self.assertIn('30', cooldown['reason'])
        self.clock.advance(30 * 60 + 1)
        self.assertEqual(self.ask(svc, 'Alpha', 'u3')['status'], 'queued')

    def test_a_song_that_is_too_long_is_refused(self):
        svc = self.make(songs=[song('1', 'Long', duration=400.0)])
        answer = self.ask(svc, 'Long')
        self.assertEqual(answer['code'], 'too_long')
        self.assertIn('6分40秒', answer['reason'])
        self.assertIn('6分00秒', answer['reason'])

    def test_a_paid_song_is_refused_unless_it_was_prepared_before(self):
        svc = self.make()
        self.source.precheck_codes['1'] = ('vip_only', 'fee=1')
        answer = self.ask(svc, 'Alpha')
        self.assertEqual((answer['status'], answer['code']), ('rejected', 'vip_only'))
        self.assertEqual(self.items(svc), [])
        # prepared while the account could get it: still singable
        self.source.precheck_codes.clear()
        self.ready(svc, 'Alpha', 'u2')
        self.source.precheck_codes['1'] = ('vip_only', 'fee=1')
        svc.claim('c')
        svc.done(None, 'failed')  # never sounded: no cooldown
        svc.queue()
        self.assertEqual(self.ask(svc, 'Alpha', 'u3')['status'], 'queued')

    def test_a_song_a_check_refused_stays_refused_unless_the_check_would_pass_today(self):
        svc = self.make(qc={'min_vocal_ratio': 0.05})
        self.runner.vocal_ratio = 0.02
        self.ask(svc, 'Alpha')
        self.prepare_all(svc)  # refused as instrumental after the separation
        self.assertEqual(svc.queue()['failed'][0]['code'], 'instrumental')
        again = self.ask(svc, 'Alpha', 'u2')
        self.assertEqual((again['status'], again['code']), ('rejected', 'instrumental'))
        # the operator lowers the bar and starts again: no second separation is needed to judge it
        svc = self.make(root=self.root, qc={'min_vocal_ratio': 0.01})
        self.assertEqual(self.ask(svc, 'Alpha', 'u2')['status'], 'queued')

    def test_a_refusal_of_an_old_service_without_a_code_is_repeated_in_its_own_words(self):
        svc = self.make()
        d = library.song_dir(self.cfg.songs_dir, '1')
        os.makedirs(d)
        with open(os.path.join(d, 'meta.json'), 'w', encoding='utf-8') as handle:
            json.dump({'id': '1', 'name': 'Alpha', 'status': 'rejected', 'reject_reason': '版权原因唱不了'}, handle, ensure_ascii=False)
        answer = self.ask(svc, 'Alpha')
        self.assertEqual((answer['code'], answer['reason']), ('rejected_before', '这首歌唱不了：版权原因唱不了'))

    def test_a_source_that_cannot_answer_queues_nothing_and_the_id_can_be_tried_again(self):
        svc = self.make()
        self.source.search_error = SourceUnavailable('down', code='source_down', auto_retry=True)
        with self.assertRaises(SourceUnavailable):
            self.ask(svc, 'Alpha', request_id='r1')
        self.assertEqual(self.items(svc), [])
        self.source.search_error = None
        answer = self.ask(svc, 'Alpha', request_id='r1')  # a failure decided nothing: the id starts over
        self.assertEqual((answer['status'], answer.get('duplicate')), ('queued', None))

    def test_the_operator_can_replace_the_words_of_a_reason(self):
        svc = self.make(queue={'max_len': 1}, messages={'queue_full': '满了（{max}）'})
        self.ask(svc, 'Alpha', 'u1')
        self.assertEqual(self.ask(svc, 'Beta', 'u2')['reason'], '满了（1）')


class AtomicLimits(ServiceCase):
    """(d) The legacy service checked the limits, released the lock for the search, and inserted without looking again."""

    def race(self, svc, calls):
        barrier = threading.Barrier(len(calls))
        self.source.search_hook = lambda keyword: barrier.wait(10)  # all are past the early check before any inserts
        results: list[dict] = []
        threads = [threading.Thread(target=lambda c=c: results.append(svc.request(*c))) for c in calls]
        for t in threads:
            t.start()
        for t in threads:
            t.join(20)
        return results

    def test_two_requests_of_one_viewer_cannot_both_get_in(self):
        svc = self.make()
        results = self.race(svc, [('Alpha', 'u1', 'ann'), ('Beta', 'u1', 'ann')])
        self.assertEqual(sorted(r['status'] for r in results), ['queued', 'rejected'])
        self.assertEqual(next(r for r in results if r['status'] == 'rejected')['code'], 'per_user_limit')
        self.assertEqual(len(self.items(svc)), 1)

    def test_the_last_place_goes_to_one_of_two_viewers(self):
        svc = self.make(queue={'max_len': 1})
        results = self.race(svc, [('Alpha', 'u1', 'ann'), ('Beta', 'u2', 'bob')])
        self.assertEqual(sorted(r['status'] for r in results), ['queued', 'rejected'])
        self.assertEqual(next(r for r in results if r['status'] == 'rejected')['code'], 'queue_full')
        self.assertEqual(len(self.items(svc)), 1)

    def test_many_at_once_never_pass_the_limits(self):
        svc = self.make(songs=[song(str(i), f'Song{i}') for i in range(12)], queue={'max_len': 5})
        calls = [(f'Song{i}', f'u{i % 4}', f'name{i % 4}') for i in range(12)]  # four viewers, three tries each
        self.race(svc, calls)
        waiting = self.items(svc)
        self.assertLessEqual(len(waiting), 4)  # one per viewer
        self.assertEqual(len({it['requester_uid'] for it in waiting}), len(waiting))


class RequestIds(ServiceCase):
    """(e) A request whose caller gave up must not be queued afterwards, and asking twice is not asking twice."""

    def test_the_same_id_again_is_the_same_entry(self):
        svc = self.make()
        first = self.ask(svc, 'Alpha', request_id='r1')
        second = self.ask(svc, 'Alpha', request_id='r1')
        self.assertEqual(second['qid'], first['qid'])
        self.assertTrue(second['duplicate'])
        self.assertEqual(len(self.items(svc)), 1)
        self.assertEqual(self.source.search_calls, ['Alpha'])  # and it did not search again

    def test_a_rejection_is_repeated_too(self):
        svc = self.make()
        first = self.ask(svc, 'Omega', request_id='r1')
        again = self.ask(svc, 'Omega', request_id='r1')
        self.assertEqual((again['code'], again['duplicate']), (first['code'], True))

    def test_the_same_id_while_the_first_call_is_still_searching_waits_for_it(self):
        svc = self.make()
        entered, gate = threading.Event(), threading.Event()
        self.source.search_hook = lambda kw: (entered.set(), gate.wait(10))
        results: dict[str, dict] = {}
        a = threading.Thread(target=lambda: results.update(a=self.ask(svc, 'Alpha', request_id='r1')))
        a.start()
        self.assertTrue(entered.wait(10))
        b = threading.Thread(target=lambda: results.update(b=self.ask(svc, 'Alpha', request_id='r1')))
        b.start()
        time.sleep(0.2)
        gate.set()
        a.join(10)
        b.join(10)
        self.assertEqual(results['a']['qid'], results['b']['qid'])
        self.assertEqual((results['a'].get('duplicate'), results['b']['duplicate']), (None, True))
        self.assertEqual(self.source.search_calls, ['Alpha'])
        self.assertEqual(len(self.items(svc)), 1)

    def test_a_request_the_caller_gave_up_on_while_it_searched_is_never_queued(self):
        svc = self.make()
        entered, gate = threading.Event(), threading.Event()
        self.source.search_hook = lambda kw: (entered.set(), gate.wait(10))
        result: dict[str, dict] = {}
        thread = threading.Thread(target=lambda: result.update(r=self.ask(svc, 'Alpha', request_id='r1')))
        thread.start()
        self.assertTrue(entered.wait(10))
        self.assertEqual(svc.abandon('r1'), {'ok': True, 'removed': False})
        gate.set()
        thread.join(10)
        self.assertEqual((result['r']['status'], result['r']['code']), ('rejected', 'abandoned'))
        self.assertEqual(self.items(svc), [])

    def test_a_request_whose_time_ran_out_is_never_queued(self):
        """The legacy bridge gave up after 30 s, and the service queued the song anyway."""
        svc = self.make()
        self.source.search_hook = lambda kw: time.sleep(0.5)
        answer = self.ask(svc, 'Alpha', wait_s=0.2)
        self.assertEqual((answer['status'], answer['code']), ('rejected', 'request_timeout'))
        self.assertEqual(self.items(svc), [])

    def test_giving_up_on_a_request_that_was_queued_takes_the_entry_off_again(self):
        svc = self.make()
        first = self.ask(svc, 'Alpha', request_id='r1')
        self.assertEqual(svc.abandon('r1'), {'ok': True, 'removed': True})
        self.assertEqual(self.items(svc), [])
        self.assertEqual(self.ask(svc, 'Alpha', request_id='r1')['code'], 'abandoned')  # the id is spent
        self.assertEqual(self.ask(svc, 'Alpha', request_id='r2')['status'], 'queued')
        self.assertEqual(first['qid'], 1)

    def test_an_abandon_that_arrives_before_its_request_refuses_the_request(self):
        svc = self.make()
        svc.abandon('r1')
        self.assertEqual(self.ask(svc, 'Alpha', request_id='r1')['code'], 'abandoned')
        self.assertEqual(self.source.search_calls, [])

    def test_a_song_already_being_sung_is_not_taken_back_by_a_late_abandon(self):
        svc = self.make()
        self.ask(svc, 'Alpha', request_id='r1')
        self.prepare_all(svc)
        svc.claim('c')
        self.assertEqual(svc.abandon('r1'), {'ok': True, 'removed': False})
        self.assertEqual(svc.queue()['current']['title'], 'Alpha')

    def test_the_requests_kept_for_repeats_do_not_grow_for_ever(self):
        svc = self.make(songs=[song('1', 'Alpha')])
        for i in range(600):
            svc.request('Omega', 'u1', 'ann', request_id=f'r{i}')
        self.assertLessEqual(len(svc._requests), 500)


class Worker(ServiceCase):
    def test_a_song_is_prepared_and_becomes_ready(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        self.assertTrue(svc.process_next())
        item = self.items(svc)[0]
        self.assertEqual((item['state'], item['transpose'], item['warnings']), ('ready', 0, []))
        self.assertFalse(svc.process_next())  # nothing else to do
        self.assertEqual(svc.queue()['worker'], {'state': 'idle'})
        self.assertEqual(self.source.fetch_calls, ['1'])

    def test_a_song_prepared_before_is_ready_at_once_and_says_so(self):
        svc = self.make()
        self.ready(svc, 'Alpha', 'u1')
        svc.claim('c')
        svc.done(None, 'done')
        self.clock.advance(3600)
        again = self.ask(svc, 'Alpha', 'u2')
        self.assertTrue(again['cached'])
        self.runner.calls.clear()
        self.source.fetch_calls.clear()
        self.prepare_all(svc)
        self.assertEqual(self.items(svc)[0]['state'], 'ready')
        self.assertEqual((self.runner.calls, self.source.fetch_calls), ([], []))

    def test_songs_are_prepared_one_at_a_time_in_the_order_asked(self):
        svc = self.make()
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        svc.process_next()
        self.assertEqual([it['state'] for it in self.items(svc)], ['ready', 'queued'])
        self.assertEqual(self.source.fetch_calls, ['1'])

    def test_the_worker_shows_what_it_is_doing(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        seen: list[dict] = []
        original = self.runner.run

        def spy(cmd, **kw):
            seen.append(svc.queue()['worker'])
            return original(cmd, **kw)

        self.runner.run = spy  # type: ignore[method-assign]
        svc.process_next()
        self.assertEqual([w['step'] for w in seen], ['separate', 'analyze', 'convert', 'mix'])
        self.assertEqual({w['title'] for w in seen}, {'Alpha'})

    # ─── (a) a failure of the source is not a rejection of the song ───

    def test_a_blip_is_tried_again_after_a_pause_and_the_song_is_not_marked(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        self.source.fetch_errors.append(SourceUnavailable('a blip', code='source_down', auto_retry=True))
        svc.process_next()
        item = self.items(svc)[0]
        self.assertEqual((item['state'], item['attempts']), ('queued', 1))
        self.assertNotEqual((library.read_meta(self.cfg.songs_dir, '1') or {}).get('status'), 'rejected')
        self.assertFalse(svc.process_next())  # not yet: the pause is 10 s
        self.clock.advance(11)
        self.assertTrue(svc.process_next())
        self.assertEqual(self.items(svc)[0]['state'], 'ready')

    def test_a_blip_that_keeps_coming_ends_as_a_retryable_failure_after_the_attempts_allowed(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        for _ in range(3):
            self.source.fetch_errors.append(SourceUnavailable('a blip', code='source_down', auto_retry=True))
        for pause in (11, 21, 0):
            svc.process_next()
            self.clock.advance(pause)
        failed = svc.queue()['failed'][0]
        self.assertEqual((failed['code'], failed['retryable']), ('source_down', True))
        self.assertEqual(failed['reason'], '连不上歌曲来源，稍后再点')
        self.assertIn('a blip', failed['error'])
        self.assertEqual(len(self.source.fetch_calls), 3)
        self.assertNotEqual((library.read_meta(self.cfg.songs_dir, '1') or {}).get('status'), 'rejected')
        self.assertEqual(self.ask(svc, 'Alpha', 'u2')['status'], 'queued')  # and the song can be asked for again

    def test_a_tripped_breaker_or_a_spent_cap_fails_the_entry_at_once_and_marks_it_retryable(self):
        for code in ('source_halted', 'download_cap'):
            with self.subTest(code):
                svc = self.make()
                self.ask(svc, 'Alpha')
                self.source.fetch_errors.append(SourceUnavailable('stopped', code=code))
                svc.process_next()
                failed = svc.queue()['failed'][0]
                self.assertEqual((failed['code'], failed['retryable']), (code, True))
                self.assertEqual(len(self.source.fetch_calls), 1)  # no second try by the worker
                self.assertNotEqual((library.read_meta(self.cfg.songs_dir, '1') or {}).get('status'), 'rejected')

    def test_what_the_source_says_it_cannot_give_fails_the_entry_for_good(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        self.source.fetch_errors.append(SongRejected('no url', code='no_audio'))
        svc.process_next()
        failed = svc.queue()['failed'][0]
        self.assertEqual((failed['code'], failed['retryable']), ('no_audio', False))
        self.assertIn('版权', failed['reason'])

    # ─── (b) a tool that hangs is stopped, and the worker goes on ───

    def test_a_step_that_timed_out_fails_that_song_and_the_next_one_is_prepared(self):
        svc = self.make()
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        self.runner.errors['convert'] = StepTimeout('the voice conversion ran longer than 900 s and was stopped')
        svc.process_next()
        failed = svc.queue()['failed'][0]
        self.assertEqual((failed['code'], failed['retryable']), ('step_timeout', True))
        self.assertIn('放弃', failed['reason'])
        del self.runner.errors['convert']
        svc.process_next()
        self.assertEqual([it['title'] for it in self.items(svc) if it['state'] == 'ready'], ['Beta'])

    def test_other_failures_of_the_setup_or_a_tool(self):
        cases = [
            (GpuBusy('the GPU lock stayed taken', code='gpu_busy'), 'gpu_busy', True),
            (NotConfigured('rvc.model_pth: no model file', detail='rvc.model_pth: no model file'), 'not_configured', False),
            (StepFailed('the vocal separation', 'the vocal separation failed (exit code 1)', 'CUDA out of memory'), 'step_failed', False),
        ]
        for error, code, retryable in cases:
            with self.subTest(code):
                svc = self.make()
                self.ask(svc, 'Alpha')
                self.runner.errors['separate'] = error
                svc.process_next()
                failed = svc.queue()['failed'][0]
                self.assertEqual((failed['code'], failed['retryable']), (code, retryable))
                self.assertNotIn('rvc.model_pth', failed['reason'])  # what the audience hears has no paths or tool output
                self.assertNotIn('CUDA', failed['reason'])
        self.assertIn('CUDA out of memory', failed['error'])  # the operator sees it

    def test_a_bug_in_the_work_fails_the_entry_and_not_the_worker(self):
        svc = self.make()
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        self.runner.errors['separate'] = RuntimeError('boom')
        svc.process_next()
        failed = svc.queue()['failed'][0]
        self.assertEqual(failed['code'], 'step_failed')
        self.assertIn('boom', failed['error'])
        del self.runner.errors['separate']
        self.assertTrue(svc.process_next())

    def test_a_song_with_no_singing_is_refused_for_good_and_says_why(self):
        svc = self.make()
        self.runner.vocal_ratio = 0.001
        self.ask(svc, 'Alpha')
        svc.process_next()
        failed = svc.queue()['failed'][0]
        self.assertEqual((failed['code'], failed['retryable']), ('instrumental', False))
        self.assertIn('纯音乐', failed['reason'])

    # ─── (c) removing an entry stops the work on it ───

    def test_removing_the_entry_being_prepared_kills_its_tool_and_no_later_step_runs(self):
        svc = self.make()
        answer = self.ask(svc, 'Alpha')
        self.runner.block['separate'] = threading.Event()
        worker = threading.Thread(target=svc.process_next)
        worker.start()
        self.assertTrue(self.runner.started_event('separate').wait(10))
        self.assertEqual(svc.remove(answer['qid'])['ok'], True)
        worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.runner.killed, ['separate'])
        self.assertEqual(self.runner.steps(), ['separate'])
        queue = svc.queue()
        self.assertEqual((queue['items'], queue['failed'], queue['worker']), ([], [], {'state': 'idle'}))

    def test_cancelling_your_own_song_while_it_is_prepared_does_the_same(self):
        svc = self.make()
        self.ask(svc, 'Alpha', 'u1')
        self.runner.block['convert'] = threading.Event()
        worker = threading.Thread(target=svc.process_next)
        worker.start()
        self.assertTrue(self.runner.started_event('convert').wait(10))
        self.assertTrue(svc.cancel(uid='u1')['ok'])
        worker.join(10)
        self.assertEqual(self.runner.killed, ['convert'])
        self.assertEqual(self.runner.steps(), ['separate', 'analyze', 'convert'])

    def test_an_entry_removed_during_the_last_step_does_not_come_back_as_ready(self):
        svc = self.make()
        answer = self.ask(svc, 'Alpha')
        self.runner.block['mix'] = threading.Event()
        worker = threading.Thread(target=svc.process_next)
        worker.start()
        self.assertTrue(self.runner.started_event('mix').wait(10))
        svc.remove(answer['qid'])
        worker.join(10)
        self.assertEqual(svc.queue()['items'], [])

    def test_the_next_song_is_prepared_after_the_removed_one(self):
        svc = self.make()
        first = self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        self.assertTrue(svc.remove(first['qid'])['ok'])
        self.prepare_all(svc)
        self.assertEqual([(it['title'], it['state']) for it in self.items(svc)], [('Beta', 'ready')])
        self.assertEqual(self.source.fetch_calls, ['2'])  # the removed song was never even fetched

    # ─── the thread ───

    def test_the_worker_thread_prepares_songs_by_itself(self):
        svc = self.make(autostart=True)
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        wait_until(lambda: [it['state'] for it in svc.queue()['items']] == ['ready', 'ready'], 10, 'both songs to be ready')

    def test_closing_the_service_kills_the_tool_it_is_running(self):
        svc = self.make(autostart=True)
        self.ask(svc, 'Alpha')
        self.runner.block['separate'] = threading.Event()
        self.assertTrue(self.runner.started_event('separate').wait(10))
        t0 = time.monotonic()
        svc.close()
        self.assertLess(time.monotonic() - t0, 10)
        self.assertEqual(self.runner.killed, ['separate'])


class Playing(ServiceCase):
    def test_claiming_gives_the_files_the_lyrics_and_marks_the_song_as_playing(self):
        svc = self.make()
        self.ready(svc, 'Alpha')
        got = svc.claim('c1')
        self.assertEqual(got['item']['title'], 'Alpha')
        self.assertEqual(got['files'], {'dir': '1', 'vocals': 'vocals_final.wav', 'inst': 'inst_final.wav'})
        self.assertEqual(got['lyrics'], [{'t': 1.0, 'text': 'first line'}, {'t': 5.5, 'text': 'second line'}])
        self.assertEqual((got['duration'], got['transpose'], got['warnings']), (200.0, 0, []))
        queue = svc.queue()
        self.assertEqual((queue['current']['state'], queue['items']), ('playing', []))
        self.assertGreater(queue['current']['started_at'], 0)

    def test_the_same_claim_again_gives_the_same_song_and_a_different_one_ends_the_first(self):
        svc = self.make()
        self.ready(svc, 'Alpha', 'u1')
        self.ready(svc, 'Beta', 'u2')
        first = svc.claim('c1')
        self.assertEqual(svc.claim('c1')['item']['qid'], first['item']['qid'])  # a retry after a lost answer
        second = svc.claim('c2')  # a new caller: whatever the old one left is over
        self.assertEqual(second['item']['title'], 'Beta')
        self.assertEqual(svc.queue()['current']['title'], 'Beta')

    def test_nothing_ready_says_what_is_pending(self):
        svc = self.make()
        self.assertEqual(svc.claim('c'), {'item': None, 'pending': 0})
        self.ask(svc, 'Alpha')
        self.assertEqual(svc.claim('c'), {'item': None, 'pending': 1})

    def test_a_song_that_is_ready_is_taken_before_one_that_waits_for_its_retry(self):
        svc = self.make()
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        self.source.fetch_errors.append(SourceUnavailable('a blip', code='source_down', auto_retry=True))
        svc.process_next()  # Alpha waits for its retry
        svc.process_next()  # Beta is ready
        self.assertEqual(svc.claim('c')['item']['title'], 'Beta')

    def test_final_files_that_went_missing_send_the_song_back_to_be_prepared_again(self):
        svc = self.make()
        self.ready(svc, 'Alpha')
        os.remove(os.path.join(library.song_dir(self.cfg.songs_dir, '1'), 'inst_final.wav'))
        self.assertEqual(svc.claim('c')['item'], None)
        self.assertEqual(self.items(svc)[0]['state'], 'queued')
        self.assertEqual(library.read_meta(self.cfg.songs_dir, '1')['status'], 'downloaded')
        self.prepare_all(svc)
        self.assertEqual(svc.claim('c')['item']['title'], 'Alpha')

    def test_finishing_a_song_sung_to_the_end_starts_its_cooldown(self):
        svc = self.make()
        self.ready(svc, 'Alpha')
        svc.claim('c')
        answer = svc.done(1, 'done')
        self.assertTrue(answer['ok'])
        self.assertIsNone(svc.queue()['current'])
        self.assertEqual(self.ask(svc, 'Alpha', 'u2')['code'], 'cooldown')

    def test_a_song_that_never_sounded_is_shown_as_failed_and_can_be_asked_for_again_at_once(self):
        svc = self.make()
        self.ready(svc, 'Alpha')
        svc.claim('c')
        svc.done(1, 'failed', 'the stage could not decode it')
        failed = svc.queue()['failed'][0]
        self.assertEqual((failed['title'], failed['code'], failed['retryable']), ('Alpha', 'playback_failed', True))
        self.assertEqual(failed['error'], 'the stage could not decode it')
        self.assertEqual(self.ask(svc, 'Alpha', 'u2')['status'], 'queued')  # no cooldown

    def test_skipped_stopped_and_interrupted_songs_count_as_sung(self):
        for outcome in ('skipped', 'stopped', 'interrupted'):
            with self.subTest(outcome):
                svc = self.make()
                self.ready(svc, 'Alpha')
                svc.claim('c')
                self.assertTrue(svc.done(None, outcome)['ok'])
                self.assertEqual(self.ask(svc, 'Alpha', 'u2')['code'], 'cooldown')

    def test_reporting_on_a_song_that_is_not_the_one_playing_changes_nothing(self):
        svc = self.make()
        self.assertEqual(svc.done(1, 'done')['code'], 'nothing_playing')
        self.ready(svc, 'Alpha')
        svc.claim('c')
        self.assertEqual(svc.done(99, 'done')['code'], 'nothing_playing')
        self.assertEqual(svc.queue()['current']['qid'], 1)
        with self.assertRaises(ValueError):
            svc.done(1, 'fine')

    def test_skipping_ends_the_song_being_sung(self):
        svc = self.make()
        self.assertEqual(svc.skip()['code'], 'nothing_playing')
        self.ready(svc, 'Alpha')
        svc.claim('c')
        self.assertTrue(svc.skip()['ok'])
        self.assertIsNone(svc.queue()['current'])

    def test_a_viewer_can_cancel_their_latest_waiting_song_and_nobody_elses(self):
        svc = self.make(queue={'max_per_user': 2})
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u1')
        self.ask(svc, 'Gamma', 'u2')
        self.assertEqual(svc.cancel(uid='u3')['code'], 'nothing_to_cancel')
        answer = svc.cancel(uid='u1')
        self.assertEqual((answer['ok'], answer['item']['title'], answer['was_playing']), (True, 'Beta', False))
        self.assertEqual([it['title'] for it in self.items(svc)], ['Alpha', 'Gamma'])

    def test_cancelling_when_only_the_song_being_sung_is_yours_stops_that_one(self):
        svc = self.make()
        self.ready(svc, 'Alpha', 'u1')
        svc.claim('c')
        answer = svc.cancel(uid='u1')
        self.assertEqual((answer['ok'], answer['was_playing'], answer['item']['title']), (True, True, 'Alpha'))
        self.assertIsNone(svc.queue()['current'])

    def test_the_streamer_can_remove_an_entry_by_its_place(self):
        svc = self.make()
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        self.assertEqual(svc.cancel(position=3)['code'], 'no_such_position')
        self.assertEqual(svc.cancel(position=0)['code'], 'no_such_position')
        self.assertEqual(svc.cancel(position=2)['item']['title'], 'Beta')
        self.assertEqual([it['title'] for it in self.items(svc)], ['Alpha'])

    def test_removing_by_number_and_the_song_being_sung(self):
        svc = self.make()
        first = self.ask(svc, 'Alpha', 'u1')
        self.prepare_all(svc)
        self.assertEqual(svc.remove(99)['code'], 'not_in_queue')
        svc.claim('c')
        self.assertEqual(svc.remove(first['qid'])['code'], 'playing_now')  # that is what skip is for

    def test_a_song_nobody_reports_on_is_ended_long_after_it_should_have_been_over(self):
        svc = self.make()
        self.ready(svc, 'Alpha')
        svc.claim('c')
        self.clock.advance(200 + 60)
        self.assertIsNotNone(svc.queue()['current'])
        self.clock.advance(70)
        self.assertIsNone(svc.queue()['current'])
        self.assertEqual(svc.done(None, 'done')['code'], 'nothing_playing')

    def test_failed_entries_are_shown_for_a_while_and_then_forgotten(self):
        svc = self.make(queue={'failed_keep_sec': 60})
        self.ask(svc, 'Alpha')
        self.source.fetch_errors.append(SongRejected('no', code='no_audio'))
        svc.process_next()
        self.assertEqual(len(svc.queue()['failed']), 1)
        self.clock.advance(61)
        self.assertEqual(svc.queue()['failed'], [])

    def test_the_source_can_be_resumed_by_the_operator(self):
        svc = self.make()
        self.source.halted = {'reason': 'code=-460'}
        self.assertEqual(svc.queue()['source']['halted'], {'reason': 'code=-460'})
        self.assertEqual(svc.resume_source(), {'ok': True})
        self.assertEqual((self.source.resumed, svc.queue()['source']['halted']), (1, None))


class Restart(ServiceCase):
    def restart(self, **settings):
        return self.make(root=self.root, **settings)

    def test_recent_requests_come_back_and_older_ones_do_not(self):
        svc = self.make()
        self.ask(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        self.ask(svc, 'Gamma', 'u3')
        svc.close()
        path = os.path.join(self.cfg.state_dir, 'queue.json')
        with open(path, encoding='utf-8') as handle:
            stored = json.load(handle)
        now = self.clock.now
        stored['items'][0]['requested_at'] = now - 21 * 60  # from before the window
        stored['items'][1]['state'] = 'processing'  # was being worked on when the service stopped
        stored['items'][2]['requested_at'] = now - 19 * 60
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(stored, handle)
        back = self.restart()
        titles = [(it['title'], it['state']) for it in self.items(back)]
        self.assertEqual(titles, [('Beta', 'queued'), ('Gamma', 'queued')])

    def test_numbering_goes_on_after_the_highest_number_ever_used(self):
        svc = self.make()
        for i, kw in enumerate(('Alpha', 'Beta')):
            self.ask(svc, kw, f'u{i}')
        svc.close()
        back = self.restart(queue={'restore_within_min': 0})  # nothing comes back ...
        self.assertEqual(self.items(back), [])
        self.assertEqual(self.ask(back, 'Gamma', 'u9')['qid'], 3)  # ... but the numbers are not reused

    def test_a_song_sung_before_the_restart_is_still_on_cooldown(self):
        svc = self.make()
        self.ready(svc, 'Alpha')
        svc.claim('c')
        svc.done(None, 'done')
        svc.close()
        back = self.restart()
        self.assertEqual(self.ask(back, 'Alpha', 'u2')['code'], 'cooldown')

    def test_a_torn_or_nonsense_queue_file_is_ignored_and_the_service_still_works(self):
        contents = [
            '{oops',
            'null',
            '"a string"',
            '[1, 2]',
            '{"items": "x"}',
            '{"items": [1, "a", {"qid": "x"}, {"qid": 1}, {"qid": 2, "song_id": "../x", "song": {"name": "n"}, "requested_at": 1, "state": "queued"}]}',
            '{"next_qid": "soon", "items": []}',
            '{"next_qid": -5, "items": []}',
        ]
        for content in contents:
            with self.subTest(content[:30]):
                root = self.tmpdir()
                os.makedirs(os.path.join(root, 'state'))
                with open(os.path.join(root, 'state', 'queue.json'), 'w', encoding='utf-8') as handle:
                    handle.write(content)
                with open(os.path.join(root, 'state', 'played.json'), 'w', encoding='utf-8') as handle:
                    handle.write('[not a mapping')
                svc = self.make(root=root)
                self.assertEqual(self.items(svc), [])
                self.assertEqual(self.ask(svc, 'Alpha')['qid'], 1)

    def test_entries_with_a_song_id_that_could_leave_the_library_are_dropped(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        svc.close()
        path = os.path.join(self.cfg.state_dir, 'queue.json')
        with open(path, encoding='utf-8') as handle:
            stored = json.load(handle)
        stored['items'][0]['song_id'] = '..\\..\\evil'
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(stored, handle)
        self.assertEqual(self.items(self.restart()), [])

    def test_the_queue_survives_a_torn_write_of_the_next_save(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        # a crash between writing the temporary file and renaming it leaves a stray .tmp next to a whole queue.json
        with open(os.path.join(self.cfg.state_dir, 'queue.json.tmp'), 'w') as handle:
            handle.write('{"half')
        svc.close()
        self.assertEqual([it['title'] for it in self.items(self.restart())], ['Alpha'])


class Views(ServiceCase):
    def test_health_is_ok_when_the_setup_can_work_and_says_what_is_wrong_when_not(self):
        svc = self.make()
        health = svc.health()
        self.assertEqual((health['ok'], health['ready'], health['service']), (True, True, 'singing'))
        self.assertEqual(health['config']['source'], 'local')
        self.assertEqual(health['config']['songs_dir'], self.cfg.songs_dir)
        self.assertNotIn('detail', health)
        os.remove(self.cfg.settings.rvc.model_pth)
        broken = svc.health()
        self.assertEqual((broken['ok'], broken['ready']), (False, True))
        self.assertIn('rvc.model_pth', broken['detail'])

    def test_health_counts_the_queue(self):
        svc = self.make()
        self.ready(svc, 'Alpha', 'u1')
        self.ask(svc, 'Beta', 'u2')
        config = svc.health()['config']
        self.assertEqual((config['queue'], config['ready']), (2, 1))

    def test_the_queue_view_has_what_the_controller_needs(self):
        svc = self.make()
        self.ask(svc, 'Alpha')
        view = svc.queue()
        self.assertEqual(set(view), {'current', 'items', 'failed', 'worker', 'source', 'songs_dir', 'limits'})
        self.assertEqual(view['limits'], {'max_per_user': 1, 'max_len': 5})
        item = view['items'][0]
        for key in ('qid', 'song_id', 'title', 'artists', 'duration', 'requester_uid', 'requester_name', 'state', 'cached', 'requested_at'):
            self.assertIn(key, item)
        self.assertNotIn('song', item)  # the internals stay inside
        self.assertNotIn('path', json.dumps(item))


if __name__ == '__main__':
    unittest.main()
