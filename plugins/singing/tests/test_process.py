"""The service as the supervisor starts it: a real process, on a real loopback port, with real (failing-fast) tools.

The real pipeline needs models this repository does not have, so a song that is accepted ends as a failed entry with
the reason the missing tool gives. That is what is checked: the whole stack, from the command line to the runner and
the step scripts, without a GPU, a model or the network (the NetEase server is a fake one on loopback).
"""

import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import unittest

from .fake_ncm import FakeNcm
from .support import TempCase, wait_until

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def has_audio_separator() -> bool:
    try:
        import audio_separator  # noqa: F401

        return True
    except ImportError:
        return False


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return int(s.getsockname()[1])


class RealService(TempCase):
    def setUp(self):
        self.root = self.tmpdir()
        self.port = free_port()
        self.procs: list[subprocess.Popen] = []
        self.log: list[str] = []

    def files(self, source: str = 'local', extra: str = '') -> str:
        """Dummy tool files and a settings file that describes them."""
        r = self.root
        os.makedirs(os.path.join(r, 'applio'), exist_ok=True)
        os.makedirs(os.path.join(r, 'music'), exist_ok=True)
        for name in ('applio/core.py', 'applio/py.exe', 'voice.pth', 'ffmpeg.exe'):
            open(os.path.join(r, *name.split('/')), 'w').close()
        path = os.path.join(r, 'singing.yaml')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(
                f'source: {source}\n'
                'paths:\n'
                '  local_music: music\n  applio: applio\n  applio_python: applio/py.exe\n  ffmpeg: ./ffmpeg.exe\n'
                'rvc:\n  model_pth: voice.pth\n'
                'retry:\n  max_attempts: 1\n'
                f'{extra}'
            )
        return path

    def start(self, settings: str, env: dict | None = None) -> subprocess.Popen:
        proc = subprocess.Popen(
            [sys.executable, '-u', '-m', 'singing_service', '--port', str(self.port),
             '--songs-dir', os.path.join(self.root, 'songs'), '--state-dir', os.path.join(self.root, 'state'), '--settings', settings],
            cwd=PLUGIN_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env={**os.environ, **(env or {})},
        )
        self.procs.append(proc)
        self.addCleanup(self.stop, proc)
        return proc

    def stop(self, proc: subprocess.Popen) -> None:
        if proc.poll() is None:
            proc.kill()
        proc.wait(10)
        if proc.stdout:
            proc.stdout.close()

    def call(self, method, path, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request(method, path, body=json.dumps(body).encode() if body is not None else None)
            response = conn.getresponse()
            return response.status, json.loads(response.read().decode('utf-8'))
        finally:
            conn.close()

    def wait_answering(self, proc: subprocess.Popen) -> None:
        """Waits for the line the service prints once its port is open (a refused connection takes seconds on Windows,
        so polling the port would be slow)."""
        assert proc.stdout is not None
        watchdog = threading.Timer(60, proc.kill)
        watchdog.start()
        try:
            while True:
                line = proc.stdout.readline().decode('utf-8', 'replace')
                if not line:
                    raise AssertionError(f'the service exited with code {proc.wait(10)} before it listened:\n' + ''.join(self.log))
                self.log.append(line)
                if 'listening on 127.0.0.1' in line:
                    return
        finally:
            watchdog.cancel()

    def shut_down(self, proc: subprocess.Popen) -> str:
        self.assertEqual(self.call('POST', '/shutdown', {})[0], 200)
        proc.wait(15)
        assert proc.stdout is not None
        return ''.join(self.log) + proc.stdout.read().decode('utf-8', 'replace')

    def test_it_starts_answers_and_stops_when_asked_with_exit_code_0(self):
        proc = self.start(self.files())
        self.wait_answering(proc)
        status, health = self.call('GET', '/health')
        self.assertEqual((status, health['ok'], health['ready']), (200, True, True))
        self.assertEqual(health['config']['source'], 'local')
        self.assertEqual(self.call('GET', '/queue')[1]['items'], [])
        log = self.shut_down(proc)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('listening on 127.0.0.1', log)

    def test_settings_that_cannot_be_used_are_shown_in_the_health_answer_not_hidden_in_an_exit(self):
        settings = self.files(extra='queue:\n  max_len: 0\n')
        proc = self.start(settings)
        self.wait_answering(proc)
        status, health = self.call('GET', '/health')
        self.assertEqual((status, health['ok']), (503, False))
        self.assertIn('queue.max_len', health['detail'])
        self.assertEqual(self.call('POST', '/request', {'keyword': 'x'})[0], 503)
        self.shut_down(proc)
        self.assertEqual(proc.returncode, 0)

    @unittest.skipIf(has_audio_separator(), 'audio-separator is installed here: the real separation would start')
    def test_a_song_from_the_source_goes_through_the_real_runner_and_fails_with_the_missing_tools_own_words(self):
        api = FakeNcm()
        self.addCleanup(api.close)
        cookie = 'made-up-' + 'cookie-' + 'value-9876'
        settings = self.files(source='netease', extra=f'ncm:\n  base_url: {api.base_url}\n  min_interval_sec: 0.5\n')
        proc = self.start(settings, env={'NCM_COOKIE': cookie})
        self.wait_answering(proc)
        status, answer = self.call('POST', '/request', {'keyword': 'first song artist a', 'requester_uid': 7, 'requester_name': 'ann', 'request_id': 'r1'})
        self.assertEqual((status, answer['status']), (200, 'queued'))
        self.assertEqual(answer['song']['title'], 'First Song')

        def failed() -> bool:
            return bool(self.call('GET', '/queue')[1]['failed'])

        wait_until(failed, 60, 'the entry to fail in the missing tool')
        entry = self.call('GET', '/queue')[1]['failed'][0]
        self.assertEqual((entry['code'], entry['retryable']), ('step_failed', False))
        self.assertIn('audio_separator', entry['error'])  # the operator sees what to install
        self.assertNotIn('audio_separator', entry['reason'])  # the audience does not see tool output
        self.assertTrue(os.path.isfile(os.path.join(self.root, 'songs', '111', 'orig.mp3')))  # it did download
        # the account cookie reached the API server (a header) and nowhere else
        self.assertEqual({r['cookie'] for r in api.requests if r['path'] != '/cdn/a.mp3'}, {cookie})
        log = self.shut_down(proc)
        self.assertNotIn(cookie, log)
        for dirpath, _, names in os.walk(self.root):
            for name in names:
                if name.endswith(('.json', '.yaml', '.lrc', '.log')):
                    with open(os.path.join(dirpath, name), encoding='utf-8', errors='replace') as handle:
                        self.assertNotIn(cookie, handle.read(), os.path.join(dirpath, name))


if __name__ == '__main__':
    unittest.main()
