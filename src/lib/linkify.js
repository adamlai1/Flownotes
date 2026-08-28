// URL detection for read-mode rendering (NoteEditor). Render-time only — the
// stored note text is never modified, no markup is saved, no schema involved.
//
// The API is segments, not markup: linkSegments(text) returns
// [{ type: 'text'|'link', text, href? }] whose concatenated `text` fields
// ALWAYS equal the input exactly. Tap-to-edit's caret math (DOM offset →
// string offset) depends on that invariant, so nothing here may add, drop,
// or reorder a character.
//
// Detection is deliberately conservative:
//   - http:// and https:// URLs
//   - www.-prefixed hosts (needs a dot after the www. label)
//   - bare domains only on a short list of unambiguous TLDs, lowercase only,
//     so sentence typos like "word.Next" or shouting "END.COM" never match
//   - never emails, never the inside of a longer token (boundary-checked in
//     code — NOT with regex lookbehind, which iOS 15 Safari can't parse)
//   - trailing punctuation is not part of the URL: "see example.com." links
//     to example.com. Closing brackets are trimmed only when unbalanced, so
//     wikipedia.org/wiki/Foo_(bar) survives intact.

const BARE_TLDS = 'com|org|net|edu|gov|io|dev|app|ai|co|xyz|info'

// One alternation, three shapes: scheme, www, bare domain. The bare shape
// requires the TLD to end at a real boundary (path/query/port or non-word).
const CANDIDATE = new RegExp(
  '(https?:\\/\\/[^\\s]+)' +
    '|(www\\.[^\\s]+)' +
    '|([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*' +
    `\\.(?:${BARE_TLDS})(?=[/:?#]|$|[^a-z0-9-])(?:[/:?#][^\\s]*)?)`,
  'gi'
)

// A character that, immediately before a candidate, means we're inside a
// larger token (someword.com in foo@someword.com, /path/example.com, …).
const BAD_PREFIX = /[a-zA-Z0-9@._/-]/

const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '…', '"', "'", '’', '”', '»', '>', '<'])
const CLOSERS = { ')': '(', ']': '[', '}': '{' }

function trimTrailing(url) {
  for (;;) {
    const last = url[url.length - 1]
    if (TRAILING.has(last)) {
      url = url.slice(0, -1)
      continue
    }
    if (CLOSERS[last]) {
      const open = CLOSERS[last]
      let opens = 0
      let closes = 0
      for (const ch of url) {
        if (ch === open) opens++
        else if (ch === last) closes++
      }
      if (closes > opens) {
        url = url.slice(0, -1)
        continue
      }
    }
    break
  }
  return url
}

export function linkSegments(text) {
  const out = []
  if (!text) return out
  let last = 0
  CANDIDATE.lastIndex = 0
  let m
  while ((m = CANDIDATE.exec(text))) {
    const start = m.index
    const prev = start === 0 ? '' : text[start - 1]
    if (prev && BAD_PREFIX.test(prev)) continue

    const raw = trimTrailing(m[0])
    if (!raw) continue

    const isScheme = /^https?:\/\//i.test(raw)
    const isWww = !isScheme && /^www\./i.test(raw)
    const host = (isScheme ? raw.replace(/^https?:\/\//i, '') : raw).split(/[/:?#]/)[0]

    // Emails and userinfo-style hosts are never links here.
    if (!isScheme && host.includes('@')) continue
    // "www." needs a real host after it (www.example.com, not www.foo).
    if (isWww && host.split('.').length < 3) continue
    // Bare domains: TLD must be lowercase as typed — the sentence-typo guard.
    if (!isScheme && !isWww) {
      const tld = host.split('.').pop()
      if (tld !== tld.toLowerCase()) continue
    }
    // Scheme form still needs something after the // to be a destination.
    if (isScheme && host.length === 0) continue

    if (start > last) out.push({ type: 'text', text: text.slice(last, start) })
    out.push({ type: 'link', text: raw, href: isScheme ? raw : 'https://' + raw })
    last = start + raw.length
    CANDIDATE.lastIndex = last
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}
