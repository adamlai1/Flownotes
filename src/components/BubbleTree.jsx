import { useState, useRef, useEffect, useContext, createContext, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getNoteCountForBubble } from '../utils/helpers'

// Shared drag state for the whole tree. Provided by BubbleTree, consumed by every
// BubbleNode and RootDropZone so they can start drags and render drop indicators.
const DragContext = createContext(null)

function BubbleNode({
  bubble,
  bubbles,
  notes,
  depth,
  activeBubbleId,
  forceExpandIds,
  onSelectBubble,
  onRenameBubble,
  onDeleteBubble,
  onAddChildBubble,
}) {
  const [expanded, setExpanded] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const { draggingId, dropTarget, startDrag } = useContext(DragContext)
  const children = bubbles.filter(b => b.parent_id === bubble.id)
  const noteCount = getNoteCountForBubble(notes, bubble.id, bubbles)
  const isSelected = activeBubbleId === bubble.id
  const showChildren = expanded || forceExpandIds.has(bubble.id)
  const isDragging = draggingId === bubble.id
  const isNestTarget = dropTarget?.kind === 'nest' && dropTarget.id === bubble.id

  function handleRename() {
    const name = renameValue.trim()
    if (name) onRenameBubble(bubble.id, name)
    setRenaming(false)
  }

  function handleDelete() {
    setShowDeleteConfirm(true)
  }

  return (
    <div>
      <div
        data-drop-nest={bubble.id}
        className="relative flex items-center group rounded-lg"
        style={{
          paddingLeft: `${depth * 12}px`,
          opacity: isDragging ? 0.4 : 1,
          // Highlight the row when it's the "nest into this bubble" drop target.
          outline: isNestTarget ? '2px solid #6366f1' : '2px solid transparent',
          outlineOffset: -2,
          background: isNestTarget ? 'rgba(99,102,241,0.15)' : 'transparent',
          transition: 'background 100ms, outline-color 100ms',
        }}
      >
        {/* Drag handle — grab to reparent. touch-action:none so a drag from here
            doesn't scroll the sidebar on touch devices. */}
        <button
          onPointerDown={e => startDrag(bubble, e)}
          onClick={e => e.stopPropagation()}
          className="w-4 h-6 flex items-center justify-center text-gray-700 hover:text-gray-400 flex-shrink-0"
          style={{ touchAction: 'none', cursor: 'grab' }}
          title="Drag to move"
          aria-label="Drag to move bubble"
        >
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
            <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
            <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
          </svg>
        </button>

        {/* Expand/collapse toggle */}
        {children.length > 0 ? (
          <button
            onClick={() => setExpanded(e => !e)}
            className="w-4 h-4 flex items-center justify-center text-gray-600 hover:text-gray-400 flex-shrink-0"
          >
            <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {renaming ? (
          <div className="flex-1 flex items-center gap-1 py-0.5">
            <input
              autoFocus
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
              className="flex-1 px-1.5 py-0.5 text-xs border border-indigo-600 rounded outline-none bg-gray-800 text-white"
            />
            <button onClick={handleRename} className="text-xs text-indigo-400 font-medium px-1">OK</button>
          </div>
        ) : (
          <button
            onClick={() => onSelectBubble(bubble.id)}
            className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors text-left min-w-0 ${
              isSelected ? 'bg-indigo-950 text-indigo-400 font-medium' : 'text-gray-300 hover:bg-gray-800'
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: bubble.color }}
            />
            <span className="truncate">{bubble.name}</span>
            <span className="ml-auto text-xs text-gray-400 flex-shrink-0">{noteCount || ''}</span>
          </button>
        )}

        {/* Actions menu toggle — always visible */}
        {!renaming && (
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(m => !m) }}
            className="flex-shrink-0 p-1.5 text-gray-700 hover:text-gray-400 rounded"
            title="Bubble options"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
            </svg>
          </button>
        )}

        {/* Actions dropdown */}
        {menuOpen && !renaming && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full mt-0.5 flex flex-col bg-gray-900 rounded-lg shadow-lg border border-gray-800 z-20 py-1 min-w-[130px]">
              <button
                onClick={() => { onAddChildBubble(bubble.id); setMenuOpen(false) }}
                className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Add child
              </button>
              <button
                onClick={() => { setRenaming(true); setRenameValue(bubble.name); setMenuOpen(false) }}
                className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Rename
              </button>
              <button
                onClick={() => { handleDelete(); setMenuOpen(false) }}
                className="text-left px-3 py-2 text-sm text-red-500 hover:bg-red-950"
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>

      {showChildren && children.length > 0 && (
        <div>
          {children.map(child => (
            <BubbleNode
              key={child.id}
              bubble={child}
              bubbles={bubbles}
              notes={notes}
              depth={depth + 1}
              activeBubbleId={activeBubbleId}
              forceExpandIds={forceExpandIds}
              onSelectBubble={onSelectBubble}
              onRenameBubble={onRenameBubble}
              onDeleteBubble={onDeleteBubble}
              onAddChildBubble={onAddChildBubble}
            />
          ))}
        </div>
      )}

      {createPortal(
        <AnimatePresence>
          {showDeleteConfirm && (
            <motion.div
              key="bubble-delete-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 flex items-center justify-center z-50"
              style={{ background: 'rgba(0,0,0,0.6)' }}
              onClick={() => setShowDeleteConfirm(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{ duration: 0.15 }}
                className="mx-6 w-full max-w-xs rounded-2xl p-6"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                onClick={e => e.stopPropagation()}
              >
                <h2 className="text-white font-semibold text-lg text-center mb-1">Delete Bubble?</h2>
                <p className="text-gray-400 text-sm text-center mb-5">This cannot be undone.</p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { setShowDeleteConfirm(false); onDeleteBubble(bubble.id) }}
                    className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}

// A drop zone in the gap above/below a root bubble. Dropping here moves the dragged
// bubble to the root level (parent_id = null).
function RootDropZone({ zoneId }) {
  const { draggingId, dropTarget } = useContext(DragContext)
  const active = draggingId != null
  const isOver = dropTarget?.kind === 'root' && dropTarget.zone === zoneId
  return (
    <div
      data-drop-root={zoneId}
      style={{
        // Idle: a hairline gap. During a drag: a taller, easy-to-hit target.
        height: active ? 12 : 3,
        display: 'flex',
        alignItems: 'center',
        transition: 'height 120ms',
      }}
    >
      <div
        style={{
          height: isOver ? 3 : 2,
          width: '100%',
          borderRadius: 2,
          background: isOver ? '#6366f1' : 'transparent',
          transition: 'background 100ms',
        }}
      />
    </div>
  )
}

function getAncestorIds(bubbles, targetId) {
  const ids = new Set()
  let bubble = bubbles.find(b => b.id === targetId)
  while (bubble?.parent_id) {
    ids.add(bubble.parent_id)
    bubble = bubbles.find(b => b.id === bubble.parent_id)
  }
  return ids
}

export default function BubbleTree({
  bubbles,
  notes,
  parentId,
  selectedBubbleId,
  activeBubbleId,
  onSelectBubble,
  onRenameBubble,
  onDeleteBubble,
  onMoveBubble,
  onAddChildBubble,
}) {
  const rootBubbles = bubbles.filter(b => b.parent_id === parentId)
  const forceExpandIds = getAncestorIds(bubbles, activeBubbleId)

  // drag = { id, name, color, x, y } while a drag is in progress, else null.
  const [drag, setDrag] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  // Refs so the global pointer listeners always read the latest values without
  // re-subscribing on every pointer move.
  const dragIdRef = useRef(null)
  const forbiddenRef = useRef(null) // ids the dragged bubble may not nest into
  const dropRef = useRef(null)

  function startDrag(bubble, e) {
    // Only start on primary button / touch / pen.
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    // Ids that would create a cycle: the bubble itself and all its descendants.
    const forbidden = new Set()
    ;(function collect(id) {
      forbidden.add(id)
      bubbles.filter(b => b.parent_id === id).forEach(c => collect(c.id))
    })(bubble.id)
    forbiddenRef.current = forbidden
    dragIdRef.current = bubble.id
    dropRef.current = null
    setDropTarget(null)
    setDrag({ id: bubble.id, name: bubble.name, color: bubble.color, x: e.clientX, y: e.clientY })
    document.body.classList.add('bubble-dragging')
  }

  // Global pointer listeners live only while a drag is active.
  useEffect(() => {
    if (!drag) return

    function onMove(e) {
      const x = e.clientX, y = e.clientY
      setDrag(d => (d ? { ...d, x, y } : d))
      // The floating preview has pointer-events:none, so elementFromPoint returns
      // the row/zone underneath rather than the preview.
      const el = document.elementFromPoint(x, y)
      if (!el) { setDropTarget(null); dropRef.current = null; return }

      const rootEl = el.closest('[data-drop-root]')
      if (rootEl) {
        const t = { kind: 'root', zone: rootEl.getAttribute('data-drop-root') }
        setDropTarget(t); dropRef.current = t
        return
      }

      const nestEl = el.closest('[data-drop-nest]')
      if (nestEl) {
        const id = nestEl.getAttribute('data-drop-nest')
        // Can't nest a bubble into itself or its own descendants.
        if (forbiddenRef.current?.has(id)) { setDropTarget(null); dropRef.current = null; return }
        const t = { kind: 'nest', id }
        setDropTarget(t); dropRef.current = t
        return
      }

      setDropTarget(null); dropRef.current = null
    }

    function onUp() {
      const t = dropRef.current
      const id = dragIdRef.current
      if (id && t) {
        if (t.kind === 'root') onMoveBubble?.(id, null)
        else if (t.kind === 'nest') onMoveBubble?.(id, t.id)
      }
      // Cleanup
      document.body.classList.remove('bubble-dragging')
      setDrag(null)
      setDropTarget(null)
      dragIdRef.current = null
      forbiddenRef.current = null
      dropRef.current = null
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    // Only (re)subscribe when a drag starts or ends, not on every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag != null])

  // Safety: always drop the body class if this tree unmounts mid-drag.
  useEffect(() => () => document.body.classList.remove('bubble-dragging'), [])

  const ctx = { draggingId: drag?.id ?? null, dropTarget, startDrag }

  return (
    <DragContext.Provider value={ctx}>
      <div>
        <RootDropZone zoneId="0" />
        {rootBubbles.map((bubble, i) => (
          <Fragment key={bubble.id}>
            <BubbleNode
              bubble={bubble}
              bubbles={bubbles}
              notes={notes}
              depth={0}
              activeBubbleId={activeBubbleId}
              forceExpandIds={forceExpandIds}
              onSelectBubble={onSelectBubble}
              onRenameBubble={onRenameBubble}
              onDeleteBubble={onDeleteBubble}
              onAddChildBubble={onAddChildBubble}
            />
            <RootDropZone zoneId={String(i + 1)} />
          </Fragment>
        ))}
      </div>

      {/* Floating drag preview follows the pointer. */}
      {drag && createPortal(
        <div
          style={{
            position: 'fixed',
            left: drag.x + 10,
            top: drag.y + 10,
            zIndex: 9999,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 8,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            fontSize: 13,
            opacity: 0.95,
            boxShadow: '0 6px 16px rgba(0,0,0,0.45)',
          }}
        >
          <span style={{ width: 10, height: 10, borderRadius: 9999, background: drag.color, flexShrink: 0 }} />
          {drag.name}
        </div>,
        document.body
      )}
    </DragContext.Provider>
  )
}
