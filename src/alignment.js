/** Text matching is independent of the recognition service and UI. */
export function normalizeWord(word) {
  return word.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
}

export function speechWords(text) {
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [])
    .map(normalizeWord).filter(Boolean);
}

export function parseScript(text) {
  let index = 0;
  const words = [];
  const paragraphs = text.split(/\n+/).filter(p => p.trim()).map(paragraph => {
    const parts = (paragraph.match(/\[[^\]\n]*\]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\p{L}\p{N}\[]+|\[/gu) || []).map(text => {
      if (text.startsWith('[') && text.endsWith(']')) return { text, direction: true };
      const normalized = normalizeWord(text);
      if (!normalized) return { text };
      const part = { text, normalized, index: index++ };
      words.push(normalized);
      return part;
    });
    return parts;
  });
  return { words, paragraphs };
}

function similarity(a, b) {
  if (a === b) return 4;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return -3;
  // A single recognition typo is allowed in a longer word.
  let i = 0, j = 0, differences = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++differences > 1) return -3;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  differences += (a.length - i) + (b.length - j);
  return differences <= 1 ? 2.5 : -3;
}

/**
 * Semi-global sequence alignment: tolerate filler and small skipped phrases,
 * require evidence for jumps, prefer nearby repetitions, never move backwards.
 * cursor is the next unread word. The transcript is a single recognition result.
 */
function alignSpeech(script, transcript, cursor, anchor = cursor) {
  const allHeard = speechWords(transcript);
  const heard = allHeard.slice(-28);
  if (!heard.length || cursor >= script.length) return cursor;
  // Once the transcript prefix is discarded, measure proximity within the
  // current window. An ever-growing distance from the original anchor would
  // eventually outweigh even a perfect match in a long uninterrupted result.
  const proximityAnchor = allHeard.length > 28 ? Math.max(anchor, cursor - heard.length) : anchor;
  const start = Math.max(0, allHeard.length > 28 ? cursor - 32 : anchor - 8);
  const segment = script.slice(start, Math.min(script.length, cursor + 85));
  const n = segment.length, m = heard.length;
  const score = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  const trace = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));
  for (let i = 1; i <= m; i++) score[i][0] = -2.5 * i;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const diagonal = score[i - 1][j - 1] + similarity(heard[i - 1], segment[j - 1]);
      const filler = score[i - 1][j] - 2.5;
      const skipped = score[i][j - 1] - 2.6;
      score[i][j] = Math.max(diagonal, filler, skipped);
      trace[i][j] = score[i][j] === diagonal ? 1 : score[i][j] === filler ? 2 : 3;
    }
  }
  let bestValue = -Infinity, bestCursor = cursor;
  for (let end = 1; end <= n; end++) {
    let i = m, j = end, exact = 0, matches = 0, lastMatch = -1, lastHeard = -1;
    while (i > 0 && j > 0) {
      if (trace[i][j] === 1) {
        if (similarity(heard[i - 1], segment[j - 1]) > 0) {
          matches++;
          if (heard[i - 1] === segment[j - 1]) exact++;
          if (lastMatch < 0) { lastMatch = start + j - 1; lastHeard = i - 1; }
        }
        i--; j--;
      } else if (trace[i][j] === 2) i--;
      else j--;
    }
    const next = lastMatch + 1;
    if (next <= anchor || lastHeard < m - 2) continue;
    const jump = next - proximityAnchor;
    if (m === 1 && (exact !== 1 || jump > 3)) continue;
    if (m > 1 && (matches < 2 || exact < 1 || matches / m < 0.55)) continue;
    if (jump > 12 && (exact < 3 || matches / m < 0.7)) continue;
    const value = score[m][end] - Math.max(0, next - proximityAnchor - 1) * 0.075;
    if (value > bestValue && value > 0) { bestValue = value; bestCursor = next; }
  }
  return Math.max(cursor, bestCursor);
}

// Expand written numbers and common Russian initialisms before alignment,
// retaining the mapping to visible words. Partial numbers never consume a word.
export function spokenNumber(value) {
  const n = Number(value);
  if (!/^\d{1,6}$/.test(value) || n > 999999) return [value];
  if (!n) return ['ноль'];
  const units = ['','один','два','три','четыре','пять','шесть','семь','восемь','девять'];
  const teens = ['десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать'];
  const tens = ['','','двадцать','тридцать','сорок','пятьдесят','шестьдесят','семьдесят','восемьдесят','девяносто'];
  const hundreds = ['','сто','двести','триста','четыреста','пятьсот','шестьсот','семьсот','восемьсот','девятьсот'];
  const small = (v, female = false) => [hundreds[Math.floor(v / 100)], v % 100 < 20 && v % 100 >= 10 ? teens[v % 100 - 10] : tens[Math.floor(v % 100 / 10)], v % 100 >= 10 && v % 100 < 20 ? '' : female && v % 10 === 1 ? 'одна' : female && v % 10 === 2 ? 'две' : units[v % 10]].filter(Boolean);
  const k = Math.floor(n / 1000);
  return [...(k ? [...small(k, true), k % 100 >= 11 && k % 100 <= 14 ? 'тысяч' : k % 10 === 1 ? 'тысяча' : k % 10 >= 2 && k % 10 <= 4 ? 'тысячи' : 'тысяч'] : []), ...small(n % 1000)];
}
const abbreviations = { 'сша':'сэ шэ а', 'рф':'эр эф', 'мвд':'эм вэ дэ', 'мгу':'эм гэ у', 'пк':'пэ ка', 'ии':'и и', 'ооо':'о о о', 'кг':'килограмм', 'км':'километр' };
function expandWord(word) {
  return (abbreviations[word]?.split(' ') || spokenNumber(word)).map(normalizeWord);
}
export function followSpeech(script, transcript, cursor, anchor = cursor) {
  // Limit expansion to the same local neighborhood as the matcher.
  const transcriptWords = speechWords(transcript);
  const base = Math.max(0, transcriptWords.length > 28 ? cursor - 32 : Math.min(anchor, cursor) - 8);
  const source = script.slice(base, cursor + 85);
  const expanded = [], ends = [0];
  for (const word of source) { expanded.push(...expandWord(word)); ends.push(expanded.length); }
  const localCursor = Math.max(0, cursor - base), localAnchor = Math.max(0, anchor - base);
  const heard = transcriptWords.flatMap(expandWord).join(' ');
  const next = alignSpeech(expanded, heard, ends[localCursor] ?? expanded.length, ends[localAnchor] ?? 0);
  let visible = localCursor;
  while (visible < source.length && ends[visible + 1] <= next) visible++;
  return Math.max(cursor, base + visible);
}
