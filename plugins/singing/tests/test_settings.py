import os
import unittest

from singing_service.settings import Config, SettingsError, load_config, parse_settings

from .support import TempCase


class ParseSettings(unittest.TestCase):
    def test_an_empty_file_is_all_defaults(self):
        s = parse_settings(None)
        self.assertEqual(s.queue.max_per_user, 1)
        self.assertEqual(s.queue.max_len, 5)
        self.assertEqual(s.queue.restore_within_min, 20.0)
        self.assertEqual(s.rvc.f0_method, 'rmvpe')
        self.assertIn(12, s.transpose.allowed)
        self.assertEqual(s.source, 'auto')

    def test_nested_values_replace_the_defaults_they_name_and_nothing_else(self):
        s = parse_settings({'queue': {'max_len': 9}, 'mix': {'reverb': {'enabled': True}}})
        self.assertEqual(s.queue.max_len, 9)
        self.assertEqual(s.queue.max_per_user, 1)
        self.assertTrue(s.mix.reverb.enabled)
        self.assertEqual(s.mix.reverb.room_size, 0.25)

    def test_a_key_that_is_not_known_is_an_error_that_names_it(self):
        with self.assertRaisesRegex(SettingsError, r'queue\.max_lenght: unknown setting'):
            parse_settings({'queue': {'max_lenght': 9}})
        with self.assertRaisesRegex(SettingsError, r'sorce: unknown setting'):
            parse_settings({'sorce': 'local'})

    def test_bounds_and_types_are_checked_with_the_key_in_the_message(self):
        with self.assertRaisesRegex(SettingsError, r'queue\.max_len: 0 is below the minimum 1'):
            parse_settings({'queue': {'max_len': 0}})
        with self.assertRaisesRegex(SettingsError, r'mix\.target_lufs: .* above the maximum'):
            parse_settings({'mix': {'target_lufs': 3}})
        with self.assertRaisesRegex(SettingsError, r'queue\.max_len: expected an integer'):
            parse_settings({'queue': {'max_len': 2.5}})
        with self.assertRaisesRegex(SettingsError, r'queue\.max_len: expected an integer'):
            parse_settings({'queue': {'max_len': True}})
        with self.assertRaisesRegex(SettingsError, r'source: "cloud" is not one of'):
            parse_settings({'source': 'cloud'})
        with self.assertRaisesRegex(SettingsError, r'separation\.split_backing: expected true or false'):
            parse_settings({'separation': {'split_backing': 'yes'}})
        with self.assertRaisesRegex(SettingsError, r'transpose\.allowed\[1\]'):
            parse_settings({'transpose': {'allowed': [0, 'x']}})
        with self.assertRaisesRegex(SettingsError, r'queue: expected a mapping'):
            parse_settings({'queue': 5})

    def test_an_integer_is_fine_where_a_number_is_wanted_and_ids_in_overrides_become_text(self):
        s = parse_settings({'ncm': {'min_interval_sec': 4}, 'transpose': {'overrides': {186016: -12}}})
        self.assertEqual(s.ncm.min_interval_sec, 4.0)
        self.assertEqual(s.transpose.overrides, {'186016': -12})

    def test_not_a_number_is_refused(self):
        with self.assertRaisesRegex(SettingsError, r'not a finite number'):
            parse_settings({'ncm': {'timeout_sec': float('nan')}})


class LoadConfig(TempCase):
    def write(self, text: str) -> str:
        folder = self.tmpdir()
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, 'singing.yaml')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(text)
        return path

    def test_relative_paths_are_relative_to_the_settings_file(self):
        path = self.write('paths:\n  applio: ./applio\n  local_music: music\nrvc:\n  model_pth: models/voice.pth\n')
        base = os.path.dirname(path)
        cfg = load_config(path, self.tmpdir(), self.tmpdir())
        self.assertEqual(cfg.settings.paths.applio, os.path.normpath(os.path.join(base, 'applio')))
        self.assertEqual(cfg.settings.paths.local_music, os.path.normpath(os.path.join(base, 'music')))
        self.assertEqual(cfg.settings.rvc.model_pth, os.path.normpath(os.path.join(base, 'models', 'voice.pth')))

    def test_a_bare_ffmpeg_name_stays_a_name_and_a_path_is_resolved(self):
        cfg = load_config(self.write('paths:\n  ffmpeg: ffmpeg\n'), self.tmpdir(), self.tmpdir())
        self.assertEqual(cfg.ffmpeg, 'ffmpeg')
        path = self.write('paths:\n  ffmpeg: tools/ffmpeg.exe\n')
        cfg = load_config(path, self.tmpdir(), self.tmpdir())
        self.assertEqual(cfg.ffmpeg, os.path.normpath(os.path.join(os.path.dirname(path), 'tools', 'ffmpeg.exe')))

    def test_no_file_or_a_missing_file_means_defaults(self):
        for name in ('', os.path.join(self.tmpdir(), 'nope.yaml')):
            cfg = load_config(name, self.tmpdir(), self.tmpdir())
            self.assertEqual(cfg.settings.queue.max_len, 5)

    def test_a_file_that_is_not_yaml_or_not_a_mapping_is_an_error_naming_the_file(self):
        with self.assertRaisesRegex(SettingsError, r'singing\.yaml: cannot be read'):
            load_config(self.write('a: [unclosed'), self.tmpdir(), self.tmpdir())
        with self.assertRaisesRegex(SettingsError, r'singing\.yaml: .*expected a mapping'):
            load_config(self.write('- just\n- a list\n'), self.tmpdir(), self.tmpdir())

    def test_a_bad_key_in_the_file_names_the_file_and_the_key(self):
        with self.assertRaisesRegex(SettingsError, r'singing\.yaml: queue\.max_len: 0 is below'):
            load_config(self.write('queue:\n  max_len: 0\n'), self.tmpdir(), self.tmpdir())


class SourceAndProblems(TempCase):
    def config(self, **settings) -> Config:
        return Config(settings=parse_settings(settings), songs_dir=self.tmpdir(), state_dir=self.tmpdir())

    def test_auto_picks_netease_only_when_an_address_is_given(self):
        self.assertEqual(self.config().source_kind, 'local')
        self.assertEqual(self.config(ncm={'base_url': 'http://127.0.0.1:3300'}).source_kind, 'netease')
        self.assertEqual(self.config(source='local', ncm={'base_url': 'http://x'}).source_kind, 'local')
        self.assertEqual(self.config(source='netease').source_kind, 'netease')

    def test_problems_say_what_is_missing_and_where(self):
        cfg = self.config()
        found = cfg.problems()
        self.assertTrue(any('paths.local_music is not set' in p for p in found))
        self.assertTrue(any(p.startswith('paths.applio:') for p in found))
        self.assertTrue(any(p.startswith('rvc.model_pth:') for p in found))
        self.assertEqual(cfg.problems(pipeline=False), ['paths.local_music is not set: the local source needs a folder of audio files'])

    def test_netease_needs_an_http_address(self):
        found = self.config(source='netease', ncm={'base_url': 'localhost:3300'}).problems(pipeline=False)
        self.assertEqual(found, ['ncm.base_url must be an http(s) address when the source is netease'])

    def test_a_complete_setup_has_no_problems(self):
        music, applio = self.tmpdir(), self.tmpdir()
        open(os.path.join(applio, 'core.py'), 'w').close()
        python = os.path.join(applio, 'py.exe')
        model = os.path.join(applio, 'voice.pth')
        for f in (python, model):
            open(f, 'w').close()
        cfg = self.config(
            paths={'local_music': music, 'applio': applio, 'applio_python': python, 'ffmpeg': python},
            rvc={'model_pth': model},
        )
        self.assertEqual(cfg.problems(), [])
        self.assertEqual(cfg.summary()['source'], 'local')

    def test_derived_paths(self):
        cfg = self.config(paths={'applio': os.path.join('a', 'applio')})
        self.assertTrue(cfg.applio_python.endswith(('python.exe', 'python')))
        self.assertEqual(cfg.models_dir, os.path.join(cfg.state_dir, 'models'))


if __name__ == '__main__':
    unittest.main()
