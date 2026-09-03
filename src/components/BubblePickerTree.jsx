import { flattenBubbleTree } from '../utils/bubbleTree'
import { useFitCollapse } from '../lib/useFitCollapse'

// The hierarchical bubble list shared by both pickers — the canvas "Add to"
// sheet and the note view's Bubble section. Rendering rows through one
// component, over the same tree walk the sidebar counts with, keeps the
// ordering, indentation and collapse behavior of every surface in sync.
//
// The chevron and the row are separate hit targets: the chevron only
// expands/collapses, the row (from renderRow) keeps whatever action the
// picker gives it — so a parent stays pickable as a destination while
// having children. The chevron column is a full-row-height, 32px-wide
// target; don't shrink it to fit more rows.
export default function BubblePickerTree({
  bubbles,
  hiddenIds = null,      // bubbles (with their subtrees) withheld, e.g. locked
  rowHeight,             // uniform row height — must match renderRow's real height
  extraHeight = 0,       // fixed container padding counted against the fit
  indentPerLevel = 16,
  measureAvailable,      // () => px the fully expanded tree may occupy
  observeResize,         // optional: () => Element to re-check on resize
  refitOnResize = false, // a resize re-decides even after a manual chevron (see useFitCollapse)
  active = true,         // fit session on/off (see useFitCollapse); pass false until the container is measurable
  overflowRatio = null,  // depth-limited fit: expanded height may reach this × available (see useFitCollapse)
  maxExpandedRows,       // unbounded container: expand iff full row count ≤ this
  renderRow,             // (bubble) => the row button; rendered flex-1 beside the chevron
}) {
  // One walk of the fully expanded tree feeds every input the fit rule needs:
  // the row count and chevron ids (all-or-nothing) and the per-row depths
  // (depth-limited).
  const expandedRows = flattenBubbleTree(bubbles, { hiddenIds })
  const rowCount = expandedRows.length
  const parentIds = expandedRows.filter(r => r.hasChildren).map(r => r.bubble.id)
  const { collapsedIds, isExpanded, toggleExpanded } = useFitCollapse({
    active, rowCount, parentIds, rowHeight, extraHeight, measureAvailable, observeResize, maxExpandedRows, refitOnResize,
    depthLimitRatio: overflowRatio, rows: expandedRows,
  })
  const rows = flattenBubbleTree(bubbles, { hiddenIds, collapsedIds })

  return (
    <>
      {rows.map(({ bubble, depth, hasChildren }) => (
        <div
          key={bubble.id}
          className="flex items-stretch"
          // Each row is a scroll-snap point: inert in containers that don't
          // declare a scroll-snap-type (the pickers), active where one does
          // (the note sheet's tree box), so no per-surface forking.
          style={{ paddingLeft: depth * indentPerLevel, minHeight: rowHeight, scrollSnapAlign: 'start' }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggleExpanded(bubble.id)}
              className="w-8 flex items-center justify-center flex-shrink-0"
              style={{ color: 'var(--text-muted)' }}
              aria-label={isExpanded(bubble.id) ? 'Collapse' : 'Expand'}
            >
              <svg
                className={`w-3 h-3 transition-transform ${isExpanded(bubble.id) ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <span className="w-8 flex-shrink-0" />
          )}
          {renderRow(bubble)}
        </div>
      ))}
    </>
  )
}
