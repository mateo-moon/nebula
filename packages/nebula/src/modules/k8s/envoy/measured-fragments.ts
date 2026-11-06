/** Split measured argv literals below the pinned policy parser's line bound.
 * Concatenation preserves the existing bootstrap representation exactly. */
export function measuredFragments(text: string): string[] {
  const pieces: string[] = [];
  while (text.length) {
    let size = Math.min(text.length, 650);
    while (JSON.stringify(text.slice(0, size)).length > 700) size--;
    pieces.push(text.slice(0, size)); text = text.slice(size);
  }
  return pieces;
}
