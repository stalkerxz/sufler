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
const defaults = { text: SAMPLE, title: 'Мой первый дубль', mode: 'voice', lang: 'ru-RU', fontSize: 44, lineHeight: 1.65, textWidth: 840, readingPosition: 38, speed: 130, mirror: false, light: false };
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
      textWidth: clamp(saved.textWidth, 440, 1100, 840), speed: clamp(saved.speed, 40, 260, 130),
      readingPosition: clamp(saved.readingPosition, 10, 80, 38),
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
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); storageAvailable = true; $('save-status').textContent = 'Сохранено в этом браузере'; }
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
      if (part.index === undefined) p.append(document.createTextNode(part.text));
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
  const icon = running ? '<path d="M8 5v14M16 5v14"/>' : settings.mode === 'voice' ? '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3"/>' : '<path d="m8 4 12 8-12 8z"/>';
  $('start-icon').innerHTML = icon;
  $('start-button').lastElementChild.textContent = running ? 'Пауза' : cursor >= parsed.words.length && parsed.words.length ? 'Ещё один дубль' : started ? 'Продолжить' : 'Начать чтение';
  $('start-button').setAttribute('aria-pressed', String(running));
}
function start() {
  // Commit a pending text edit before using the parsed script.
  if (editTimer) { clearTimeout(editTimer); editTimer = null; renderScript(); }
  if (!parsed.words.length) { showMessage('Добавьте текст сценария, чтобы начать чтение.'); return; }
  if (settings.mode === 'voice' && (!(localCapability?.ready && settings.lang === 'ru-RU') && !Recognition || !window.isSecureContext)) {
    showMessage(!window.isSecureContext ? 'Для микрофона откройте сайт через HTTPS или localhost. Можно также выбрать «По скорости».' : 'В этом браузере нет распознавания речи. Откройте в Chrome или выберите «По скорости».');
    return;
  }
  if (cursor >= parsed.words.length) reset();
  hideMessage();
  following = true; alignWord();
  running = true; started = true; lastFrame = performance.now();
  if (settings.mode === 'voice') { speechReady = false; resultAnchors.clear(); speech.stop(); speech = localCapability?.ready && settings.lang === 'ru-RU' ? localSpeech : browserSpeech; speech.start(settings.lang, localCapability); }
  else { speechReady = false; setStatus('listening', 'Чтение по скорости'); }
  updateButton();
  if (running) keepAwake();
  closeDrawer();
}
function pause() {
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
function toggleReading() { running ? pause() : start(); }
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
  $('heard-preview').textContent = ''; updateButton(); if (resume) start();
}

$('script-editor').value = settings.text; $('script-title').value = settings.title; $('language').value = settings.lang;
$('script-editor').addEventListener('input', () => {
  pause(); settings.text = $('script-editor').value; save();
  clearTimeout(editTimer); editTimer = setTimeout(() => { editTimer = null; renderScript(); layoutReader(); }, 180);
});
$('script-title').addEventListener('input', event => { settings.title = event.target.value; save(); });
$('start-button').addEventListener('click', toggleReading); $('reset-button').addEventListener('click', () => { hideMessage(); reset(); });
$('voice-mode').addEventListener('click', () => setMode('voice')); $('speed-mode').addEventListener('click', () => setMode('speed'));
$('language').addEventListener('change', event => { pause(); settings.lang = event.target.value; save(); });
for (const [id, key] of [['font-size','fontSize'],['line-height','lineHeight'],['text-width','textWidth'],['reading-position','readingPosition'],['reading-speed','speed']]) $(id).addEventListener('input', event => {
  settings[key] = Number(event.target.value);
  if (id === 'reading-position') following = true;
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
function openHelp() { if (running) pause(); $('help-dialog').showModal(); }
$('help-button').addEventListener('click', openHelp);
for (const id of ['close-help','help-done']) $(id).addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('reading-text').addEventListener('click', event => { const word = event.target.closest('.word'); if (word) seek(Number(word.dataset.index)); });
for (const eventName of ['wheel','touchstart']) $('reader-scroll').addEventListener(eventName, () => { if (running) pause(); following = false; }, { passive: true });
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
    clearTimeout(editTimer); editTimer = null; pause(); settings.text = text; settings.title = file.name.replace(/\.txt$/i, '').slice(0,80);
    $('script-editor').value = text; $('script-title').value = settings.title; renderScript(); layoutReader(); save(); hideMessage();
  } catch { showMessage('Не удалось открыть файл. Попробуйте ещё раз.'); }
});
$('export-button').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([settings.text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${(settings.title || 'Сценарий').replace(/[<>:"/\\|?*]/g, '_')}.txt`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('keydown', event => {
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
  else if (event.code === 'KeyR') { event.preventDefault(); reset(); }
  else if (event.code === 'KeyF') { event.preventDefault(); toggleFullscreen(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && running) pause(); });
window.addEventListener('pagehide', () => {
  pause();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* current browser disallows storage */ }
});
const resizeObserver = new ResizeObserver(() => { layoutReader(); updateSidebarAccessibility(); $('toggle-sidebar').setAttribute('aria-expanded', String(innerWidth <= 850 ? document.body.classList.contains('drawer-open') : !document.body.classList.contains('sidebar-hidden'))); }); resizeObserver.observe($('reader-stage'));

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
