import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWord, speechWords, parseScript, followSpeech } from '../src/alignment.js';

const words = text => parseScript(text).words;
test('Russian case, ё, punctuation and hyphenation preserve visible text', () => {
  assert.equal(normalizeWord('ЁЛКА!'), 'елка');
  const parsed = parseScript('Кто-нибудь, скажите: «Привет!»\nНовый дубль.');
  assert.deepEqual(parsed.words, ['кто','нибудь','скажите','привет','новыи','дубль']);
  assert.equal(parsed.paragraphs[0].map(p => p.text).join(''), 'Кто-нибудь, скажите: «Привет!»');
  assert.deepEqual(speechWords("Let's read."), ["lets", 'read']);
});
test('follows a growing Russian interim result without re-consuming a repeated phrase', () => {
  const script = words('Говорите в своём темпе. Говорите в своём темпе. Это следующий дубль.');
  let cursor = followSpeech(script, 'говорите', 0, 0);
  assert.equal(cursor, 1);
  cursor = followSpeech(script, 'говорите в своём темпе', cursor, 0);
  assert.equal(cursor, 4);
  assert.equal(followSpeech(script, 'говорите в своём темпе', cursor, 0), 4);
  assert.equal(followSpeech(script, 'говорите в своём темпе', cursor, cursor), 8);
});
test('accepts small omissions, filler and one typo in a longer word', () => {
  const script = words('Сегодня мы расскажем вам интересную историю про большую поездку.');
  assert.equal(followSpeech(script, 'сегодня мы эээ расскажем интересную историю', 0), 6);
  assert.equal(followSpeech(script, 'интересную истрию про большую поездку', 4), 9);
});
test('unrelated speech and isolated far-away common words do not jump', () => {
  const script = words('Начинаем наш рассказ про большой поход через горы и леса. Здесь будет вторая часть истории.');
  assert.equal(followSpeech(script, 'пожалуйста откройте окно', 0), 0);
  assert.equal(followSpeech(script, 'истории', 0), 0);
  assert.equal(followSpeech(script, 'и', 0), 0);
});
test('nearby skipped sentence can recover with three matching words', () => {
  const script = words('Первое предложение можно пропустить. А теперь мы говорим про наш новый проект.');
  assert.equal(followSpeech(script, 'а теперь мы говорим про наш новый проект', 0), script.length);
});
test('empty and completed scripts are stable', () => {
  assert.equal(followSpeech([], 'текст', 0), 0);
  assert.equal(followSpeech(['текст'], '', 0), 0);
  assert.equal(followSpeech(['текст'], 'текст', 1), 1);
});
test('short words at current position still follow', () => {
  assert.equal(followSpeech(words('И мы здесь.'), 'и', 0), 1);
  assert.equal(followSpeech(words('И мы здесь.'), 'и мы', 1, 0), 2);
});
test('a long continuous interim utterance advances beyond the matching window', () => {
  const script = Array.from({ length: 160 }, (_, i) => `слово${i}`);
  let cursor = 0;
  for (let i = 1; i <= script.length; i++) cursor = followSpeech(script, script.slice(0, i).join(' '), cursor, 0);
  assert.equal(cursor, script.length);
});
test('a very long uninterrupted result does not accumulate a fatal distance penalty', () => {
  const script = Array.from({ length: 1700 }, (_, i) => `слово${i}`);
  assert.equal(followSpeech(script, script.slice(0, 1601).join(' '), 1600, 0), 1601);
});
test('a revised interim transcript cannot move the cursor backwards', () => {
  const script = words('Говорите в своём темпе и читайте дальше.');
  assert.equal(followSpeech(script, 'говорите в своём темпе', 6, 0), 6);
});
