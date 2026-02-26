export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2)
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
  return notes.filter(n => n.bubble_ids.some(bid => ids.includes(bid))).length
}

export function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? '#1f2937' : '#ffffff'
}
