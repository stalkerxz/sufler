"""Small, bounded in-memory speech sessions. Audio is never written to disk."""
import json
import secrets
import threading
import time


class LocalEngine:
    def __init__(self, model_path):
        self.token = secrets.token_urlsafe(32)
        self.sessions = {}
        self.lock = threading.Lock()
        self.model = None
        self.error = ''
        try:
            from vosk import Model, KaldiRecognizer, SetLogLevel
            SetLogLevel(-1)
            if not (model_path / 'am' / 'final.mdl').is_file():
                raise RuntimeError('Русская модель не подготовлена.')
            self.model = Model(str(model_path))
            self.Recognizer = KaldiRecognizer
        except Exception as error:
            self.error = f'Локальное распознавание не готово: {error}. Запустите «Запустить локально.command».'

    def status(self):
        return {'engine': 'vosk', 'ready': self.model is not None, 'language': 'ru-RU', 'token': self.token, 'error': self.error}

    def start(self, lang):
        if self.model is None:
            raise ValueError(self.error)
        if lang != 'ru-RU':
            raise ValueError('Локальная модель поддерживает русский язык.')
        with self.lock:
            now = time.monotonic()
            for key in list(self.sessions):
                if now - self.sessions[key]['used'] > 60:
                    del self.sessions[key]
            if len(self.sessions) >= 4:
                raise ValueError('Уже открыто несколько сеансов. Закройте лишние вкладки и попробуйте через минуту.')
            key = secrets.token_urlsafe(24)
            self.sessions[key] = {'rec': self.Recognizer(self.model, 16000), 'utterance': 0, 'used': now, 'lock': threading.Lock()}
            return {'session': key, 'sampleRate': 16000}

    def audio(self, key, data):
        if not data or len(data) % 2:
            raise ValueError('Ожидается звук PCM16 mono 16000 Hz.')
        with self.lock:
            session = self.sessions.get(key)
        if session is None:
            raise ValueError('Сеанс завершён. Нажмите «Продолжить».')
        with session['lock']:
            session['used'] = time.monotonic()
            final = bool(session['rec'].AcceptWaveform(data))
            result = json.loads(session['rec'].Result() if final else session['rec'].PartialResult())
            response = {'text': result.get('text' if final else 'partial', ''), 'isFinal': final, 'utterance': session['utterance']}
            if final:
                session['utterance'] += 1
            return response

    def stop(self, key):
        with self.lock:
            self.sessions.pop(key, None)
        return {'stopped': True}
