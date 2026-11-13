"""Opt-in LAN control. Separate listener never serves scripts, audio or files."""
import ipaddress
import json
import secrets
import socket
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

REMOTE_HTML = '''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Суфлёр — пульт</title><style>body{margin:0;padding:24px;background:#101112;color:#f0f0ef;font:18px system-ui;max-width:540px;margin:auto}h1{font-size:28px}p{color:#aaa;line-height:1.5}main{display:grid;grid-template-columns:1fr 1fr;gap:12px}button{padding:22px 12px;border-radius:12px;border:1px solid #444;background:#202124;color:inherit;font:inherit;touch-action:manipulation}button:first-child{background:#f4ab85;color:#21150e}button:disabled{opacity:.4}#status{min-height:54px}small{display:block;margin-top:24px;color:#aaa}</style><h1>Суфлёр · пульт</h1><p id="status" role="status">Подключаемся…</p><main><button data-action="start">Начать</button><button data-action="pause">Пауза</button><button data-action="previous">← Абзац</button><button data-action="next">Абзац →</button><button data-action="retake">Повторить дубль</button><button data-action="slower">Медленнее −5</button><button data-action="faster">Быстрее +5</button></main><small>Скорость меняется только для режима «По скорости». Держите суфлёр открытым на компьютере. Если связь пропала, используйте паузу на компьютере.</small><script>
let token=location.hash.slice(1);try{if(token)sessionStorage.setItem('sufler-remote-token',token);else token=sessionStorage.getItem('sufler-remote-token')||'';}catch{}history.replaceState(null,'',location.pathname);let busy=false,connected=false;
async function request(path,body){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3500);try{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Remote-Token':token},body:JSON.stringify(body),signal:controller.signal});if(!r.ok)throw Error('Ссылка отключена или истекла. Включите пульт заново на компьютере.');return await r.json();}finally{clearTimeout(timer);}}
function state(s){connected=!!s.hostAlive;document.getElementById('status').textContent=connected?`${s.countdown?'Отсчёт':s.running?'Чтение':'Пауза'} · ${s.progress||0}% · ${s.speed||130} слов/мин`:'Нет связи с вкладкой суфлёра. Откройте её на компьютере.';document.querySelectorAll('button').forEach(b=>b.disabled=!connected||busy);}
async function poll(){if(busy)return;try{state(await request('/state',{}));}catch(e){connected=false;document.getElementById('status').textContent=e.message;document.querySelectorAll('button').forEach(b=>b.disabled=true);}}
document.querySelectorAll('button').forEach(b=>{b.disabled=true;b.onclick=async()=>{if(busy||!connected)return;busy=true;document.querySelectorAll('button').forEach(x=>x.disabled=true);try{await request('/command',{action:b.dataset.action});}catch(e){document.getElementById('status').textContent=e.message;}finally{busy=false;poll();}};});setInterval(poll,1000);poll();
</script></html>'''


def lan_addresses():
    addresses = set()
    try:
        addresses.update(info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            # UDP connect selects a route; it sends no packet.
            sock.connect(('192.0.2.1', 9))
            addresses.add(sock.getsockname()[0])
    except OSError:
        pass
    return sorted(a for a in addresses if ipaddress.ip_address(a).is_private and not ipaddress.ip_address(a).is_loopback)


class RemoteControl:
    def __init__(self):
        self.lock = threading.RLock()
        self.server = None
        self.token = ''
        self.lease = ''
        self.commands = deque(maxlen=40)
        self.serial = 0
        self.last_host = 0
        self.last_phone = 0
        self.expires = 0
        self.state = {}
        self.expiry_timer = None

    def enable(self):
        self.disable()
        addresses = lan_addresses()
        if not addresses:
            raise ValueError('Не найден адрес локальной сети. Подключите компьютер к Wi-Fi.')
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(5)

            def log_message(self, *_args):
                pass

            def reply(self, status, data, mime='application/json'):
                body = data.encode() if isinstance(data, str) else json.dumps(data).encode()
                self.send_response(status)
                self.send_header('Content-Type', mime + '; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('X-Frame-Options', 'DENY')
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == '/':
                    self.reply(200, REMOTE_HTML, 'text/html')
                elif self.path == '/favicon.ico':
                    self.reply(200, '')
                else:
                    self.reply(404, {})

            def do_POST(self):
                # No CORS: callers must originate from this controller page.
                origin = self.headers.get('Origin', '')
                if origin != 'http://' + self.headers.get('Host', ''):
                    self.reply(403, {}); return
                with owner.lock:
                    valid = bool(owner.token) and time.monotonic() < owner.expires and secrets.compare_digest(self.headers.get('X-Remote-Token', ''), owner.token)
                    if not valid:
                        self.reply(403, {}); return
                    try:
                        length = int(self.headers.get('Content-Length', '0'))
                        if length < 0 or length > 1024:
                            self.reply(413, {}); return
                        data = json.loads(self.rfile.read(length))
                        if not isinstance(data, dict):
                            raise ValueError()
                    except (ValueError, OSError):
                        self.reply(400, {}); return
                    now = time.monotonic()
                    owner.last_phone = now
                    if self.path == '/state':
                        self.reply(200, {**owner.state, 'hostAlive': now - owner.last_host < 5})
                    elif self.path == '/command':
                        if now - owner.last_host > 5:
                            self.reply(409, {}); return
                        action = data.get('action')
                        if action not in ['start', 'pause', 'retake', 'previous', 'next', 'slower', 'faster']:
                            self.reply(400, {}); return
                        if len(owner.commands) >= 40:
                            self.reply(429, {}); return
                        owner.serial += 1
                        owner.commands.append({'id': owner.serial, 'action': action, 'at': now})
                        self.reply(200, {'queued': True})
                    else:
                        self.reply(404, {})

        server = ThreadingHTTPServer(('0.0.0.0', 0), Handler)
        server.daemon_threads = True
        with self.lock:
            self.server = server
            self.token = secrets.token_urlsafe(32)
            self.lease = secrets.token_urlsafe(32)
            self.expires = time.monotonic() + 7200
            self.commands.clear()
            self.last_phone = 0
            self.last_host = time.monotonic()
            urls = [f'http://{a}:{server.server_port}/#{self.token}' for a in addresses]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.expiry_timer = threading.Timer(7200, self.disable)
        self.expiry_timer.daemon = True
        self.expiry_timer.start()
        return {'lease': self.lease, 'urls': urls}

    def poll(self, data):
        with self.lock:
            if not self.server or not secrets.compare_digest(str(data.get('lease', '')), self.lease) or time.monotonic() >= self.expires:
                return {'enabled': False}
            now = time.monotonic()
            state = data.get('state', {})
            if not isinstance(state, dict):
                raise ValueError('Неверное состояние пульта')
            # Only fixed control metadata crosses the LAN boundary.
            self.state = {k: state[k] for k in ['running', 'countdown', 'progress', 'speed', 'mode'] if k in state and isinstance(state[k], (bool, int, str))}
            self.last_host = now
            commands = [{'id': c['id'], 'action': c['action']} for c in self.commands if now - c['at'] < 3]
            self.commands.clear()
            return {'enabled': True, 'commands': commands, 'connected': now - self.last_phone < 5}

    def disable(self, lease=None):
        with self.lock:
            if lease is not None and not secrets.compare_digest(str(lease), self.lease):
                raise ValueError('Эта вкладка не управляет пультом')
            if self.expiry_timer:
                self.expiry_timer.cancel()
            server, self.server = self.server, None
            self.token = self.lease = ''
            self.commands.clear()
        if server:
            server.shutdown()
            server.server_close()
        return {'enabled': False}
