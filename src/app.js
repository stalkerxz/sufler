import { ScriptLibrary } from './library.js';
import { parseScript, followSpeech } from './alignment.js';
import { SpeechFollower } from './speech.js';
import { LocalSpeechFollower } from './local-speech.js';
import { readingLayout } from './reader-layout.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'sufler.settings.v1';
const SAMPLE = `Добро пожаловать в Суфлёр!
Говорите в своём темпе. Текст будет двигаться за вашим голосом. Если вы сделаете паузу, суфлёр подождёт вместе с вами.

Вставьте свой сценарий в поле слева. Настройте размер текста, выберите удобную ширину строки и начинайте читать.

Не торопитесь. Смотрите в камеру и говорите так, будто рассказываете историю другу. Здесь не нужно подстраиваться под скорость бегущей строки — она подстроится под вас.

Нужно начать с другой фразы? Просто нажмите на нужное слово. А для настоящего телесуфлёра включите зеркальный текст.

Всё готово. Вдохните, улыбнитесь — и начнём.`;
const defaults = { text: SAMPLE, title: 'Мой первый дубль', mode: 'voice', lang: 'ru-RU', fontSize: 44, lineHeight: 1.65, textWidth: 840, readingPosition: 38, speed: 130, countdown: 3, deviceId: '', customView: null, mirror: false, light: false };
let storageAvailable = true;
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return { ...defaults };
    const clamp = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    return {
      text: typeof saved.text === 'string' ? saved.text.slice(0, 100000) : defaults.text,
      title: typeof saved.title === 'string' ? saved.title.slice(0, 80) : defaults.title,
      mode: saved.mode === 'speed' ? 'speed' : 'voice',
      lang: ['ru-RU', 'en-US', 'uk-UA'].includes(saved.lang) ? saved.lang : 'ru-RU',
      fontSize: clamp(saved.fontSize, 24, 80, 44), lineHeight: clamp(saved.lineHeight, 1.25, 2.05, 1.65),
      textWidth: clamp(saved.textWidth, 240, 1100, 840), speed: clamp(saved.speed, 40, 260, 130),
      readingPosition: clamp(saved.readingPosition, 10, 80, 38),
      countdown: [0,3,5,10].includes(saved.countdown) ? saved.countdown : 3, deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : '', customView: saved.customView && typeof saved.customView === 'object' ? { readingPosition: clamp(saved.customView.readingPosition,10,80,38), textWidth: clamp(saved.customView.textWidth,240,1100,840), fontSize: clamp(saved.customView.fontSize,24,80,44), lineHeight: clamp(saved.customView.lineHeight,1.25,2.05,1.65) } : null,
      mirror: saved.mirror === true, light: saved.light === true,
    };
  } catch { storageAvailable = false; return { ...defaults }; }
}
const settings = loadSettings();
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let parsed, wordElements = [], cursor = 0, running = false, started = false, elapsedMs = 0;
let lastFrame = 0, speedAccumulator = 0, speechReady = false, saveTimer, editTimer;
let desiredScroll = 0, following = true, wakeLock, wakeGeneration = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const resultAnchors = new Map();

function save() {
  clearTimeout(saveTimer);
  $('save-status').textContent = 'Сохранение…';
  saveTimer = setTimeout(() => {
    try { persistScript(); localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); storageAvailable = true; refreshLibrary(); $('save-status').textContent = 'Сохранено в этом браузере'; }
    catch { storageAvailable = false; $('save-status').textContent = 'Хранилище недоступно — скачайте текст'; }
  }, 250);
}
function showMessage(text) { $('message-text').textContent = text; $('message').hidden = false; }
function hideMessage() { $('message').hidden = true; }
function setStatus(state, text) { $('reading-status').dataset.state = state; $('reading-status').lastElementChild.textContent = text; }
function wordLabel(n) { const a = n % 10, b = n % 100; return `${n} ${a === 1 && b !== 11 ? 'слово' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'слова' : 'слов'}`; }

function renderScript() {
  parsed = parseScript(settings.text);
  const fragment = document.createDocumentFragment();
  wordElements = [];
  for (const paragraph of parsed.paragraphs) {
    const p = document.createElement('p');
    for (const part of paragraph) {
      if (part.direction) { const note = document.createElement('span'); note.className = 'stage-direction'; note.textContent = part.text; p.append(note); }
      else if (part.index === undefined) p.append(document.createTextNode(part.text));
      else {
        const span = document.createElement('span');
        span.className = 'word'; span.dataset.index = part.index; span.textContent = part.text;
        wordElements.push(span); p.append(span);
      }
    }
    fragment.append(p);
  }
  $('reading-text').replaceChildren(fragment);
  $('word-count').textContent = wordLabel(parsed.words.length);
  $('empty-state').hidden = !!parsed.words.length;
  document.querySelector('.reading-guide').hidden = !parsed.words.length;
  reset();
}

function updateCursor(next, instant = false) {
  const previous = cursor;
  cursor = Math.max(0, Math.min(parsed.words.length, next));
  for (let i = Math.max(0, Math.min(previous, cursor) - 1); i <= Math.min(wordElements.length - 1, Math.max(previous, cursor)); i++) {
    wordElements[i].classList.toggle('past', i < cursor);
    wordElements[i].classList.toggle('current', i === cursor);
    if (i === cursor) wordElements[i].setAttribute('aria-current', 'true');
    else wordElements[i].removeAttribute('aria-current');
  }
  const percent = parsed.words.length ? Math.round(cursor / parsed.words.length * 100) : 0;
  $('reading-progress').value = percent;
  $('progress-label').textContent = `${percent}%`;
  $('start-button').disabled = !parsed.words.length;
  alignWord(instant);
  if (running && cursor === parsed.words.length) complete();
}

function alignWord(instant = false) {
  const word = wordElements[Math.min(cursor, wordElements.length - 1)];
  if (!word || !following) return;
  const box = word.getBoundingClientRect();
  const viewport = $('reader-scroll').getBoundingClientRect();
  desiredScroll = $('reader-scroll').scrollTop + box.top - viewport.top + box.height / 2 - getReaderLayout().guideY;
  desiredScroll = Math.max(0, Math.min(desiredScroll, $('reader-scroll').scrollHeight - $('reader-scroll').clientHeight));
  if (instant || reducedMotion) $('reader-scroll').scrollTop = desiredScroll;
}
function getReaderLayout() {
  return readingLayout({ height: $('reader-stage').clientHeight, position: settings.readingPosition,
    fontSize: parseFloat(getComputedStyle($('reading-text')).fontSize) || settings.fontSize, lineHeight: settings.lineHeight });
}
function layoutReader() {
  const stage = $('reader-stage'), layout = getReaderLayout();
  // The first word sits on the same reading line as every subsequent word.
  $('reading-text').style.setProperty('--reader-top', `${layout.paddingTop}px`);
  $('reading-text').style.setProperty('--reader-bottom', `${layout.paddingBottom}px`);
  stage.style.setProperty('--guide-position', `${layout.guideY}px`);
  stage.style.setProperty('--fade-top', `${layout.fadeTop}px`);
  stage.style.setProperty('--fade-bottom', `${layout.fadeBottom}px`);
  const inset = $('reading-text').getBoundingClientRect().left - stage.getBoundingClientRect().left;
  stage.style.setProperty('--guide-left', `${Math.max(12, inset - 36)}px`);
  alignWord(true);
}

let localCapability = null;
const speechCallbacks = {
  onTranscript(text, result) {
    $('heard-preview').textContent = `«${text.trim()}»`;
    if (!resultAnchors.has(result.id)) resultAnchors.set(result.id, cursor);
    const next = followSpeech(parsed.words, text, cursor, resultAnchors.get(result.id));
    if (resultAnchors.size > 100) resultAnchors.delete(resultAnchors.keys().next().value);
    if (next > cursor) { following = true; updateCursor(next); }
  },
  onState(state) {
    speechReady = state === 'listening' || state === 'listening-local';
    const labels = { starting: 'Включаем микрофон…', listening: 'Слушаю ваш голос', 'listening-local': 'Слушаю · на устройстве', reconnecting: 'Возобновляем микрофон…' };
    setStatus(state, labels[state]);
  },
  onError(message, detail = {}) {
    pause();
    const capture = ['not-allowed', 'audio-capture'].includes(detail.code);
    setStatus('error', capture ? 'Нет доступа к микрофону' : 'Распознавание недоступно');
    if (detail.code === 'network') message = location.protocol === 'file:'
      ? 'Браузер не смог подключиться к сервису распознавания. Это не подтверждает поломку микрофона. Для русского языка используйте «Запустить локально.command» из обновлённого комплекта: он включает распознавание на устройстве.'
      : 'Сервис распознавания браузера недоступен по сети. Откройте обновлённый локальный комплект для распознавания русского на устройстве или выберите «По скорости».';
    showMessage(message);
  },
};
const browserSpeech = new SpeechFollower({ Recognition, ...speechCallbacks });
const localSpeech = new LocalSpeechFollower(speechCallbacks);
let speech = browserSpeech;

async function keepAwake() {
  const generation = ++wakeGeneration;
  try { if ('wakeLock' in navigator) { const lock = await navigator.wakeLock.request('screen'); if (!running || generation !== wakeGeneration) await lock.release(); else wakeLock = lock; } } catch { /* optional enhancement */ }
}
function releaseWakeLock() { wakeGeneration++; if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
function updateButton() {
  document.body.classList.toggle('paused', !running);
  $('shoot-pause').textContent = running ? 'Пауза' : countdownTimer ? 'Отменить отсчёт' : 'Продолжить';
  if (countdownTimer) { $('start-button').lastElementChild.textContent = 'Отменить отсчёт'; return; }
  const icon = running ? '<path d="M8 5v14M16 5v14"/>' : settings.mode === 'voice' ? '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3"/>' : '<path d="m8 4 12 8-12 8z"/>';
  $('start-icon').innerHTML = icon;
  $('start-button').lastElementChild.textContent = running ? 'Пауза' : cursor >= parsed.words.length && parsed.words.length ? 'Ещё один дубль' : started ? 'Продолжить' : 'Начать чтение';
  $('start-button').setAttribute('aria-pressed', String(running));
}
function startNow() {
  stopChecks();
  // Commit a pending text edit before using the parsed script.
  if (editTimer) { clearTimeout(editTimer); editTimer = null; renderScript(); }
  if (!parsed.words.length) { showMessage('Добавьте текст сценария, чтобы начать чтение.'); return; }
  if (settings.mode === 'voice' && (!(localCapability?.ready && settings.lang === 'ru-RU') && !Recognition || !window.isSecureContext)) {
    setStatus('error', 'Голосовой режим недоступен'); updateButton();
    showMessage(!window.isSecureContext ? 'Для микрофона откройте сайт через HTTPS или localhost. Можно также выбрать «По скорости».' : 'В этом браузере нет распознавания речи. Откройте в Chrome или выберите «По скорости».');
    return;
  }
  if (cursor >= parsed.words.length) reset();
  hideMessage();
  following = true; alignWord();
  running = true; started = true; lastFrame = performance.now();
  if (settings.mode === 'voice') { speechReady = false; resultAnchors.clear(); speech.stop(); speech = localCapability?.ready && settings.lang === 'ru-RU' ? localSpeech : browserSpeech; speech.start(settings.lang, { ...localCapability, deviceId: settings.deviceId }); }
  else { speechReady = false; setStatus('listening', 'Чтение по скорости'); }
  updateButton();
  if (running) keepAwake();
  closeDrawer();
}
function pause() {
  cancelCountdown(); stopChecks();
  running = false; speechReady = false; speech.stop(); releaseWakeLock();
  if (started) setStatus('paused', 'На паузе');
  updateButton();
}
function complete() { pause(); setStatus('complete', 'Дубль завершён'); $('heard-preview').textContent = 'Отлично. Текст прочитан.'; updateButton(); }
function reset() {
  pause(); started = false; elapsedMs = 0; speedAccumulator = 0; following = true;
  $('elapsed').textContent = '00:00'; $('heard-preview').textContent = '';
  updateCursor(0, true); setStatus('ready', 'Готов к чтению'); updateButton();
}
function toggleReading() { running || countdownTimer ? pause() : start(); }
function animationFrame(now) {
  const dt = Math.min(100, Math.max(0, now - (lastFrame || now))); lastFrame = now;
  if (running && (settings.mode === 'speed' || speechReady)) {
    elapsedMs += dt;
    const seconds = Math.floor(elapsedMs / 1000);
    $('elapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (settings.mode === 'speed') {
      speedAccumulator += dt / 60000 * settings.speed;
      if (speedAccumulator >= 1) { const count = Math.floor(speedAccumulator); speedAccumulator -= count; following = true; updateCursor(cursor + count); }
    }
  }
  if (following) {
    const scroll = $('reader-scroll');
    const delta = desiredScroll - scroll.scrollTop;
    if (Math.abs(delta) > .5) scroll.scrollTop += delta * (reducedMotion ? 1 : Math.min(1, dt / 110));
  }
  requestAnimationFrame(animationFrame);
}

function setMode(mode) {
  pause(); settings.mode = mode; speedAccumulator = 0;
  $('voice-mode').classList.toggle('selected', mode === 'voice'); $('voice-mode').setAttribute('aria-pressed', String(mode === 'voice'));
  $('speed-mode').classList.toggle('selected', mode === 'speed'); $('speed-mode').setAttribute('aria-pressed', String(mode === 'speed'));
  $('voice-settings').hidden = mode !== 'voice'; $('speed-settings').hidden = mode !== 'speed';
  updateButton(); save();
}
function applyView() {
  const style = document.documentElement.style;
  style.setProperty('--font-size', `${settings.fontSize}px`); style.setProperty('--line-height', settings.lineHeight); style.setProperty('--text-width', `${settings.textWidth}px`);
  document.body.classList.toggle('light-theme', settings.light); $('reader-stage').classList.toggle('mirrored', settings.mirror);
  $('font-size').value = settings.fontSize; $('font-output').value = `${settings.fontSize} px`;
  $('line-height').value = settings.lineHeight; $('line-output').value = settings.lineHeight.toFixed(2);
  $('text-width').value = settings.textWidth; $('width-output').value = `${settings.textWidth} px`;
  document.querySelector('.reading-guide').setAttribute('aria-valuenow', settings.readingPosition);
  $('reading-position').value = settings.readingPosition; $('position-output').value = `${settings.readingPosition}%`;
  $('reading-speed').value = settings.speed; $('speed-output').value = `${settings.speed} слов/мин`;
  $('mirror-toggle').checked = settings.mirror; $('light-toggle').checked = settings.light;
  $('mirror-button').setAttribute('aria-pressed', String(settings.mirror));
  requestAnimationFrame(layoutReader);
}
function setTab(name) {
  for (const tab of ['text', 'view']) {
    const active = tab === name; $(tab + '-tab').setAttribute('aria-selected', String(active));
    $(tab + '-tab').classList.toggle('selected', active); $(tab + '-tab').tabIndex = active ? 0 : -1; $(tab + '-panel').hidden = !active;
  }
}
function closeDrawer() {
  document.body.classList.remove('drawer-open'); $('drawer-backdrop').hidden = true;
  $('toggle-sidebar').setAttribute('aria-expanded', String(innerWidth > 850 && !document.body.classList.contains('sidebar-hidden')));
  updateSidebarAccessibility();
}
function updateSidebarAccessibility() {
  const mobile = innerWidth <= 850, open = document.body.classList.contains('drawer-open');
  if (mobile && open) { $('sidebar').setAttribute('role', 'dialog'); $('sidebar').setAttribute('aria-modal', 'true'); }
  else { $('sidebar').removeAttribute('role'); $('sidebar').removeAttribute('aria-modal'); }
  $('toggle-sidebar').setAttribute('aria-label', mobile ? (open ? 'Закрыть настройки' : 'Открыть настройки') : document.body.classList.contains('sidebar-hidden') ? 'Показать настройки' : 'Скрыть настройки');
}
function toggleSidebar() {
  if (innerWidth <= 850) {
    const open = !document.body.classList.contains('drawer-open');
    document.body.classList.toggle('drawer-open', open); $('drawer-backdrop').hidden = !open;
    $('toggle-sidebar').setAttribute('aria-expanded', String(open));
    updateSidebarAccessibility(); if (open) $('close-sidebar').focus();
  } else {
    document.body.classList.toggle('sidebar-hidden');
    $('toggle-sidebar').setAttribute('aria-expanded', String(!document.body.classList.contains('sidebar-hidden')));
    updateSidebarAccessibility(); requestAnimationFrame(layoutReader);
  }
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else { if (innerWidth <= 850) closeDrawer(); else document.body.classList.add('sidebar-hidden'); showMessage('Полный экран недоступен в этом браузере. Настройки скрыты для чтения.'); }
  } catch { showMessage('Браузер не разрешил полноэкранный режим. Можно скрыть настройки кнопкой слева вверху.'); }
}
function seekLine(direction) {
  const current = wordElements[Math.min(cursor, wordElements.length - 1)];
  if (!current) return;
  const y = current.offsetTop;
  let next = Math.min(cursor, wordElements.length - 1);
  if (direction > 0) { while (next < wordElements.length - 1 && wordElements[next].offsetTop <= y + 1) next++; }
  else { next = Math.max(0, next - 1); while (next > 0 && wordElements[next].offsetTop >= y - 1) next--; const previousY = wordElements[next].offsetTop; while (next > 0 && wordElements[next - 1].offsetTop === previousY) next--; }
  seek(next);
}
function seek(next) {
  const resume = running; if (resume) pause(); following = true; speedAccumulator = 0;
  updateCursor(next); if (!running && cursor < parsed.words.length) setStatus(started ? 'paused' : 'ready', started ? 'На паузе' : 'Готов к чтению');
  $('heard-preview').textContent = ''; updateButton(); if (resume) startNow();
}

let countdownTimer = null, shooting = false, library = null;
let checkGeneration = 0, checkStream, checkContext, checkFrame, checkTimeout, checkFollower;
let remoteTimer, remoteBusy = false, remoteEnabled = false, remoteLease = '', remoteLastId = 0;
function persistScript(force = false) {
  if (library) library.update(settings.title, settings.text, $('script-folder').value, force);
}
function refreshLibrary() {
  if (!library) return;
  const query = $('library-search').value.toLocaleLowerCase(), filter = $('library-folder-filter').value;
  const fill = (id, items, empty) => {
    const select = $(id); select.replaceChildren();
    for (const [value, title] of items) select.add(new Option(title, value));
    if (!items.length) select.add(new Option(empty, ''));
  };
  fill('library-folder-filter', [['','Все папки'], ...[...new Set(library.data.scripts.filter(s => !s.deleted).map(s => s.folder).filter(Boolean))].sort().map(f => [f,f])], 'Все папки');
  $('library-folder-filter').value = filter;
  fill('library-list', library.data.scripts.filter(s => !s.deleted && (!filter || s.folder === filter) && `${s.title} ${s.text}`.toLocaleLowerCase().includes(query)).map(s => [s.id, `${s.folder ? s.folder + ' / ' : ''}${s.title || 'Без названия'}`]), 'Нет сценариев');
  $('library-list').value = library.data.active;
  fill('revision-list', (library.current()?.revisions || []).map((r,i) => [String(i), `${new Date(r.at).toLocaleString('ru-RU')} — ${r.title}`]).reverse(), 'Нет предыдущих версий');
  $('revision-restore').disabled = !library.current()?.revisions.length;
  fill('trash-list', library.data.scripts.filter(s => s.deleted).map(s => [s.id,s.title || 'Без названия']), 'Корзина пуста');
}
function libraryAction(action) {
  try { action(); refreshLibrary(); }
  catch (error) { showMessage(`Библиотека: ${error.message}. Текущий текст можно скачать кнопкой экспорта.`); }
}
function loadScript(script) {
  if (!script) return;
  clearTimeout(editTimer); editTimer = null; clearTimeout(saveTimer); pause();
  settings.text = script.text; settings.title = script.title;
  $('script-editor').value = settings.text; $('script-title').value = settings.title; $('script-folder').value = script.folder || '';
  renderScript(); layoutReader(); save(); refreshLibrary();
}
function downloadJSON(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function cancelCountdown() {
  clearInterval(countdownTimer); countdownTimer = null; $('countdown-overlay').hidden = true;
}
function start() {
  if (editTimer) { clearTimeout(editTimer); editTimer = null; renderScript(); }
  if (!parsed.words.length) { showMessage('Добавьте текст сценария.'); return; }
  stopChecks(); cancelCountdown();
  if (!settings.countdown) { startNow(); return; }
  closeDrawer(); let remaining = settings.countdown;
  $('countdown-overlay').textContent = remaining; $('countdown-overlay').hidden = false;
  setStatus('starting', 'Подготовьтесь к чтению');
  countdownTimer = setInterval(() => {
    remaining--;
    if (!remaining) { cancelCountdown(); startNow(); }
    else $('countdown-overlay').textContent = remaining;
  }, 1000);
  updateButton();
}
function paragraphStart(direction = 0) {
  const starts = parsed.paragraphs.map(p => p.find(part => part.index !== undefined)?.index).filter(i => i !== undefined);
  if (!starts.length) return 0;
  const position = Math.min(cursor, parsed.words.length - 1);
  let index = starts.findLastIndex(start => start <= position);
  return starts[Math.max(0, Math.min(starts.length - 1, index + direction))];
}
function retake() { pause(); seek(paragraphStart()); start(); }
function setShooting(value) {
  shooting = value; closeDrawer(); document.body.classList.toggle('shooting', value);
  $('shoot-button').setAttribute('aria-pressed', String(value)); $('shoot-exit').hidden = !value;
  requestAnimationFrame(layoutReader); if (value) $('reader-stage').focus(); else $('shoot-button').focus();
}
function stopChecks() {
  checkGeneration++; cancelAnimationFrame(checkFrame); clearTimeout(checkTimeout);
  checkFollower?.stop(); checkFollower = null;
  checkStream?.getTracks().forEach(track => track.stop()); checkStream = null;
  checkContext?.close().catch(() => {}); checkContext = null; $('mic-level').value = 0;
}
function microphoneError(error) {
  return error.name === 'NotAllowedError' ? 'Нет разрешения на микрофон. Разрешите доступ в браузере и настройках системы.' : error.name === 'NotFoundError' || error.name === 'OverconstrainedError' ? 'Выбранный микрофон не найден. Выберите другой вход.' : error.name === 'NotReadableError' ? 'Не удалось открыть микрофон. Возможно, он занят другим приложением.' : `Проверка не удалась: ${error.message}`;
}
async function listMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  $('microphone-select').replaceChildren(new Option('Системный по умолчанию', ''));
  inputs.filter(d => d.deviceId !== 'default').forEach((d,i) => $('microphone-select').add(new Option(d.label || `Микрофон ${i+1}`, d.deviceId)));
  if (settings.deviceId && !inputs.some(d => d.deviceId === settings.deviceId)) $('microphone-select').add(new Option('Выбранный вход недоступен — выберите другой',settings.deviceId));
  $('microphone-select').value = settings.deviceId;
}
async function checkMicrophone() {
  pause(); const generation = checkGeneration;
  $('check-result').textContent = 'Запрашиваем микрофон…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Микрофон доступен через HTTPS или localhost.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: settings.deviceId ? { deviceId: { exact: settings.deviceId } } : true });
    if (generation !== checkGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    checkStream = stream;
    stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => { if (generation === checkGeneration) { stopChecks(); $('check-result').textContent = 'Микрофон отключён.'; } }));
    const Context = window.AudioContext || window.webkitAudioContext; checkContext = new Context(); await checkContext.resume();
    if (generation !== checkGeneration) return;
    const analyser = checkContext.createAnalyser(); analyser.fftSize = 1024;
    checkContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize); let peak = 0;
    const tick = () => {
      if (generation !== checkGeneration) return;
      analyser.getFloatTimeDomainData(samples);
      const level = Math.sqrt(samples.reduce((sum,v) => sum + v*v,0) / samples.length);
      peak = Math.max(peak,level); $('mic-level').value = Math.min(1, level * 5);
      checkFrame = requestAnimationFrame(tick);
    }; tick(); await listMicrophones();
    if (generation !== checkGeneration) return;
    $('check-result').textContent = 'Скажите фразу. Проверка уровня длится 10 секунд.';
    checkTimeout = setTimeout(() => { stopChecks(); $('check-result').textContent = peak > .005 ? 'Звуковой сигнал получен. Теперь можно отдельно проверить распознавание речи.' : 'Микрофон открыт, но сигнал очень тихий. Проверьте вход и громкость.'; }, 10000);
  } catch (error) { if (generation === checkGeneration) { stopChecks(); $('check-result').textContent = microphoneError(error); } }
}
function checkSpeech() {
  pause(); const generation = checkGeneration; let heard = false;
  const callbacks = {
    onTranscript(text) { if (generation !== checkGeneration) return; heard = true; $('check-result').textContent = `Распознано: «${text}»`; },
    onState() { if (!heard && generation === checkGeneration) $('check-result').textContent = 'Скажите короткую фразу. Проверка длится до 12 секунд.'; },
    onError(message) { if (generation === checkGeneration) { stopChecks(); $('check-result').textContent = message; } },
  };
  checkFollower = localCapability?.ready && settings.lang === 'ru-RU' ? new LocalSpeechFollower(callbacks) : new SpeechFollower({ Recognition, ...callbacks });
  checkFollower.start(settings.lang, { ...localCapability, deviceId: settings.deviceId });
  if (generation === checkGeneration) checkTimeout = setTimeout(() => { stopChecks(); if (!heard) $('check-result').textContent = 'За 12 секунд речь не распознана. Проверьте уровень микрофона и доступность сервиса.'; }, 12000);
}
async function remoteRequest(action, body = {}) {
  if (!localCapability?.token) throw new Error('Откройте обновлённый локальный комплект: пульт доступен при запуске через localhost.');
  const response = await fetch(`/api/remote/${action}`, { method:'POST', headers:{'Content-Type':'application/json','X-Sufler-Token':localCapability.token}, body:JSON.stringify(body), signal:AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('Пульт недоступен. Перезапустите обновлённый локальный комплект.');
  return response.json();
}
function remoteState() { return { running, countdown:!!countdownTimer, progress:parsed.words.length ? Math.round(cursor/parsed.words.length*100) : 0, speed:settings.speed, mode:settings.mode }; }
async function pollRemote() {
  if (remoteBusy || !remoteEnabled) return; remoteBusy = true;
  try {
    const result = await remoteRequest('poll', { lease:remoteLease, state:remoteState() });
    if (!remoteEnabled) return;
    if (!result.enabled) { remoteEnabled = false; clearInterval(remoteTimer); $('remote-status').textContent = 'Пульт отключён или срок сессии истёк.'; $('remote-disable').hidden = true; return; }
    $('remote-status').textContent = result.connected ? 'Телефон подключён' : 'Ожидаем телефон…';
    if (document.hidden) return;
    for (const item of result.commands || []) {
      if (item.id <= remoteLastId) continue; remoteLastId = item.id;
      if (item.action === 'start' && !running && !countdownTimer) start();
      else if (item.action === 'pause') pause();
      else if (item.action === 'retake') retake();
      else if (item.action === 'previous') seek(paragraphStart(-1));
      else if (item.action === 'next') seek(paragraphStart(1));
      else if (item.action === 'slower' || item.action === 'faster') { settings.speed = Math.max(40,Math.min(260,settings.speed + (item.action === 'faster' ? 5 : -5))); applyView(); save(); }
    }
  } catch (error) { pause(); $('remote-status').textContent = 'Связь с пультом потеряна. Чтение на паузе. ' + error.message; }
  finally { remoteBusy = false; }
}
function setupStudio() {
  try { library = new ScriptLibrary(localStorage, settings); const s = library.current(); settings.text = s.text; settings.title = s.title; $('script-editor').value=s.text; $('script-title').value=s.title; $('script-folder').value=s.folder || ''; refreshLibrary(); }
  catch { showMessage('Библиотека недоступна. Текущий текст сохранён отдельно; скачайте его перед закрытием.'); document.querySelectorAll('.library button').forEach(b => b.disabled = true); }
  $('library-search').oninput = refreshLibrary; $('library-folder-filter').onchange = refreshLibrary;
  $('library-list').onchange = () => libraryAction(() => { persistScript(true); loadScript(library.select($('library-list').value)); });
  $('script-folder').oninput = () => save();
  $('script-new').onclick = () => libraryAction(() => { persistScript(true); loadScript(library.create()); });
  $('script-copy').onclick = () => libraryAction(() => { persistScript(true); loadScript(library.create((settings.title + ' — копия').slice(0,80), settings.text)); });
  $('script-archive').onclick = () => libraryAction(() => { persistScript(true); const oldId = library.data.active; const next = library.data.scripts.find(s => !s.deleted && s.id !== oldId) || library.create(); library.archive(oldId); loadScript(library.select(next.id)); });
  $('script-recover').onclick = () => libraryAction(() => library.recover($('trash-list').value));
  $('script-purge').onclick = () => libraryAction(() => { const id=$('trash-list').value; if (id && confirm('Удалить этот сценарий и все его версии навсегда?')) { library.data.scripts=library.data.scripts.filter(s=>s.id!==id); library.persist(); } });
  $('revision-restore').onclick = () => libraryAction(() => { const revision=library.current()?.revisions[Number($('revision-list').value)]; if (!revision) return; persistScript(true); library.update(revision.title,revision.text,$('script-folder').value,true); loadScript(library.current()); });
  $('library-export').onclick = () => libraryAction(() => { persistScript(true); downloadJSON(library.data,'sufler-library.json'); });
  $('library-import').onclick = () => $('library-file').click();
  $('library-file').onchange = async event => {
    const file=event.target.files[0]; event.target.value=''; if(!file) return;
    try {
      if(file.size>10000000) throw new Error('Файл больше 10 МБ');
      const data=JSON.parse(await file.text());
      if(!Array.isArray(data.scripts) || !data.scripts.length || data.scripts.length>100 || data.scripts.some(s=>typeof s.text!=='string'||s.text.length>100000||typeof s.title!=='string'||s.title.length>80||typeof s.id!=='string')) throw new Error('Неверный формат библиотеки');
      if(!confirm('Заменить библиотеку резервной копией? Перед заменой автоматически скачается текущая библиотека.')) return;
      persistScript(true); downloadJSON(library.data,'sufler-library-before-restore.json');
      const sanitized={active:data.active,scripts:data.scripts.map(s=>({id:crypto.randomUUID(),title:s.title,text:s.text,folder:typeof s.folder==='string'?s.folder.slice(0,60):'',deleted:s.deleted===true,updated:Date.now(),revisions:Array.isArray(s.revisions)?s.revisions.filter(r=>r&&typeof r.text==='string'&&r.text.length<=100000&&typeof r.title==='string'&&r.title.length<=80&&Number.isFinite(r.at)).slice(-12).map(r=>({text:r.text,title:r.title,at:r.at})):[]}))};
      sanitized.active=sanitized.scripts.find(s=>!s.deleted)?.id || '';
      if(!sanitized.active) { sanitized.scripts[0].deleted=false; sanitized.active=sanitized.scripts[0].id; }
      localStorage.setItem(library.key,JSON.stringify(sanitized)); library=new ScriptLibrary(localStorage,settings); loadScript(library.current());
    } catch(error) { showMessage(`Не удалось восстановить библиотеку: ${error.message}`); }
  };
  document.querySelector('.library').ontoggle = refreshLibrary;
  $('countdown-seconds').value = settings.countdown;
  $('countdown-seconds').onchange = event => { pause(); settings.countdown=Number(event.target.value); save(); };
  $('retake-button').onclick = retake; $('previous-paragraph').onclick = () => seek(paragraphStart(-1)); $('next-paragraph').onclick = () => seek(paragraphStart(1));
  $('shoot-pause').onclick = toggleReading;
  $('shoot-button').onclick = () => setShooting(!shooting); $('shoot-exit').onclick = () => { pause(); setShooting(false); };
  $('view-preset').onchange = event => {
    const presets = { camera:{readingPosition:15,textWidth:440}, center:{readingPosition:50,textWidth:840}, custom:settings.customView || {readingPosition:38,textWidth:840,fontSize:44,lineHeight:1.65} };
    Object.assign(settings,presets[event.target.value]); following=true; applyView(); save();
  };
  $('save-view-preset').onclick = () => { settings.customView=Object.fromEntries(['readingPosition','textWidth','fontSize','lineHeight'].map(k=>[k,settings[k]])); $('view-preset').value='custom'; save(); showMessage('Свой вариант области чтения сохранён.'); };
  const guide=document.querySelector('.reading-guide'); let dragging=false;
  const move=event=>{if(!dragging)return; const r=$('reader-stage').getBoundingClientRect(); settings.readingPosition=Math.round(Math.max(10,Math.min(80,(event.clientY-r.top)/r.height*100))); following=true; $('view-preset').value='custom'; applyView(); save();};
  guide.onpointerdown=event=>{event.preventDefault();dragging=true;guide.setPointerCapture(event.pointerId);move(event);}; guide.onpointermove=move; guide.onpointerup=()=>dragging=false; guide.onpointercancel=()=>dragging=false;
  guide.onkeydown=event=>{if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();settings.readingPosition=event.key==='Home'?10:event.key==='End'?80:Math.max(10,Math.min(80,settings.readingPosition+(event.key==='ArrowDown'?1:-1)));following=true;applyView();save();}};
  $('mic-check').onclick=checkMicrophone; $('speech-check').onclick=checkSpeech; $('check-stop').onclick=()=>{stopChecks();$('check-result').textContent='Проверка остановлена.';};
  $('microphone-select').onchange=event=>{pause();settings.deviceId=event.target.value;save();};
  listMicrophones().catch(()=>{}); navigator.mediaDevices?.addEventListener('devicechange',()=>listMicrophones().catch(()=>{}));
  $('remote-enable').onclick=async()=>{
    $('remote-enable').disabled=true;
    try {
      const result=await remoteRequest('enable'); remoteLease=result.lease; remoteLastId=0; remoteEnabled=true;
      $('remote-links').replaceChildren();
      for(const url of result.urls){const a=document.createElement('a');a.href=url;a.textContent=url;a.target='_blank';a.rel='noreferrer';$('remote-links').append(a);const copy=document.createElement('button');copy.className='outline-button';copy.textContent='Скопировать ссылку';copy.onclick=async()=>{try{await navigator.clipboard.writeText(url);copy.textContent='Ссылка скопирована';}catch{$('remote-status').textContent='Выделите ссылку и скопируйте вручную.';}};$('remote-links').append(copy);}
      $('remote-hint').textContent='Откройте одну из этих ссылок на телефоне в той же Wi-Fi сети. Ссылка даёт управление на 2 часа. Оставьте вкладку суфлёра открытой на компьютере.';
      $('remote-disable').hidden=false; clearInterval(remoteTimer); remoteTimer=setInterval(pollRemote,400); pollRemote();
    } catch(error){$('remote-status').textContent=error.message;}
    finally{$('remote-enable').disabled=false;}
  };
  $('remote-disable').onclick=async()=>{try{await remoteRequest('disable',{lease:remoteLease});remoteEnabled=false;clearInterval(remoteTimer);$('remote-links').replaceChildren();$('remote-disable').hidden=true;$('remote-status').textContent='Пульт отключён.';}catch(error){$('remote-status').textContent=error.message;}};
}

$('script-editor').value = settings.text; $('script-title').value = settings.title; $('language').value = settings.lang;
$('script-editor').addEventListener('beforeinput', event => { if (library && ['insertFromPaste','insertFromDrop','deleteByCut'].includes(event.inputType)) libraryAction(() => { persistScript(); library.checkpoint(); }); });
$('script-editor').addEventListener('input', () => {
  pause();
  if (library && Math.abs(settings.text.length - $('script-editor').value.length) > 20) libraryAction(() => { persistScript(); library.checkpoint(); });
  settings.text = $('script-editor').value; save();
  clearTimeout(editTimer); editTimer = setTimeout(() => { editTimer = null; renderScript(); layoutReader(); }, 180);
});
$('script-title').addEventListener('input', event => { settings.title = event.target.value; save(); });
$('start-button').addEventListener('click', toggleReading); $('reset-button').addEventListener('click', () => { hideMessage(); reset(); });
$('voice-mode').addEventListener('click', () => setMode('voice')); $('speed-mode').addEventListener('click', () => setMode('speed'));
$('language').addEventListener('change', event => { pause(); settings.lang = event.target.value; save(); });
for (const [id, key] of [['font-size','fontSize'],['line-height','lineHeight'],['text-width','textWidth'],['reading-position','readingPosition'],['reading-speed','speed']]) $(id).addEventListener('input', event => {
  settings[key] = Number(event.target.value);
  if (id === 'reading-position') following = true;
  if (id !== 'reading-speed') $('view-preset').value = 'custom';
  applyView(); save();
});
$('mirror-toggle').addEventListener('change', event => { settings.mirror = event.target.checked; applyView(); save(); });
$('light-toggle').addEventListener('change', event => { settings.light = event.target.checked; applyView(); save(); });
$('mirror-button').addEventListener('click', () => { settings.mirror = !settings.mirror; applyView(); save(); });
for (const name of ['text', 'view']) $(name + '-tab').addEventListener('click', () => setTab(name));
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const name = event.key === 'Home' ? 'text' : event.key === 'End' ? 'view' : $('text-tab').getAttribute('aria-selected') === 'true' ? 'view' : 'text'; setTab(name); $(name + '-tab').focus(); }
});
$('toggle-sidebar').addEventListener('click', toggleSidebar);
for (const id of ['close-sidebar','drawer-backdrop']) $(id).addEventListener('click', () => { closeDrawer(); $('toggle-sidebar').focus(); });
$('empty-edit').addEventListener('click', () => { setTab('text'); if (innerWidth <= 850 && !document.body.classList.contains('drawer-open')) toggleSidebar(); else if (document.body.classList.contains('sidebar-hidden')) toggleSidebar(); $('script-editor').focus(); });
$('dismiss-message').addEventListener('click', hideMessage);
$('fullscreen-button').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => { const label = document.fullscreenElement ? 'Выйти из экрана' : 'На весь экран'; $('fullscreen-button').lastElementChild.textContent = label; $('fullscreen-button').setAttribute('aria-label', label); requestAnimationFrame(layoutReader); });
function openHelp() { pause(); $('help-dialog').showModal(); }
$('help-button').addEventListener('click', openHelp);
for (const id of ['close-help','help-done']) $(id).addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('reading-text').addEventListener('click', event => { const word = event.target.closest('.word'); if (word) seek(Number(word.dataset.index)); });
for (const eventName of ['wheel','touchstart']) $('reader-scroll').addEventListener(eventName, () => { if (running || countdownTimer) pause(); following = false; }, { passive: true });
$('import-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  event.target.value = '';
  if (file.size > 500000) { showMessage('Файл слишком большой. Максимум — 500 КБ и 100 000 символов.'); return; }
  if (!/\.txt$/i.test(file.name) && file.type !== 'text/plain') { showMessage('Выберите текстовый файл .txt в кодировке UTF-8.'); return; }
  try {
    const text = (await file.text()).replace(/^\uFEFF/, '');
    if (text.includes('\u0000') || text.includes('\uFFFD')) { showMessage('Не удалось прочитать текст. Сохраните файл в формате .txt с кодировкой UTF-8.'); return; }
    if (text.length > 100000) { showMessage('Текст слишком длинный. Максимум — 100 000 символов.'); return; }
    clearTimeout(editTimer); editTimer = null; pause(); if (library) libraryAction(() => { persistScript(); library.checkpoint(); }); settings.text = text; settings.title = file.name.replace(/\.txt$/i, '').slice(0,80);
    $('script-editor').value = text; $('script-title').value = settings.title; renderScript(); layoutReader(); save(); hideMessage();
  } catch { showMessage('Не удалось открыть файл. Попробуйте ещё раз.'); }
});
$('export-button').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([settings.text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${(settings.title || 'Сценарий').replace(/[<>:"/\\|?*]/g, '_')}.txt`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && (shooting || countdownTimer)) { pause(); setShooting(false); return; }
  if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) { closeDrawer(); $('toggle-sidebar').focus(); return; }
  if (event.key === 'Tab' && innerWidth <= 850 && document.body.classList.contains('drawer-open')) {
    const items = [...$('sidebar').querySelectorAll('button, textarea, select, input, [tabindex="0"]')].filter(el => !el.disabled && el.tabIndex !== -1 && el.getClientRects().length);
    if (event.shiftKey && (document.activeElement === items[0] || !$('sidebar').contains(document.activeElement))) { event.preventDefault(); items.at(-1)?.focus(); }
    else if (!event.shiftKey && (document.activeElement === items.at(-1) || !$('sidebar').contains(document.activeElement))) { event.preventDefault(); items[0]?.focus(); }
    return;
  }
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || $('help-dialog').open || document.body.classList.contains('drawer-open')) return;
  if (event.target.closest('textarea,input,select,button,[contenteditable=true]')) return;
  if (event.code === 'Space') { event.preventDefault(); toggleReading(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); seekLine(event.key === 'ArrowDown' ? 1 : -1); }
  else if (event.code === 'KeyT') { event.preventDefault(); retake(); }
  else if (event.code === 'KeyR') { event.preventDefault(); reset(); }
  else if (event.code === 'KeyF') { event.preventDefault(); toggleFullscreen(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('pagehide', () => {
  pause();
  try { persistScript(); localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* current browser disallows storage */ }
});
const resizeObserver = new ResizeObserver(() => { layoutReader(); updateSidebarAccessibility(); $('toggle-sidebar').setAttribute('aria-expanded', String(innerWidth <= 850 ? document.body.classList.contains('drawer-open') : !document.body.classList.contains('sidebar-hidden'))); }); resizeObserver.observe($('reader-stage'));

setupStudio();
renderScript(); setMode(settings.mode); applyView(); updateSidebarAccessibility(); closeDrawer();
if (!Recognition) $('voice-notice').textContent = 'В этом браузере нет распознавания речи. Откройте в Chrome или выберите режим «По скорости». Микрофон не включён.';
else if (location.protocol === 'file:') $('voice-notice').textContent = 'Локальный файл. Микрофон включится только после старта. Если браузер запретит доступ, откройте «Запустить локально.command» из комплекта. Распознавание может отправлять звук сервису браузера и требует интернет.';
if (!storageAvailable) $('save-status').textContent = 'Хранилище недоступно — скачайте текст';
requestAnimationFrame(animationFrame);

if (['127.0.0.1', 'localhost'].includes(location.hostname) && typeof fetch === 'function') {
  fetch('/api/speech/status', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(capability => {
    if (!capability || capability.engine !== 'vosk') return;
    localCapability = capability;
    if (capability.ready) $('voice-notice').textContent = 'Русский распознаётся на этом компьютере. Интернет для чтения не нужен; аудио не отправляется внешним сервисам. Другие языки используют сервис браузера.';
    else $('voice-notice').textContent = 'Локальный движок не готов. Запустите «Запустить локально.command» из полного комплекта, чтобы подготовить распознавание русского.';
  }).catch(() => {});
}
