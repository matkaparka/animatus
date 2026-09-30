"""The HTTP contract, over a real loopback server with the service behind it (source and tools simulated)."""

import http.client
import json
import threading
import unittest

from singing_service.api import ApiServer
from singing_service.errors import SourceUnavailable

from .test_service import ServiceCase


class ApiCase(ServiceCase):
    def serve(self, service=None, startup_error: str = '') -> ApiServer:
        server = ApiServer(service, 0, startup_error)
        thread = threading.Thread(target=server.serve, daemon=True)
        thread.start()
        self.addCleanup(server.close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.stop)
        self.server, self.serve_thread = server, thread
        return server

    def call(self, method: str, path: str, body=None, raw: bytes | None = None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.port, timeout=10)
        try:
            data = raw if raw is not None else (json.dumps(body).encode('utf-8') if body is not None else None)
            conn.request(method, path, body=data, headers=headers or {})
            response = conn.getresponse()
            payload = response.read()
            return response.status, json.loads(payload.decode('utf-8')), response
        finally:
            conn.close()

    def setUp(self):
        self.svc = self.make()
        self.serve(self.svc)


class Health(ApiCase):
    def test_it_listens_on_the_loopback_address_only(self):
        self.assertEqual(self.server.httpd.server_address[0], '127.0.0.1')

    def test_health_is_the_contract_of_a_supervised_service(self):
        status, body, response = self.call('GET', '/health')
        self.assertEqual(status, 200)
        self.assertEqual((body['ok'], body['ready'], body['service']), (True, True, 'singing'))
        self.assertIn('songs_dir', body['config'])
        self.assertTrue(response.getheader('Content-Type').startswith('application/json'))

    def test_a_setup_that_cannot_work_is_503_with_the_reason(self):
        import os

        os.remove(self.cfg.settings.rvc.model_pth)
        status, body, _ = self.call('GET', '/health')
        self.assertEqual(status, 503)
        self.assertEqual((body['ok'], body['ready']), (False, True))
        self.assertIn('rvc.model_pth', body['detail'])

    def test_a_service_that_could_not_read_its_settings_still_answers_and_says_why(self):
        server = self.serve(None, 'settings.yaml: queue.max_len: 0 is below the minimum 1')
        self.assertTrue(server.port)
        status, body, _ = self.call('GET', '/health')
        self.assertEqual(status, 503)
        self.assertEqual((body['ok'], body['ready']), (False, False))
        self.assertIn('queue.max_len', body['detail'])
        status, body, _ = self.call('POST', '/request', {'keyword': 'x'})
        self.assertEqual((status, body['error']['code']), (503, 'not_configured'))
        self.assertEqual(self.call('GET', '/queue')[0], 503)


class Requests(ApiCase):
    def request(self, keyword='Alpha', uid='u1', name='ann', **extra):
        return self.call('POST', '/request', {'keyword': keyword, 'requester_uid': uid, 'requester_name': name, **extra})

    def test_a_request_is_queued_and_the_answer_says_where_and_how(self):
        status, body, _ = self.request(request_id='r1', wait_s=10)
        self.assertEqual(status, 200)
        self.assertEqual((body['status'], body['qid'], body['position'], body['cached']), ('queued', 1, 1, False))
        self.assertEqual(body['song'], {'id': '1', 'title': 'Alpha', 'artists': ['Artist'], 'duration': 200.0})

    def test_the_same_request_id_gets_the_same_answer_marked_as_a_repeat(self):
        first = self.request(request_id='r1')[1]
        status, second, _ = self.request(request_id='r1')
        self.assertEqual((status, second['qid'], second['duplicate']), (200, first['qid'], True))
        self.assertEqual(len(self.svc.queue()['items']), 1)

    def test_a_refusal_is_a_200_that_says_why_in_the_viewers_words(self):
        status, body, _ = self.request('Omega')
        self.assertEqual(status, 200)
        self.assertEqual((body['status'], body['code']), ('rejected', 'not_found'))
        self.assertEqual(body['reason'], '没搜到「Omega」')  # Chinese survives the round trip

    def test_a_source_that_cannot_answer_is_a_503_that_may_be_retried_and_tells_no_secrets(self):
        self.source.search_error = SourceUnavailable('cannot reach http://127.0.0.1:3300 (ConnectionRefusedError)', code='source_down', auto_retry=True)
        status, body, _ = self.request()
        self.assertEqual(status, 503)
        self.assertEqual(body['error']['code'], 'source_down')
        self.assertTrue(body['error']['retryable'])
        self.assertNotIn('127.0.0.1', body['error']['message'])
        self.assertEqual(self.svc.queue()['items'], [])

    def test_the_answer_to_a_request_that_took_too_long_is_a_refusal_not_a_hang(self):
        import time

        self.source.search_hook = lambda kw: time.sleep(0.4)
        status, body, _ = self.request(wait_s=0.2)
        self.assertEqual((status, body['code']), (200, 'request_timeout'))
        self.assertEqual(self.svc.queue()['items'], [])

    def test_abandon_takes_back_a_request(self):
        self.request(request_id='r1')
        status, body, _ = self.call('POST', '/abandon', {'request_id': 'r1'})
        self.assertEqual((status, body), (200, {'ok': True, 'removed': True}))
        self.assertEqual(self.svc.queue()['items'], [])


class Playing(ApiCase):
    def prepared(self, keyword='Alpha', uid='u1'):
        self.call('POST', '/request', {'keyword': keyword, 'requester_uid': uid, 'requester_name': uid})
        self.prepare_all(self.svc)

    def test_the_queue_view(self):
        self.prepared()
        status, body, _ = self.call('GET', '/queue')
        self.assertEqual(status, 200)
        self.assertEqual(body['items'][0]['state'], 'ready')
        self.assertEqual(body['limits'], {'max_per_user': 1, 'max_len': 5})
        self.assertEqual(body['source']['kind'], 'fake')

    def test_claim_done_and_the_answers_for_a_song_that_is_not_there(self):
        self.assertEqual(self.call('POST', '/claim', {'claim_id': 'c1'})[1], {'item': None, 'pending': 0})
        self.prepared()
        status, body, _ = self.call('POST', '/claim', {'claim_id': 'c1'})
        self.assertEqual(status, 200)
        self.assertEqual(body['item']['title'], 'Alpha')
        self.assertEqual(body['files'], {'dir': '1', 'vocals': 'vocals_final.wav', 'inst': 'inst_final.wav'})
        self.assertEqual(body['lyrics'][0], {'t': 1.0, 'text': 'first line'})
        status, body, _ = self.call('POST', '/done', {'qid': 1, 'outcome': 'done'})
        self.assertEqual((status, body['ok']), (200, True))
        status, body, _ = self.call('POST', '/done', {'qid': 1, 'outcome': 'done'})
        self.assertEqual((status, body['ok'], body['code']), (200, False, 'nothing_playing'))

    def test_skip_cancel_remove(self):
        self.prepared('Alpha', 'u1')
        self.call('POST', '/claim', {'claim_id': 'c'})
        self.assertEqual(self.call('POST', '/skip', {})[1]['ok'], True)
        self.assertEqual(self.call('POST', '/skip', {})[1]['code'], 'nothing_playing')
        self.call('POST', '/request', {'keyword': 'Beta', 'requester_uid': 'u2', 'requester_name': 'bob'})
        status, body, _ = self.call('POST', '/cancel', {'requester_uid': 'u2'})
        self.assertEqual((status, body['ok'], body['item']['title']), (200, True, 'Beta'))
        self.call('POST', '/request', {'keyword': 'Gamma', 'requester_uid': 'u3', 'requester_name': 'cy'})
        status, body, _ = self.call('POST', '/cancel', {'position': 1})
        self.assertEqual((status, body['item']['title']), (200, 'Gamma'))
        self.assertEqual(self.call('POST', '/remove', {'qid': 77})[1]['code'], 'not_in_queue')

    def test_the_operator_can_lift_the_sources_stop(self):
        self.source.halted = {'reason': 'code=-460'}
        self.assertEqual(self.call('POST', '/source/resume', {})[1], {'ok': True})
        self.assertIsNone(self.call('GET', '/queue')[1]['source']['halted'])


class BadInput(ApiCase):
    def test_what_is_wrong_with_a_call_is_a_400_that_says_which_field(self):
        cases = [
            ('/request', {'keyword': 5}, 'keyword'),
            ('/request', {'keyword': 'x', 'wait_s': 500}, 'wait_s'),
            ('/request', {'keyword': 'x', 'wait_s': 'soon'}, 'wait_s'),
            ('/request', {'keyword': 'x', 'requester_uid': ['a']}, 'requester_uid'),
            ('/abandon', {}, 'request_id'),
            ('/claim', {}, 'claim_id'),
            ('/done', {'qid': 1}, 'outcome'),
            ('/done', {'qid': 1, 'outcome': 'fine'}, 'outcome'),
            ('/done', {'qid': 'one', 'outcome': 'done'}, 'qid'),
            ('/remove', {}, 'qid'),
            ('/remove', {'qid': True}, 'qid'),
            ('/cancel', {}, 'requester_uid'),
            ('/cancel', {'position': 0}, 'position'),
        ]
        for path, body, field in cases:
            with self.subTest(path=path, body=body):
                status, payload, _ = self.call('POST', path, body)
                self.assertEqual((status, payload['error']['code']), (400, 'bad_request'))
                self.assertIn(field, payload['error']['message'])
                self.assertFalse(payload['error']['retryable'])

    def test_a_body_that_is_not_a_json_object_is_refused(self):
        for raw in (b'{oops', b'[1, 2]', b'"text"', b'\xff\xfe'):
            with self.subTest(raw=raw):
                status, payload, _ = self.call('POST', '/request', raw=raw)
                self.assertEqual((status, payload['error']['code']), (400, 'bad_request'))

    def test_a_body_that_is_too_large_is_refused_before_it_is_read(self):
        status, payload, _ = self.call('POST', '/request', raw=b'x' * (70 * 1024))
        self.assertEqual((status, payload['error']['code']), (413, 'too_large'))
        self.assertEqual(self.call('GET', '/health')[0], 200)  # and the server is fine

    def test_unknown_paths_and_the_wrong_method_are_404s(self):
        for method, path in (('GET', '/nope'), ('POST', '/nope'), ('GET', '/request'), ('GET', '/claim'), ('POST', '/queue')):
            with self.subTest(method=method, path=path):
                status, payload, _ = self.call(method, path, {} if method == 'POST' else None)
                self.assertEqual((status, payload['error']['code']), (404, 'not_found'))

    def test_a_bug_is_a_500_that_does_not_leak_what_went_wrong(self):
        def broken():
            raise RuntimeError('C:\\secret\\place exploded')

        self.svc.queue = broken  # type: ignore[method-assign]
        status, payload, _ = self.call('GET', '/queue')
        self.assertEqual((status, payload['error']['code']), (500, 'internal'))
        self.assertNotIn('secret', json.dumps(payload))
        self.assertEqual(self.call('GET', '/health')[0], 200)  # the server goes on

    def test_one_connection_can_carry_several_calls(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.port, timeout=10)
        try:
            for _ in range(3):
                conn.request('GET', '/health')
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
        finally:
            conn.close()


class Shutdown(ApiCase):
    def test_a_shutdown_request_is_answered_and_then_the_server_stops(self):
        status, body, _ = self.call('POST', '/shutdown', {})
        self.assertEqual((status, body), (200, {'ok': True}))
        self.serve_thread.join(5)
        self.assertFalse(self.serve_thread.is_alive(), 'the server kept serving after the shutdown')


if __name__ == '__main__':
    unittest.main()
