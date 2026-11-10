/** Keep the active line visible near the chosen height, even with large type. */
export function readingLayout({ height, position = 38, fontSize = 44, lineHeight = 1.65 }) {
  height = Math.max(0, Number.isFinite(height) ? height : 0);
  position = Math.min(80, Math.max(10, Number.isFinite(position) ? position : 38));
  const line = Math.max(1, fontSize * lineHeight);
  const edge = Math.min(height / 2, line / 2 + 4);
  const guideY = Math.max(edge, Math.min(height - edge, height * position / 100));
  return {
    guideY,
    paddingTop: Math.max(0, guideY - line / 2),
    paddingBottom: Math.max(height - guideY + line, height / 4),
    fadeTop: Math.max(0, Math.min(height * .1, guideY - line / 2 - 16)),
    fadeBottom: Math.min(height, Math.max(height * .88, guideY + line / 2 + 16)),
  };
}
