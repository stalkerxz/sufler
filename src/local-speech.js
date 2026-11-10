/** PCM conversion for a mono 16 kHz local recognizer. No audio is saved. */
export function encodePCM16(samples, inputRate, targetRate = 16000) {
  const ratio = inputRate / targetRate;
  const length = Math.floor(samples.length / ratio);
  const buffer = new ArrayBuffer(length * 2), view = new DataView(buffer);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let value = 0;
    for (let j = start; j < end; j++) value += samples[j];
    value = Math.max(-1, Math.min(1, value / (end - start)));
    view.setInt16(i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return buffer;
}

export class LocalSpeechFollower {
  constructor({ onTranscript, onState, onError, fetchImpl = globalThis.fetch?.bind(globalThis), mediaDevices = globalThis.navigator?.mediaDevices, AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext, WorkletNode = globalThis.AudioWorkletNode }) {
    Object.assign(this, { onTranscript, onState, onError, fetchImpl, mediaDevices, AudioContext, WorkletNode });
    this.generation = 0; this.active = false; this.queue = [];
  }

  async request(route, body, contentType = 'application/json') {
    const response = await this.fetchImpl(route, { method: 'POST', headers: { 'Content-Type': contentType, 'X-Sufler-Token': this.token }, body, signal: this.aborter.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Локальный движок недоступен. Перезапустите «Запустить локально.command».');
    return result;
  }

  async start(lang, capability) {
    this.stop();
    if (!this.mediaDevices?.getUserMedia || !this.AudioContext) {
      this.onError('Этот браузер не даёт доступ к аудио. Откройте локальный адрес в Chrome.', { code: 'audio-capture' }); return;
    }
    if (lang !== 'ru-RU' || !capability?.ready) {
      this.onError('Локальное распознавание сейчас доступно для русского языка. Запустите локальный комплект.', { code: 'local-engine' }); return;
    }
    this.active = true; const generation = this.generation;
    this.token = capability.token; this.aborter = new AbortController();
    const current = () => this.active && generation === this.generation;
    this.onState('starting');
    try {
      const session = await this.request('/api/speech/start', JSON.stringify({ lang }));
      if (!current()) return;
      this.session = session.session;
      const stream = await this.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const context = new this.AudioContext({ sampleRate: 16000 }); this.context = context;
      await context.resume(); if (!current()) return;
      const source = context.createMediaStreamSource(stream); this.source = source;
      const push = samples => {
        if (!current()) return;
        if (this.queue.length >= 20) { this.fail('Локальное распознавание не успевает обрабатывать звук. Поставлено на паузу; попробуйте закрыть тяжёлые приложения.', generation); return; }
        this.queue.push(encodePCM16(samples, context.sampleRate)); this.drain(generation);
      };
      if (context.audioWorklet && this.WorkletNode) {
        const code = `class SuflerCapture extends AudioWorkletProcessor {
          constructor(){ super(); this.parts=[]; this.size=0; }
          process(inputs){ const data=inputs[0]?.[0]; if(data){ this.parts.push(new Float32Array(data)); this.size+=data.length;
            if(this.size>=4096){ const frame=new Float32Array(this.size); let offset=0; for(const part of this.parts){ frame.set(part,offset); offset+=part.length; }
              this.port.postMessage(frame.buffer,[frame.buffer]); this.parts=[]; this.size=0; } } return true; }
        } registerProcessor('sufler-capture',SuflerCapture);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        if (!current()) return;
        const processor = new this.WorkletNode(context, 'sufler-capture'); this.processor = processor;
        processor.port.onmessage = event => push(new Float32Array(event.data));
      } else {
        const processor = context.createScriptProcessor(4096, 1, 1); this.processor = processor;
        processor.onaudioprocess = event => { event.outputBuffer?.getChannelData(0).fill(0); push(new Float32Array(event.inputBuffer.getChannelData(0))); };
      }
      source.connect(this.processor); this.processor.connect(context.destination);
      this.onState('listening-local');
    } catch (error) {
      if (!current()) return;
      const permission = error.name === 'NotAllowedError' || error.name === 'SecurityError';
      const capture = error.name === 'NotFoundError' || error.name === 'NotReadableError';
      this.stop();
      this.onError(permission ? 'Нет разрешения на микрофон. Разрешите доступ в браузере и настройках микрофона macOS, затем продолжите.' : capture ? 'Микрофон не найден или занят другим приложением.' : error.message || 'Локальное распознавание недоступно.', { code: permission ? 'not-allowed' : capture ? 'audio-capture' : 'local-engine' });
    }
  }

  async drain(generation) {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active && generation === this.generation && this.queue.length) {
        const result = await this.request(`/api/speech/audio?session=${encodeURIComponent(this.session)}`, this.queue.shift(), 'application/octet-stream');
        if (!this.active || generation !== this.generation) return;
        if (result.text) this.onTranscript(result.text, { id: `local:${generation}:${this.session}:${result.utterance}`, isFinal: result.isFinal });
      }
    } catch (error) { this.fail(error.message || 'Связь с локальным движком потеряна. Перезапустите локальный комплект.', generation); }
    finally { if (generation === this.generation) this.draining = false; }
  }

  fail(message, generation) {
    if (!this.active || generation !== this.generation) return;
    this.stop(); this.onError(message, { code: 'local-engine' });
  }

  stop() {
    this.active = false; this.generation++; this.aborter?.abort(); this.queue = []; this.draining = false;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      if (this.processor.port) this.processor.port.onmessage = null;
      try { this.processor.disconnect(); } catch {}
    }
    try { this.source?.disconnect(); } catch {}
    this.stream?.getTracks().forEach(track => track.stop());
    this.context?.close().catch(() => {});
    const session = this.session, token = this.token;
    this.session = null; this.stream = this.source = this.processor = this.context = null;
    if (session) this.fetchImpl(`/api/speech/stop?session=${encodeURIComponent(session)}`, { method: 'POST', headers: { 'X-Sufler-Token': token }, body: '', keepalive: true }).catch(() => {});
  }
}
