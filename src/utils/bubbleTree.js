// Shared tree shape for every surface that lists bubbles hierarchically —
// the sidebar tree and both bubble pickers (canvas "Add to", note view).
// They all must present the same ordering (array order within a parent,
// parents before children) and the same collapse semantics, so the walk
// lives here and nowhere else.

export function bubbleChildren(bubbles, parentId = null) {
  return bubbles.filter(b => b.parent_id === parentId)
}

// Flatten the tree into ordered rows of { bubble, depth, hasChildren }.
//   hiddenIds          — bubbles omitted entirely, subtree included
//                        (pickers withhold gated/locked bubbles this way)
//   childrenWithheldIds — the bubble's own row shows but its children are
//                        never listed (the sidebar's "Locked" rows)
//   collapsedIds       — row shows, children skipped; hasChildren stays true
//                        so the caller still renders a chevron
export function flattenBubbleTree(bubbles, {
  rootId = null,
  collapsedIds = null,
  hiddenIds = null,
  childrenWithheldIds = null,
} = {}) {
  const rows = []
  const walk = (parentId, depth) => {
    for (const bubble of bubbleChildren(bubbles, parentId)) {
      if (hiddenIds?.has(bubble.id)) continue
      const hasChildren = !childrenWithheldIds?.has(bubble.id) &&
        bubbleChildren(bubbles, bubble.id).some(c => !hiddenIds?.has(c.id))
      rows.push({ bubble, depth, hasChildren })
      if (hasChildren && !collapsedIds?.has(bubble.id)) walk(bubble.id, depth + 1)
    }
  }
  walk(rootId, 0)
  return rows
}

// Rows the FULLY EXPANDED tree would show — the row count the fit check
// multiplies by the row height. Rows are uniform height on every surface,
// so fit is arithmetic; nothing is rendered to find out.
export function countExpandedBubbleRows(bubbles, opts = {}) {
  return flattenBubbleTree(bubbles, { ...opts, collapsedIds: null }).length
}

// Ids of every row that carries a chevron — the set "collapse everything"
// collapses.
export function collapsibleBubbleIds(bubbles, opts = {}) {
  return flattenBubbleTree(bubbles, { ...opts, collapsedIds: null })
    .filter(r => r.hasChildren)
    .map(r => r.bubble.id)
}
