// Markdown formatting for notes: the pure text transforms behind the
// edit-mode formatting bar, and the inline segmenter behind read-mode
// rendering. Storage format is the markdown itself — these functions only
// rewrite the note text plus a selection range; nothing here touches the DOM,
// state, or persistence.

// The three line-level markers. Mutually exclusive by design: applying one
// strips whichever of the three the line already carries, so "- [ ] " never
// stacks on "- " or "# " and every line has at most one hidden prefix.
const CHECKLIST_INSERT = '- [ ] '
const BULLET_INSERT = '- '
const LINE_MARKER_RES = {
  checklist: /^- \[[ xX]\] /,
  bullet: /^- (?!\[[ xX]\] )/, // lookAHEAD only — iOS 15 Safari can't parse lookbehind
  header: /^#{1,3} /,
}
// Any line marker, longest form first so "- [ ] " never half-matches as "- ".
const STRIP_RE = /^(?:- \[[ xX]\] |#{1,3} |- )/

// Toggle an inline marker pair around the selection (bold '**', italic '*').
// Selection: wrap and keep the inner text selected — which is exactly what
// lets a second press find the markers and unwrap. Bare cursor: insert an
// empty pair with the caret inside so typing lands between the markers; a
// second press on the still-empty pair removes it. Returns { text, start,
// end } with the selection in post-transform coordinates.
export function toggleInline(text, start, end, marker) {
  const L = marker.length
  if (start === end) {
    if (text.slice(start - L, start) === marker && text.slice(start, start + L) === marker) {
      return { text: text.slice(0, start - L) + text.slice(start + L), start: start - L, end: start - L }
    }
    return { text: text.slice(0, start) + marker + marker + text.slice(start), start: start + L, end: start + L }
  }
  const inner = text.slice(start, end)
  // Markers included in the selection → strip them.
  if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length >= 2 * L) {
    return { text: text.slice(0, start) + inner.slice(L, -L) + text.slice(end), start, end: end - 2 * L }
  }
  // Markers just outside the selection (the wrap case's own output) → unwrap.
  if (text.slice(start - L, start) === marker && text.slice(end, end + L) === marker) {
    return { text: text.slice(0, start - L) + inner + text.slice(end + L), start: start - L, end: end - L }
  }
  return { text: text.slice(0, start) + marker + inner + marker + text.slice(end), start: start + L, end: end + L }
}

// Toggle a line-level marker on every line the selection touches.
// kind 'checklist' | 'bullet': if every touched line already has that marker,
// remove it; otherwise apply it (replacing any other line marker).
// kind 'header': cycle by the FIRST line's current level — none → # → ## →
// ### → none — and apply the same target to all touched lines, so a mixed
// selection lands in one consistent state. Returns { text, start, end }.
export function toggleLinePrefix(text, start, end, kind) {
  const lines = []
  let ls = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
  for (;;) {
    let le = text.indexOf('\n', ls)
    if (le === -1) le = text.length
    lines.push([ls, le])
    // A selection ending exactly at a line start doesn't touch that line.
    if (le === text.length || le + 1 >= end) break
    ls = le + 1
  }

  let target
  if (kind === 'header') {
    const m = text.slice(lines[0][0], lines[0][1]).match(LINE_MARKER_RES.header)
    const level = m ? m[0].length - 1 : 0
    target = level >= 3 ? '' : '#'.repeat(level + 1) + ' '
  } else {
    const insert = kind === 'checklist' ? CHECKLIST_INSERT : BULLET_INSERT
    const allHave = lines.every(([s, e]) => LINE_MARKER_RES[kind].test(text.slice(s, e)))
    target = allHave ? '' : insert
  }

  // Rewrite last line first so earlier line offsets stay valid; adjust the
  // selection endpoints as each line's delta lands. Boundary rule at a line
  // start where a marker is inserted: a collapsed cursor moves past the new
  // marker (typing continues after the prefix); a range selection's start
  // stays put (it keeps covering the block, marker included). An endpoint
  // that sat inside a removed marker snaps to just after the new prefix.
  const collapsed = start === end
  let result = text
  let newStart = start
  let newEnd = end
  for (let i = lines.length - 1; i >= 0; i--) {
    const [s, e] = lines[i]
    const m = result.slice(s, e).match(STRIP_RE)
    const removed = m ? m[0].length : 0
    result = result.slice(0, s) + target + result.slice(s + removed)
    const d = target.length - removed
    const adj = p =>
      p < s ? p
        : p === s ? (collapsed && removed === 0 ? p + d : p)
        : p < s + removed ? s + target.length
        : p + d
    newStart = adj(newStart)
    newEnd = adj(newEnd)
  }
  return { text: result, start: newStart, end: newEnd }
}

// Inline segmentation for read-mode rendering: ***both***, **bold**, *italic*
// — no nesting, never across lines. Each segment carries rawStart, the offset
// of its FIRST RENDERED character in the input string (i.e. past any opening
// marker), which is what read mode stamps as data-raw-start for exact caret
// mapping. Concatenating segment texts does NOT reproduce the input — the
// markers are gone; that is the whole point, and why rawStart exists.
const INLINE_RE = /\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g

export function inlineSegments(str) {
  const out = []
  let last = 0
  INLINE_RE.lastIndex = 0
  let m
  while ((m = INLINE_RE.exec(str))) {
    if (m.index > last) out.push({ text: str.slice(last, m.index), rawStart: last })
    if (m[1] != null) out.push({ text: m[1], rawStart: m.index + 3, bold: true, italic: true })
    else if (m[2] != null) out.push({ text: m[2], rawStart: m.index + 2, bold: true })
    else out.push({ text: m[3], rawStart: m.index + 1, italic: true })
    last = m.index + m[0].length
  }
  if (last < str.length) out.push({ text: str.slice(last), rawStart: last })
  return out
}
