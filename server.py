#!/usr/bin/env python3
"""
Industrial Atlas UK — local dev server.
Replaces: python3 -m http.server 8000

Serves static files AND proxies /api/ch/* to Companies House,
adding the API key server-side so the browser never hits CH directly
(avoids CORS rejection of credentialed cross-origin requests).

Usage:
    python3 server.py
Then open: http://localhost:8000
"""

import http.server
import urllib.request
import urllib.error
import urllib.parse
import base64
import json
import os

PORT     = 8000
CH_KEY   = 'b235f3fb-7fa6-49a9-9b76-40c74f02bf43'
CH_BASE  = 'https://api.company-information.service.gov.uk'
CH_AUTH  = 'Basic ' + base64.b64encode(f'{CH_KEY}:'.encode()).decode()


class Handler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path.startswith('/api/ch/'):
            self._proxy_ch()
        else:
            super().do_GET()

    def _proxy_ch(self):
        # Strip /api/ch prefix, forward remainder to CH API
        tail = self.path[len('/api/ch'):]
        url  = CH_BASE + tail

        req = urllib.request.Request(url, headers={
            'Authorization': CH_AUTH,
            'Accept':        'application/json',
        })
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                body = r.read()
                self._json_response(r.status, body)
        except urllib.error.HTTPError as e:
            self._json_response(e.code, e.read())
        except Exception as e:
            self._json_response(500, json.dumps({'error': str(e)}).encode())

    def _json_response(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type',                'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length',              str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Only log proxy calls, suppress static file noise
        if '/api/ch/' in self.path:
            super().log_message(fmt, *args)


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)) or '.')
    print(f'Industrial Atlas UK — http://localhost:{PORT}')
    print(f'Companies House proxy active at /api/ch/')
    print('Ctrl-C to stop\n')
    with http.server.HTTPServer(('', PORT), Handler) as httpd:
        httpd.serve_forever()
