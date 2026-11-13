import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from remote_control import RemoteControl

class RemoteTest(unittest.TestCase):
    def setUp(self):
        self.remote = RemoteControl()
        with patch('remote_control.lan_addresses', return_value=['127.0.0.1']):
            self.session = self.remote.enable()
        self.url = self.session['urls'][0].split('/#')[0]
        self.client = build_opener(ProxyHandler({}))

    def tearDown(self):
        self.remote.disable()

    def request(self, route, data, token=None, origin=None):
        headers = {'Content-Type': 'application/json', 'Origin': origin or self.url, 'X-Remote-Token': self.remote.token if token is None else token}
        req = Request(self.url + route, data=json.dumps(data).encode(), headers=headers)
        with self.client.open(req, timeout=3) as response:
            return json.load(response)

    def test_commands_are_authenticated_bounded_and_delivered_once(self):
        for token, origin in [('bad', None), (None, 'https://attacker.invalid')]:
            with self.assertRaises(HTTPError) as error:
                self.request('/command', {'action': 'start'}, token, origin)
            self.assertEqual(error.exception.code, 403)
        self.request('/command', {'action': 'start'})
        data = {'lease': self.session['lease'], 'state': {'running': False, 'text': 'private script'}}
        result = self.remote.poll(data)
        self.assertEqual(result['commands'][0]['action'], 'start')
        self.assertEqual(self.remote.poll(data)['commands'], [])
        self.assertNotIn('text', self.request('/state', {}))
        with self.assertRaises(HTTPError) as error:
            self.request('/command', {'action': 'execute'})
        self.assertEqual(error.exception.code, 400)

    def test_old_lease_expiry_stale_commands_and_disconnect(self):
        self.assertFalse(self.remote.poll({'lease': 'wrong'})['enabled'])
        self.request('/command', {'action': 'start'})
        self.remote.commands[0]['at'] -= 5
        self.assertEqual(self.remote.poll({'lease': self.session['lease']})['commands'], [])
        self.remote.last_host -= 10
        with self.assertRaises(HTTPError) as error:
            self.request('/command', {'action': 'start'})
        self.assertEqual(error.exception.code, 409)
        self.remote.expires = time.monotonic() - 1
        with self.assertRaises(HTTPError) as error:
            self.request('/state', {})
        self.assertEqual(error.exception.code, 403)
        self.remote.disable(self.session['lease'])
        self.assertIsNone(self.remote.server)
        self.assertEqual(self.remote.token, '')

if __name__ == '__main__':
    unittest.main()
