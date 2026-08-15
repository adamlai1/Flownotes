export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2)
}

// Sentinel ID marking a note explicitly pinned to its project's root canvas,
// stored inside bubble_ids alongside real bubble memberships. Canonically
// defined here, right next to realBubbleIds, so the sentinel and its filter
// can never drift apart; data/defaultData re-exports it for existing
// importers. (helpers.js must not import defaultData — that would be a
// circular import, since defaultData imports generateId from here.)
export const ROOT_BUBBLE_ID = '__root__'

// A note's REAL bubble memberships: bubble_ids minus the '__root__' canvas
// sentinel. Accepts a note object or a bare bubble_ids array. Use this —
// never open-code the filter — wherever emptiness, counts, or matching of
// bubble membership matter, so no check can quietly treat the sentinel as a
// real bubble.
export function realBubbleIds(noteOrIds) {
  const ids = Array.isArray(noteOrIds) ? noteOrIds : noteOrIds?.bubble_ids
  return (ids ?? []).filter(bid => bid !== ROOT_BUBBLE_ID)
}

// A connection's relationship label. Connection objects historically carried
// it under two names — the editor wrote `relationship_type`, the cloud loader
// produced `type` — and the uploader read only `type`, so editor-created
// connections uploaded with no label at all (the bug that kept the
// connections table empty). New connections are written with `type`; this
// accessor is the ONLY sanctioned way to read the label, so legacy local
// objects keep working everywhere.
export function connectionType(conn) {
  return conn?.type ?? conn?.relationship_type ?? null
}

export function formatDate(isoString) {
  const date = new Date(isoString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) + ' at ' + date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export function formatDateGroup(isoString) {
  const date = new Date(isoString)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

// Returns the display title for a note: first non-empty line of content, or '' if blank
export function getNoteTitle(content) {
  if (!content?.trim()) return ''
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

export function getPreview(content, lines = 3) {
  if (!content) return ''
  const allLines = content.split('\n').filter(l => l.trim())
  return allLines.slice(0, lines).join('\n')
}

export function getBubbleById(bubbles, id) {
  return bubbles.find(b => b.id === id)
}

export function getBubbleChildren(bubbles, parentId) {
  return bubbles.filter(b => b.parent_id === parentId)
}

export function getBubbleDescendantIds(bubbles, bubbleId) {
  const result = [bubbleId]
  const children = getBubbleChildren(bubbles, bubbleId)
  for (const child of children) {
    result.push(...getBubbleDescendantIds(bubbles, child.id))
  }
  return result
}

export function getNoteCountForBubble(notes, bubbleId, bubbles) {
  const ids = getBubbleDescendantIds(bubbles, bubbleId)
  return notes.filter(n => realBubbleIds(n).some(bid => ids.includes(bid))).length
}

export function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? '#1f2937' : '#ffffff'
}
