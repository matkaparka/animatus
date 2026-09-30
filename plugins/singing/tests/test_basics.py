"""Lyrics, matching, the library's bookkeeping, and the small utilities."""

import json
import os
import unittest

from singing_service import lyrics
from singing_service.library import (
    final_files_present,
    is_current,
    is_ready,
    new_meta,
    orig_file,
    read_meta,
    rvc_signature,
    set_step,
    write_meta,
)
from singing_service.messages import DEFAULT_MESSAGES, message
from singing_service.settings import Rvc, parse_settings
from singing_service.sources.matching import best_match, is_candidate, norm
from singing_service.util import check_song_id, read_json, tail, write_json_atomic

from .support import TempCase


class Lrc(unittest.TestCase):
    def test_timed_lines_in_time_order_with_several_stamps_on_one_line(self):
        text = '[00:12.50]second\n[00:01.00][00:30.25]first and again\n[ar:Someone]\n[01:02.5]third'
        self.assertEqual(
            lyrics.parse_lrc(text),
            [
                {'t': 1.0, 'text': 'first and again'},
                {'t': 12.5, 'text': 'second'},
                {'t': 30.25, 'text': 'first and again'},
                {'t': 62.5, 'text': 'third'},
            ],
        )

    def test_credits_empty_lines_and_lines_without_a_time_are_dropped(self):
        text = '[00:00.00]作词：甲\n[00:00.50]Composer: B\n[00:01.00]\n[00:02.00]  \nno time here\n[00:03.00]a real line'
        self.assertEqual(lyrics.parse_lrc(text), [{'t': 3.0, 'text': 'a real line'}])

    def test_colon_as_the_fraction_separator_and_windows_line_ends(self):
        self.assertEqual(lyrics.parse_lrc('[00:05:50]x\r\n[00:06.5]y'), [{'t': 5.5, 'text': 'x'}, {'t': 6.5, 'text': 'y'}])

    def test_it_fits_what_the_stage_accepts(self):
        many = '\n'.join(f'[{i // 60:02d}:{i % 60:02d}.00]line {i}' for i in range(2500))
        parsed = lyrics.parse_lrc(many)
        self.assertEqual(len(parsed), lyrics.MAX_LINES)
        self.assertEqual(len(lyrics.parse_lrc('[00:01.00]' + 'x' * 1000)[0]['text']), lyrics.MAX_LINE_CHARS)

    def test_nothing_or_nonsense_is_an_empty_list(self):
        self.assertEqual(lyrics.parse_lrc(''), [])
        self.assertEqual(lyrics.parse_lrc(None), [])  # type: ignore[arg-type]


def song(name, artists=(), sid='1'):
    return {'id': sid, 'name': name, 'artists': list(artists), 'album': '', 'duration': 200.0}


class Matching(unittest.TestCase):
    def test_norm_folds_width_case_and_punctuation(self):
        self.assertEqual(norm('Ｈｅｌｌｏ, World!'), 'helloworld')
        self.assertEqual(norm('晴 天 ・ x'), '晴天x')

    def test_the_exact_title_beats_a_first_result_that_only_looks_similar(self):
        results = [
            song('When the Fire Comes', ['Somebody Else'], '1'),
            song('When the Fire Comes Down', ['Shane Jeter'], '2'),
        ]
        self.assertEqual(best_match('when the fire comes down shane jeter', results)['id'], '2')

    def test_brackets_in_the_title_do_not_matter_and_an_artist_hit_adds_a_little(self):
        results = [song('晴天 (Live)', ['乙'], '1'), song('晴天', ['周杰伦'], '2')]
        self.assertEqual(best_match('晴天 周杰伦', results)['id'], '2')
        self.assertEqual(best_match('晴天', [song('晴天 (Live)', ['乙'], '1')])['id'], '1')

    def test_nothing_fitting_takes_the_first(self):
        results = [song('aaa', [], '1'), song('bbb', [], '2')]
        self.assertEqual(best_match('zzz', results)['id'], '1')

    def test_a_folder_song_is_a_candidate_only_when_words_and_song_touch(self):
        s = song('晴天', ['周杰伦'])
        for words in ('晴天', '晴天 周杰伦', '周杰伦', '请播放晴天吧'):
            self.assertTrue(is_candidate(words, s), words)
        for words in ('雨天', '', '   '):
            self.assertFalse(is_candidate(words, s), words)


class Library(TempCase):
    def test_meta_round_trip_and_step_bookkeeping(self):
        d = self.tmpdir()
        meta = new_meta({'id': 42, 'name': 'Song', 'artists': ['A'], 'duration': 12.5})
        write_meta(d, meta)
        set_step(d, meta, 'download', 'done', file='orig.mp3')
        back = read_meta(d, 42)
        assert back is not None
        self.assertEqual(back['name'], 'Song')
        self.assertEqual(back['steps']['download']['file'], 'orig.mp3')
        self.assertFalse(is_ready(back))

    def test_a_torn_or_missing_meta_is_none(self):
        d = self.tmpdir()
        self.assertIsNone(read_meta(d, 7))
        os.makedirs(os.path.join(d, '7'))
        with open(os.path.join(d, '7', 'meta.json'), 'w') as handle:
            handle.write('{"id": "7", "nam')
        self.assertIsNone(read_meta(d, 7))

    def test_a_song_is_current_only_when_ready_and_converted_with_todays_voice_settings(self):
        rvc = Rvc(model_pth='/x/voice.pth', index='/x/voice.index', index_rate=0.5)
        meta = {'status': 'ready', 'steps': {'convert': {'rvc': rvc_signature(rvc)}}}
        self.assertTrue(is_current(meta, rvc))
        self.assertFalse(is_current(meta, Rvc(model_pth='/x/other.pth', index='/x/voice.index')))
        self.assertFalse(is_current(meta, Rvc(model_pth='/x/voice.pth', index='/x/voice.index', index_rate=0.75)))
        self.assertFalse(is_current(meta, Rvc(model_pth='/x/voice.pth', index='/x/voice.index', protect=0.2)))
        self.assertFalse(is_current({**meta, 'status': 'processing'}, rvc))
        self.assertFalse(is_current(None, rvc))

    def test_the_signature_ignores_where_the_files_are_and_only_keeps_their_names(self):
        a = rvc_signature(Rvc(model_pth='/one/voice.pth'))
        b = rvc_signature(Rvc(model_pth='/two/voice.pth'))
        self.assertEqual(a, b)

    def test_orig_file_skips_a_download_in_progress(self):
        d = self.tmpdir()
        self.assertIsNone(orig_file(d))
        open(os.path.join(d, 'orig.mp3.part'), 'w').close()
        self.assertIsNone(orig_file(d))
        open(os.path.join(d, 'orig.flac'), 'w').close()
        self.assertEqual(os.path.basename(orig_file(d) or ''), 'orig.flac')
        self.assertFalse(final_files_present(d))

    def test_song_ids_are_folder_safe(self):
        self.assertEqual(check_song_id(186016), '186016')
        self.assertEqual(check_song_id('local_ab12cd34'), 'local_ab12cd34')
        for bad in ('', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x' * 65, 'a b', 'x.'):
            with self.assertRaises(ValueError, msg=bad):
                check_song_id(bad)


class Files(TempCase):
    def test_a_torn_json_file_is_the_default(self):
        path = os.path.join(self.tmpdir(), 'x.json')
        with open(path, 'w') as handle:
            handle.write('{"a": 1')
        self.assertEqual(read_json(path, {'d': 1}), {'d': 1})
        self.assertEqual(read_json(os.path.join(self.tmpdir(), 'none.json'), 5), 5)

    def test_writes_are_whole_and_leave_no_temp_file(self):
        path = os.path.join(self.tmpdir(), 'sub', 'x.json')
        write_json_atomic(path, {'名': 'é'})
        write_json_atomic(path, {'名': 'é', 'n': 2})
        with open(path, encoding='utf-8') as handle:
            self.assertEqual(json.load(handle), {'名': 'é', 'n': 2})
        self.assertEqual(os.listdir(os.path.dirname(path)), ['x.json'])

    def test_tail_keeps_the_end(self):
        self.assertEqual(tail('a\nb\nc\nd', lines=2), 'c\nd')


class Messages(unittest.TestCase):
    def test_defaults_are_filled_in_and_overrides_win(self):
        self.assertEqual(message({}, 'per_user_limit', title='X', max=1), '你点的《X》还没唱，一个人同时只能点 1 首')
        self.assertEqual(message({'queue_full': 'full: {max}'}, 'queue_full', max=5), 'full: 5')

    def test_a_missing_field_is_left_empty_and_a_broken_override_falls_back(self):
        self.assertEqual(message({}, 'no_such_position'), '队列里没有第  首')
        self.assertEqual(message({'queue_full': 'oops {'}, 'queue_full', max=5), DEFAULT_MESSAGES['queue_full'].format(max=5))

    def test_every_default_renders_without_fields(self):
        for code in DEFAULT_MESSAGES:
            self.assertTrue(message({}, code))

    def test_settings_accept_message_overrides_by_code(self):
        self.assertEqual(parse_settings({'messages': {'queue_full': 'x'}}).messages, {'queue_full': 'x'})


if __name__ == '__main__':
    unittest.main()
