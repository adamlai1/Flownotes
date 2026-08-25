import { useLayoutEffect, useRef, useState, useCallback } from 'react'

// Fit-based auto-collapse for a bubble tree: expand every branch when the
// fully-expanded tree fits inside its container, otherwise collapse every
// branch. All-or-nothing — partial expansion produces an opening state the
// user can't predict — and strictly an OPENING decision:
//
//   - Fit is COMPUTED (uniform rows × rowHeight + fixed extras), never read
//     back from a rendered tree, so there is no expand-then-collapse flash.
//     Only the container's own geometry is measured, in a layout effect
//     before first paint.
//   - The decision re-runs on container resize and when the tree changes
//     shape (bubble created / deleted / moved) — but the moment the user
//     touches a chevron, their state owns the session and the rule never
//     overrides it again. The session ends when `active` goes false; state
//     is kept while closing (so branches don't visibly snap shut during a
//     close animation) and decided afresh on the next open.
export function useFitCollapse({
  active = true,     // surface is on screen; false→true starts a new session
  rowCount,          // rows the fully expanded tree would show
  parentIds,         // ids of rows that carry a chevron
  rowHeight,         // uniform row height, px
  extraHeight = 0,   // fixed non-row height (separators, padding), px
  measureAvailable,  // () => available px, or null when unknowable (→ expand)
  observeResize,     // optional: () => Element whose resize re-runs the check
}) {
  // null = no decision yet. It reads as all-collapsed, and a real decision
  // lands in a layout effect before that render is ever painted.
  const [collapsed, setCollapsed] = useState(null)
  const touchedRef = useRef(false)
  const prevActiveRef = useRef(false)

  // Latest inputs, so decide() stays identity-stable for the effects below.
  const latestRef = useRef(null)
  latestRef.current = { rowCount, parentIds, rowHeight, extraHeight, measureAvailable }

  const decide = useCallback(() => {
    const { rowCount, parentIds, rowHeight, extraHeight, measureAvailable } = latestRef.current
    const available = measureAvailable?.() ?? null
    const fits = available == null || rowCount * rowHeight + extraHeight <= available
    setCollapsed(fits ? new Set() : new Set(parentIds))
  }, [])

  const parentsKey = parentIds.join(',')
  useLayoutEffect(() => {
    // Opening starts a fresh session: forget the last one's chevron use.
    if (active && !prevActiveRef.current) touchedRef.current = false
    prevActiveRef.current = active
    if (active && !touchedRef.current) decide()
  }, [active, rowCount, parentsKey, decide])

  useLayoutEffect(() => {
    if (!active || !observeResize || typeof ResizeObserver === 'undefined') return
    const el = observeResize()
    if (!el) return
    let first = true
    const ro = new ResizeObserver(() => {
      // The observer always fires once on observe(); the opening decision
      // already covered that layout.
      if (first) { first = false; return }
      if (!touchedRef.current) decide()
    })
    ro.observe(el)
    return () => ro.disconnect()
    // The observed element is re-resolved per session; other inputs flow
    // through decide()'s latestRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, decide])

  const effective = collapsed ?? new Set(parentIds)
  return {
    collapsedIds: effective,
    isExpanded: id => !effective.has(id),
    toggleExpanded: id => {
      touchedRef.current = true
      setCollapsed(prev => {
        const next = new Set(prev ?? parentIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
  }
}
