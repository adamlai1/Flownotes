import { getNoteTitle, noteTitle } from './helpers'

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

// Put the note on the clipboard. Returns the toast to show, always — a copy that goes
// nowhere silently is worse than one that says so.
//
// The clipboard API needs a secure context, so this fails on a plain-http origin: testing
// over a LAN IP will show "Couldn't copy" while the deployed HTTPS site is fine. That is
// the environment failing, not the note, which is why the message says what it does
// rather than blaming the content.
export async function copyNoteText(note) {
  try {
    await navigator.clipboard.writeText(noteAsText(note))
    return 'Copied'
  } catch {
    return "Couldn't copy"
  }
}

// Hand the note to the system share sheet, falling back to the clipboard where there
// isn't one. Returns the toast to show, or null for "say nothing".
//
// Nothing is said on success: the share sheet is its own confirmation, and a toast after
// it closes would be the app congratulating itself. Nothing is said on AbortError either
// — that is what fires when the sheet is dismissed without picking anything, which is a
// user changing their mind, not a failure.
export async function shareNoteText(note) {
  const text = noteAsText(note)
  if (!canShareNotes()) {
    const result = await copyNoteText(note)
    // Named differently from a plain Copy on purpose: the user asked to share and got a
    // clipboard instead, so the toast has to account for the substitution.
    return result === 'Copied' ? 'Copied to clipboard' : result
  }
  try {
    await navigator.share({ title: noteTitle(note) || 'Note', text })
    return null
  } catch (err) {
    if (err?.name === 'AbortError') return null
    return "Couldn't share"
  }
}
