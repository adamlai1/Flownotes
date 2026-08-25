import { flattenBubbleTree, countExpandedBubbleRows, collapsibleBubbleIds } from '../utils/bubbleTree'
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
  maxExpandedRows,       // unbounded container: expand iff full row count ≤ this
  renderRow,             // (bubble) => the row button; rendered flex-1 beside the chevron
}) {
  const rowCount = countExpandedBubbleRows(bubbles, { hiddenIds })
  const parentIds = collapsibleBubbleIds(bubbles, { hiddenIds })
  const { collapsedIds, isExpanded, toggleExpanded } = useFitCollapse({
    rowCount, parentIds, rowHeight, extraHeight, measureAvailable, observeResize, maxExpandedRows,
  })
  const rows = flattenBubbleTree(bubbles, { hiddenIds, collapsedIds })

  return (
    <>
      {rows.map(({ bubble, depth, hasChildren }) => (
        <div
          key={bubble.id}
          className="flex items-stretch"
          style={{ paddingLeft: depth * indentPerLevel, minHeight: rowHeight }}
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
