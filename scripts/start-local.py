#!/usr/bin/env python3
"""Serve only the standalone app on loopback; no directory browsing or uploads."""
import argparse
import secrets
from urllib.parse import urlsplit, parse_qs
from local_engine import LocalEngine
from remote_control import RemoteControl
import json
import platform
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='Локальный запуск телесуфлёра')
    parser.add_argument('--model', type=Path, default=None)
    parser.add_argument('--no-open', action='store_true', help='Не открывать браузер автоматически')
    script_dir = Path(__file__).resolve().parent
    default_dir = script_dir if any((script_dir / name).is_file() for name in ['Телесуфлёр.html', 'index.html']) else script_dir.parent / 'dist'
    parser.add_argument('--directory', type=Path, default=default_dir)
    args = parser.parse_args()
    root = args.directory.resolve()
    app_file = next((p for p in [root / 'Телесуфлёр.html', root / 'index.html'] if p.is_file()), None)
    if app_file is None:
        parser.error('Рядом с запуском должен находиться Телесуфлёр.html или index.html')
    identity = {'app': 'sufler-local', 'directory': str(root), 'version': 3}
    engine = LocalEngine(args.model or root / 'model-ru')

    remote = RemoteControl()

    def open_browser(url):
        if args.no_open:
            return
        if platform.system() == 'Darwin' and Path('/Applications/Google Chrome.app').exists():
            subprocess.Popen(['open', '-a', 'Google Chrome', url])
        else:
            webbrowser.open(url)

    class Handler(BaseHTTPRequestHandler):
        def local_host(self):
            port = self.server.server_address[1]
            return self.headers.get('Host') in [f'127.0.0.1:{port}', f'localhost:{port}']

        def do_POST(self):
            port = self.server.server_address[1]
            origin = self.headers.get('Origin')
            if not self.local_host() or origin not in [f'http://127.0.0.1:{port}', f'http://localhost:{port}'] or not secrets.compare_digest(self.headers.get('X-Sufler-Token', ''), engine.token):
                self.send_error(403); return
            route = urlsplit(self.path)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 0 or length > 262144:
                    self.send_error(413); return
                data = self.rfile.read(length)
                key = parse_qs(route.query).get('session', [''])[0]
                if route.path == '/api/remote/enable':
                    result = remote.enable()
                elif route.path == '/api/remote/poll':
                    result = remote.poll(json.loads(data))
                elif route.path == '/api/remote/disable':
                    result = remote.disable(json.loads(data).get('lease', ''))
                elif route.path == '/api/speech/start':
                    result = engine.start(json.loads(data).get('lang', 'ru-RU'))
                elif route.path == '/api/speech/audio':
                    result = engine.audio(key, data)
                elif route.path == '/api/speech/stop':
                    result = engine.stop(key)
                else:
                    self.send_error(404); return
                self.send_json(result)
            except (ValueError, TypeError) as error:
                self.send_json({'error': str(error)}, 400)
            except Exception:
                self.send_json({'error': 'Локальный движок завершил обработку с ошибкой. Перезапустите локальный комплект.'}, 500)

        def send_json(self, result, status=200):
            body = json.dumps(result, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self):
            self.respond(False)

        def do_GET(self):
            self.respond(True)

        def respond(self, include_body):
            if not self.local_host():
                self.send_error(403); return
            route = self.path.split('?', 1)[0]
            if route == '/api/speech/status':
                self.send_json(engine.status()); return
            if route == '/__sufler_health__':
                body = json.dumps(identity).encode('utf-8')
                mime = 'application/json; charset=utf-8'
            elif route in ['/', '/index.html']:
                body = app_file.read_bytes()
                mime = 'text/html; charset=utf-8'
            elif route == '/favicon.ico':
                self.send_response(204)
                self.end_headers()
                return
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            if include_body:
                self.wfile.write(body)

        def log_message(self, *_args):
            pass

    # Prefer one stable origin so autosave survives restarting the launcher.
    server = None
    for port in range(8765, 8776):
        url = f'http://127.0.0.1:{port}/'
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(url + '__sufler_health__', timeout=0.5) as response:
                    if json.loads(response.read(8192)) == identity:
                        print(f'Телесуфлёр уже запущен: {url}', flush=True)
                        open_browser(url)
                        return
            except (OSError, ValueError, urllib.error.URLError):
                pass
    if server is None:
        sys.exit('Порты 8765–8775 заняты. Закройте прежний запуск или откройте HTML напрямую.')
    print(f'Телесуфлёр: {url}\nДля остановки нажмите Ctrl+C или закройте это окно.', flush=True)
    open_browser(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        remote.disable()
        server.server_close()


if __name__ == '__main__':
    main()
