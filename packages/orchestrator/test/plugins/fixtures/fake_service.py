"""Standard-library stand-in for a Python plugin service, used with the job guard in tests.

    python fake_service.py --port N [--grandchild] [--info-file PATH]

Serves GET /health and GET /info, and stops on POST /shutdown.
"""

import argparse
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--grandchild', action='store_true')
parser.add_argument('--info-file')
args = parser.parse_args()

grandchild = None
if args.grandchild:
    grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)'])


def info():
    return {
        'pid': os.getpid(),
        'grandchildPid': grandchild.pid if grandchild else None,
        'stdoutEncoding': sys.stdout.encoding,
        'unbuffered': os.environ.get('PYTHONUNBUFFERED'),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            self.reply(200, {'ok': True, 'ready': True, 'service': 'fake-py'})
        elif self.path == '/info':
            self.reply(200, info())
        else:
            self.reply(404, {'error': {'code': 'not_found', 'message': 'no such path', 'retryable': False}})

    def do_POST(self):
        if self.path == '/shutdown':
            self.reply(200, {'ok': True})
            if grandchild:
                grandchild.kill()
            os._exit(0)
        self.reply(404, {'error': {'code': 'not_found', 'message': 'no such path', 'retryable': False}})


server = HTTPServer(('127.0.0.1', args.port), Handler)
if args.info_file:
    with open(args.info_file, 'w', encoding='utf-8') as handle:
        json.dump(info(), handle)
print('fake python service listening é 你好', flush=True)
server.serve_forever()
