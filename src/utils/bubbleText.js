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
// Minimum vertical padding the NAME keeps from the top and bottom borders on a bubble
// with no count block.
export const LABEL_MIN_V_PAD = 5
export const NAME_COUNT_GAP = 4   // vertical gap between the name and the count line
// Minimum clearance between the bottom of the count block and the bottom border. The
// name is centred on its own and the count hangs beneath it, so the name's font budget
// is what keeps this clearance (nameBoxHeight): the name shrinks or wraps before the
// count can get closer than this. It is also what decides whether a bubble with both
// sub-bubbles and notes shows two count lines or the compressed "1b · 4n" line
// (countLayoutFor). Nudge on device.
export const COUNT_MIN_CLEARANCE = 5
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

// Height available to the name, honest about where the count block actually sits.
//
// The name is centred in the box ON ITS OWN, at a consistent height whether or not it
// has counts, and the count block hangs beneath it. So with a name of height h the
// count's bottom edge is at H/2 + h/2 + gap + countBlock, and for that to stay
// COUNT_MIN_CLEARANCE above the border the name may be at most
// H − 2·(gap + countBlock + clearance) tall. (This used to be H − 2·pad − countBlock,
// which is the budget for a name and count centred TOGETHER — a geometry the markup
// never had — so the name was sized for room it didn't have and the count landed on
// the bottom border.)
export function nameBoxHeight(boxH, countLines) {
  const reserve = countLines > 0
    ? NAME_COUNT_GAP + countLines * COUNT_FONT * COUNT_LINE_H + COUNT_MIN_CLEARANCE
    : LABEL_MIN_V_PAD
  return Math.max(boxH - reserve * 2, NAME_MIN_FONT * NAME_LINE_H)
}

// Does `name` fit `boxW` × `boxH` at `size` without truncation? (fitNameFont returns
// the floor both when the name fits there and when nothing fits, so a caller that
// needs the distinction asks this.)
function nameFitsAt(name, boxW, boxH, size) {
  const words = (name || '').split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const cpl = Math.floor(boxW / (size * NAME_CHAR_W))
  const linesAllowed = Math.max(1, Math.floor(boxH / (size * NAME_LINE_H)))
  return size * NAME_LINE_H <= boxH && wrapLineCount(words, cpl) <= linesAllowed
}

// Which count form a bubble gets, decided from CLEARANCE, not size, and without any
// rendering: the box, the fixed count metrics and the name's estimated fit are all
// known before layout. Returns { countLines, collapsed, nameBoxH }.
//
// A bubble with both sub-bubbles and notes keeps the two-line form ("1 bubble" /
// "4 notes") if, with two lines reserved, the name still fits at a size no smaller
// than the count text — a name squeezed below its own subtitle has lost the room the
// two lines were supposed to share. Otherwise it collapses to one line ("1b · 4n"),
// which frees a count line's worth of budget for the name. So a short name keeps two
// lines on a bubble where a long, wrapping name collapses — the rule is "does it fit
// with breathing room", not "is it small". Pure in (name, boxW, boxH, counts), so it
// can't oscillate: the measured pass that corrects the name's font afterwards only
// ever moves within the budget chosen here, never the decision.
export function countLayoutFor(name, boxW, boxH, bubbleCount, noteCount) {
  const has = (bubbleCount > 0 ? 1 : 0) + (noteCount > 0 ? 1 : 0)
  if (has < 2) return { countLines: has, collapsed: false, nameBoxH: nameBoxHeight(boxH, has) }
  const twoLineBox = boxH - 2 * (NAME_COUNT_GAP + 2 * COUNT_FONT * COUNT_LINE_H + COUNT_MIN_CLEARANCE)
  if (twoLineBox >= COUNT_FONT * NAME_LINE_H) {
    const size = fitNameFont(name, boxW, twoLineBox)
    if (size >= COUNT_FONT && nameFitsAt(name, boxW, twoLineBox, size)) {
      return { countLines: 2, collapsed: false, nameBoxH: nameBoxHeight(boxH, 2) }
    }
  }
  return { countLines: 1, collapsed: true, nameBoxH: nameBoxHeight(boxH, 1) }
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
