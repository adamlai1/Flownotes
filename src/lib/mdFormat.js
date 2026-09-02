// Markdown formatting for notes: the pure text transforms behind the
// edit-mode formatting bar, and the inline segmenter behind read-mode
// rendering. Storage format is the markdown itself — these functions only
// rewrite the note text plus a selection range; nothing here touches the DOM,
// state, or persistence.

// The line-level markers. Mutually exclusive by design: applying one strips
// whichever marker the line already carries, so "- [ ] " never stacks on
// "- ", "1. " or "# " and every line has at most one hidden prefix.
const CHECKLIST_INSERT = '- [ ] '
const BULLET_INSERT = '- '
const LINE_MARKER_RES = {
  checklist: /^- \[[ xX]\] /,
  bullet: /^- (?!\[[ xX]\] )/, // lookAHEAD only — iOS 15 Safari can't parse lookbehind
  header: /^#{1,3} /,
  numbered: /^\d+\. /,
}
// Any line marker, longest form first so "- [ ] " never half-matches as "- ".
const STRIP_RE = /^(?:- \[[ xX]\] |#{1,3} |\d+\. |- )/

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
// kind 'numbered': same all-or-nothing rule, but the inserted marker is the
// line's ordinal WITHIN THE SELECTION — "1. ", "2. ", … — so a multi-line
// apply comes out sequentially numbered (and re-applying over stale numbers
// renumbers, since mixed/missing markers count as "not all have it").
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

  // targetFor(i): the marker line i receives — constant for every kind
  // except numbered, whose marker carries the ordinal.
  let targetFor
  if (kind === 'header') {
    const m = text.slice(lines[0][0], lines[0][1]).match(LINE_MARKER_RES.header)
    const level = m ? m[0].length - 1 : 0
    const t = level >= 3 ? '' : '#'.repeat(level + 1) + ' '
    targetFor = () => t
  } else if (kind === 'numbered') {
    const allHave = lines.every(([s, e]) => LINE_MARKER_RES.numbered.test(text.slice(s, e)))
    targetFor = allHave ? () => '' : i => `${i + 1}. `
  } else {
    const insert = kind === 'checklist' ? CHECKLIST_INSERT : BULLET_INSERT
    const allHave = lines.every(([s, e]) => LINE_MARKER_RES[kind].test(text.slice(s, e)))
    targetFor = allHave ? () => '' : () => insert
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
    const target = targetFor(i)
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

// Link insertion — insert-only, no toggle: unlike **/~~ pairs there is no
// natural "press again to unwrap" selection state to detect cheaply, and
// deleting a link is ordinary text editing.
// With a selection: the selected text is already the label, so it's wrapped
// as [label]() and the CURSOR GOES INSIDE THE PARENS — the URL is the one
// thing still missing, and the next keystroke (usually a paste) should land
// there. With a bare cursor: an empty skeleton []() is inserted and the
// CURSOR GOES INSIDE THE BRACKETS — nothing exists yet, and label-then-URL
// mirrors the reading order and the selection case's flow (label first,
// parens next). Returns { text, start, end } with a collapsed cursor.
export function insertLink(text, start, end) {
  if (start === end) {
    return {
      text: text.slice(0, start) + '[]()' + text.slice(start),
      start: start + 1,
      end: start + 1,
    }
  }
  const inner = text.slice(start, end)
  return {
    text: text.slice(0, start) + '[' + inner + ']()' + text.slice(end),
    start: end + 3,
    end: end + 3,
  }
}

// Markdown → readable plain text, for sharing. Line markers become their
// typographic equivalents (☐/☑ for checklists, • for bullets, numbered lines
// keep their numbers, header prefixes drop); inline markers vanish, links
// become "label (url)". Sharing hands text to Messages/Mail readers who never
// see our rendering — raw "**bold**" there is marker soup, not emphasis.
// Copy deliberately does NOT use this: copied text round-trips (into another
// markdown editor, or back into the app), so it keeps the markers.
export function toPlainText(text) {
  return text.split('\n').map(line => {
    let rest = line
    let prefix = ''
    let m
    if ((m = line.match(LINE_MARKER_RES.checklist))) {
      prefix = /[xX]/.test(m[0]) ? '☑ ' : '☐ '
      rest = line.slice(m[0].length)
    } else if ((m = line.match(LINE_MARKER_RES.bullet))) {
      prefix = '• '
      rest = line.slice(m[0].length)
    } else if ((m = line.match(LINE_MARKER_RES.header))) {
      rest = line.slice(m[0].length)
    } else if ((m = line.match(LINE_MARKER_RES.numbered))) {
      prefix = m[0]
      rest = line.slice(m[0].length)
    }
    const flat = inlineSegments(rest)
      .map(s => (s.link ? `${s.text} (${s.href})` : s.text))
      .join('')
    return prefix + flat
  }).join('\n')
}

// Inline segmentation for read-mode rendering: [label](url) links, ***both***,
// **bold**, *italic*, ~~strike~~ — no nesting, never across lines. Each
// segment carries rawStart, the offset of its FIRST RENDERED character in the
// input string (i.e. past any opening marker), which is what read mode stamps
// as data-raw-start for exact caret mapping. Concatenating segment texts does
// NOT reproduce the input — the markers (and a link's whole "](url)" tail)
// are gone; that is the whole point, and why rawStart exists.
//
// Links match only with BOTH a label and a url — a half-built [label]() stays
// visible as raw text while the user is still composing it. The url is hidden
// entirely (only the label renders), which is also what keeps markdown links
// from ever colliding with the bare-URL linkifier: the linkifier runs over
// rendered segment text, and a markdown link's url never appears there.
const INLINE_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|~~([^~\n]+)~~/g

export function inlineSegments(str) {
  const out = []
  let last = 0
  INLINE_RE.lastIndex = 0
  let m
  while ((m = INLINE_RE.exec(str))) {
    if (m.index > last) out.push({ text: str.slice(last, m.index), rawStart: last })
    if (m[1] != null) {
      const url = m[2]
      out.push({
        text: m[1],
        rawStart: m.index + 1,
        link: true,
        href: /^https?:\/\//i.test(url) ? url : 'https://' + url,
      })
    }
    else if (m[3] != null) out.push({ text: m[3], rawStart: m.index + 3, bold: true, italic: true })
    else if (m[4] != null) out.push({ text: m[4], rawStart: m.index + 2, bold: true })
    else if (m[5] != null) out.push({ text: m[5], rawStart: m.index + 1, italic: true })
    else out.push({ text: m[6], rawStart: m.index + 2, strike: true })
    last = m.index + m[0].length
  }
  if (last < str.length) out.push({ text: str.slice(last), rawStart: last })
  return out
}
