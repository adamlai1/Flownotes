// Type metrics for the text inside a bubble in the bubble view.
//
// Bubbles are small on a phone (the smallest is 80×53), so the name's size has to be
// chosen carefully: too wide a size range makes "AI" tower over "Other People", too
// little padding leaves text against the edge, and every px of padding or of the size
// floor is a px of line a two-word name doesn't have to stay on one line with.

// Horizontal breathing room inside a bubble, per side. Kept tight because it is spent
// twice: at 12 a side, an 80px bubble gave the name only 56px of line, which put a
// two-word name like "Past Memories" out of reach of one line at any allowed size.
export const TEXT_PAD = 8
export const BUB_V_PAD = 3        // top/bottom breathing room
export const NAME_COUNT_GAP = 4   // vertical gap between the name and the count line
export const COUNT_FONT = 9       // fixed: the count never scales with the name
export const COUNT_LINE_H = 1.15
export const NAME_MAX_FONT = 15   // cap, so short names don't dwarf longer ones
export const NAME_MIN_FONT = 8    // floor; a name only wraps when one line needs less
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
// One line is worth more than a big font: a name is shrunk — all the way to the floor
// if that's what it takes — before it is allowed to wrap. So the first pass looks only
// for a size the whole name fits across in a single line, and only a name that can't
// manage that even at the floor falls through to the second pass, which takes the
// largest size whose wrapped block fits the height. Returns the floor when nothing
// fits — that is the only case where the caller lets the text truncate.
//
// This is an estimate from average glyph width; BubbleCircle measures the rendered
// text and corrects it, so a name is never truncated merely because the guess was off.
export function fitNameFont(name, boxW, boxH) {
  const words = (name || '').split(/\s+/).filter(Boolean)
  if (!words.length) return NAME_MAX_FONT

  // Pass 1 — one line, as large as one line allows.
  const oneLineChars = words.join(' ').length
  for (let size = NAME_MAX_FONT; size >= NAME_MIN_FONT; size -= 0.5) {
    if (size * NAME_LINE_H > boxH) continue                    // the line has to fit down, too
    if (oneLineChars * size * NAME_CHAR_W <= boxW) return size
  }

  // Pass 2 — one line is out of reach, so wrap at the largest size that fits.
  for (let size = NAME_MAX_FONT; size >= NAME_MIN_FONT; size -= 0.5) {
    const cpl = Math.floor(boxW / (size * NAME_CHAR_W))
    const linesAllowed = Math.max(1, Math.floor(boxH / (size * NAME_LINE_H)))
    if (wrapLineCount(words, cpl) <= linesAllowed) return size
  }
  return NAME_MIN_FONT
}
