import { getNoteTitle, noteTitle } from './helpers'
import { toPlainText } from '../lib/mdFormat'

// Copying and sharing a note, shared by the two menus that offer it — the three-dot menu
// on a card in All Notes, and the long-press menu on a square in bubble view. They are
// the same two actions, so they are the same code: a note copied from one view and the
// other must produce identical text, or the feature is two features.

// The note as someone would want it pasted: title, blank line, body. Nothing else.
//
// Tags, bubble membership and timestamps are all deliberately absent. They are how the
// app FILES a note, not what the note says — pasting a note into a message should give
// the thought, not the filing.
export function noteAsText(note) {
  const content = note?.content ?? ''
  // A manually-set title is not part of the body: the whole content IS the
  // body, and nothing is stripped from it.
  const custom = typeof note?.title === 'string' ? note.title.trim() : ''
  if (custom) {
    const body = content
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/\s+$/, '')
    return body ? `${custom}\n\n${body}` : custom
  }
  const title = getNoteTitle(content)
  if (!title) return content.trim()
  // Everything after the line the title came from, kept verbatim in the middle. The ends
  // are tidied, but NOT with a plain trim: blank lines between the title and the body are
  // the editor's spacing and go, while whitespace at the start of the first body line is
  // the author's indentation and stays — a pasted code snippet or list should keep its
  // shape. So leading blank LINES are dropped and trailing whitespace is trimmed.
  const lines = content.split('\n')
  const titleIdx = lines.findIndex(l => l.trim())
  const body = lines.slice(titleIdx + 1).join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '')
  return body ? `${title}\n\n${body}` : title
}

// Is the share sheet available at all? Checked by the menus so Share is simply absent
// where it would do nothing — desktop Firefox, most non-secure contexts.
export const canShareNotes = () => typeof navigator !== 'undefined' && !!navigator.share

// Write to the clipboard, working on insecure origins too. navigator.clipboard
// is [SecureContext]-gated — over plain http (the LAN dev server; only
// localhost is exempt) it is UNDEFINED, not merely restricted — so where it's
// missing or its write fails, fall back to the legacy execCommand('copy')
// path through an offscreen textarea, which still works there. The fallback
// runs synchronously inside the user's click (execCommand also requires the
// gesture), and the primary write is the first await in every caller for the
// same reason. Returns true on success.
async function writeClipboard(text) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through to execCommand */ }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // Fixed + offscreen: no layout shift, no iOS scroll jump.
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// A copy that failed after BOTH paths means the browser is actively blocking
// clipboard access (permissions policy, an embedded context) — say that,
// rather than a shrug the user can't act on.
const COPY_BLOCKED = 'Clipboard blocked by this browser'

// Put the note on the clipboard. Returns the toast to show, always — a copy that goes
// nowhere silently is worse than one that says so.
export async function copyNoteText(note) {
  return (await writeClipboard(noteAsText(note))) ? 'Copied' : COPY_BLOCKED
}

// The note's shareable text in one of two formats — ONE code path with a
// format switch, deliberately not two functions:
//   'plain' — markdown stripped to its readable shape (see toPlainText):
//             checklists → ☐/☑, headers bare, **/*/~~ markers dropped,
//             links → "label (url)"; bullets and numbers keep their visible
//             marker. What a human reads in Messages/Mail.
//   'raw'   — the note's text unmodified, markers intact. Not reachable from
//             any UI yet; it exists for Nubble-to-Nubble sharing, which needs
//             the markdown to survive the trip so the receiving app can
//             render it.
// Both build on noteAsText: title (when there is one), blank line, body — a
// titleless note is just the body, no stray leading blank line.
export function noteShareText(note, format = 'plain') {
  const text = noteAsText(note)
  return format === 'plain' ? toPlainText(text) : text
}

// Hand the note to the system share sheet, falling back to the clipboard where there
// isn't one. Returns the toast to show, or null for "say nothing".
//
// Nothing is said on success: the share sheet is its own confirmation, and a toast after
// it closes would be the app congratulating itself. Nothing is said on AbortError either
// — that is what fires when the sheet is dismissed without picking anything, which is a
// user changing their mind, not a failure.
export async function shareNoteText(note, format = 'plain') {
  // Shared text is READ by default, not round-tripped — 'plain' unless a
  // caller (a future Nubble-to-Nubble path) asks for 'raw'. Copy above stays
  // raw markdown on purpose — pasted text keeps its structure.
  const text = noteShareText(note, format)
  if (!canShareNotes()) {
    // The intent was share, so the clipboard gets the same formatted text the
    // sheet would have carried — not Copy's raw markdown. Named differently
    // from a plain Copy on purpose: the user asked to share and got a
    // clipboard instead, so the toast has to account for the substitution.
    return (await writeClipboard(text)) ? 'Copied to clipboard' : COPY_BLOCKED
  }
  try {
    await navigator.share({ title: noteTitle(note) || 'Note', text })
    return null
  } catch (err) {
    if (err?.name === 'AbortError') return null
    return "Couldn't share"
  }
}
