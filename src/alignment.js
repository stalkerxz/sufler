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
    const parts = (paragraph.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\p{L}\p{N}]+/gu) || []).map(text => {
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
export function followSpeech(script, transcript, cursor, anchor = cursor) {
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
