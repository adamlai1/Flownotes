// Type metrics for the text inside a bubble in the bubble view.
//
// Bubbles are small on a phone (the smallest is 80×53), so the name's size has to be
// chosen carefully: too wide a size range makes "AI" tower over "Other People", too
// little padding leaves text against the edge, and a size picked without accounting
// for wrapping truncates names that would have fitted on two lines.

export const TEXT_PAD = 12        // horizontal breathing room inside a bubble, per side
export const BUB_V_PAD = 3        // top/bottom breathing room
export const NAME_COUNT_GAP = 4   // vertical gap between the name and the count line
export const COUNT_FONT = 9       // fixed: the count never scales with the name
export const COUNT_LINE_H = 1.15
export const NAME_MAX_FONT = 15   // cap, so short names don't dwarf longer ones
export const NAME_MIN_FONT = 9    // floor; only below this is a name truncated
export const NAME_LINE_H = 1.2
export const NAME_CHAR_W = 0.58   // rough advance width per char, in em

// Greedy word wrap: how many lines `words` need at `cpl` characters per line. A word
// longer than a whole line breaks across lines (the span sets overflow-wrap: anywhere).
export function wrapLineCount(words, cpl) {
  if (cpl < 1) return Infinity
  let lines = 1
  let used = 0
  for (const word of words) {
    const space = used === 0 ? 0 : 1
    if (used + space + word.length <= cpl) { used += space + word.length; continue }
    if (used > 0) { lines++; used = 0 }
    if (word.length <= cpl) { used = word.length; continue }
    const rows = Math.ceil(word.length / cpl)
    lines += rows - 1
    used = word.length - (rows - 1) * cpl
  }
  return lines
}

// Height available to the name, once the count line has taken its share.
export function nameBoxHeight(boxH, countLines) {
  const countBlock = countLines > 0
    ? countLines * COUNT_FONT * COUNT_LINE_H + NAME_COUNT_GAP
    : 0
  return Math.max(boxH - BUB_V_PAD * 2 - countBlock, NAME_MIN_FONT * NAME_LINE_H)
}

// Largest size at which the whole name is estimated to fit in `boxW` × `boxH`.
//
// Walking down from the cap is what makes wrapping preferred over shrinking: the
// number of lines allowed grows as the font drops, so a two-word name gets a second
// line before it gets a smaller size. Returns the floor when nothing fits — that is
// the only case where the caller lets the text truncate.
//
// This is an estimate from average glyph width; BubbleCircle measures the rendered
// text and corrects it, so a name is never truncated merely because the guess was off.
export function fitNameFont(name, boxW, boxH) {
  const words = (name || '').split(/\s+/).filter(Boolean)
  if (!words.length) return NAME_MAX_FONT
  for (let size = NAME_MAX_FONT; size >= NAME_MIN_FONT; size -= 0.5) {
    const cpl = Math.floor(boxW / (size * NAME_CHAR_W))
    const linesAllowed = Math.max(1, Math.floor(boxH / (size * NAME_LINE_H)))
    if (wrapLineCount(words, cpl) <= linesAllowed) return size
  }
  return NAME_MIN_FONT
}
