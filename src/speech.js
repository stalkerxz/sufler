const messages = {
  'not-allowed': 'Нет доступа к микрофону. Разрешите его в настройках сайта и нажмите «Продолжить».',
  'service-not-allowed': 'Сервис распознавания недоступен в этом браузере. Попробуйте Chrome или режим «По скорости».',
  'audio-capture': 'Микрофон не найден или занят другим приложением. Проверьте подключение.',
  'network': 'Сервис распознавания недоступен. Проверьте интернет или выберите «По скорости».',
  'language-not-supported': 'Этот язык недоступен в сервисе распознавания. Выберите другой язык.',
};

/** One controller owns one recognition instance. No microphone at construction. */
export class SpeechFollower {
  constructor({ Recognition, onTranscript, onState, onError, schedule = (fn, delay) => setTimeout(fn, delay), cancel = id => clearTimeout(id) }) {
    Object.assign(this, { Recognition, onTranscript, onState, onError, schedule, cancel });
    this.active = false;
    this.generation = 0;
    this.restarts = 0;
    this.connectionSerial = 0;
  }

  start(lang) {
    this.stop();
    if (!this.Recognition) { this.onError('Голосовой режим недоступен. Откройте приложение в Chrome или выберите «По скорости».'); return; }
    this.active = true;
    this.lang = lang;
    this.restarts = 0;
    this.connect(this.generation);
  }

  connect(generation) {
    if (!this.active || generation !== this.generation) return;
    let recognition;
    try {
      recognition = new this.Recognition();
      recognition.lang = this.lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
    } catch {
      this.stop();
      this.onError('Браузер не смог создать сервис распознавания. Попробуйте Chrome или режим «По скорости».');
      return;
    }
    const connectionId = ++this.connectionSerial;
    this.recognition = recognition;
    const current = () => this.active && generation === this.generation && this.recognition === recognition;
    const finalized = new Set();
    recognition.onstart = () => { if (current()) { this.cancel(this.connectionTimer); this.connectionTimer = undefined; this.onState('listening'); } };
    recognition.onresult = event => {
      if (!current()) return;
      this.restarts = 0;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (finalized.has(i)) continue;
        const result = event.results[i];
        this.onTranscript(result[0].transcript, { id: `${generation}:${connectionId}:${i}`, isFinal: result.isFinal });
        if (result.isFinal) finalized.add(i);
        if (!current()) break;
      }
    };
    recognition.onerror = event => {
      if (!current() || event.error === 'aborted' || event.error === 'no-speech') return;
      const message = messages[event.error] || 'Не удалось распознать речь. Попробуйте ещё раз или выберите «По скорости».';
      this.stop();
      this.onError(message, { code: event.error });
    };
    recognition.onend = () => {
      if (!current()) return;
      this.cancel(this.connectionTimer); this.connectionTimer = undefined;
      if (++this.restarts > 5) {
        this.stop();
        this.onError('Браузер завершает распознавание без результата. Проверьте микрофон и интернет, затем продолжите.');
        return;
      }
      this.onState('reconnecting');
      this.timer = this.schedule(() => this.connect(generation), Math.min(1600, 300 * this.restarts));
    };
    this.onState('starting');
    if (!current()) return;
    this.connectionTimer = this.schedule(() => {
      if (!current()) return;
      this.stop();
      this.onError('Распознавание не запустилось. Проверьте разрешение микрофона. Если открыт HTML-файл, попробуйте запуск через «Запустить локально.command» или выберите «По скорости».');
    }, 12000);
    try { recognition.start(); }
    catch { this.stop(); this.onError('Не удалось включить микрофон. Проверьте разрешения браузера.'); }
  }

  stop() {
    this.active = false;
    this.generation++;
    this.cancel(this.timer);
    this.cancel(this.connectionTimer);
    this.timer = undefined;
    this.connectionTimer = undefined;
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = recognition.onstart = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* already stopped */ }
    }
  }
}
