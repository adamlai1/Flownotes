import { useState, useRef, useEffect, useMemo, useContext, createContext, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getNoteCountForBubble } from '../utils/helpers'
import BubbleNameInput from './BubbleNameInput'
import BubbleColorPicker from './BubbleColorPicker'
import { buildLockIndex } from '../utils/locks'
import { useLock } from '../contexts/LockContext'
import { useEscapeLayer, ESC_LEVEL } from '../lib/escapeStack'
import {
  LONG_PRESS_MENU_MS, DRAG_PICKUP_PAGED_MS, PRESS_MOVE_CANCEL_PX,
} from '../utils/pressArbitration'

// EXPERIMENT (neutral scheme): selected-row treatment, switchable for comparison.
//   'tint'   — low-opacity wash of the bubble's own colour as the row background
//   'accent' — 3px bar of the bubble's full colour on the left, neutral background
//   'indigo' — the previous treatment (bg-indigo-950 text-indigo-400), i.e. revert
// In 'tint' and 'accent' the label keeps the theme's normal text colour, so
// readability never depends on the user-chosen bubble colour — the colour only
// appears as a translucent wash or a thin bar. A gated (locked) selected row
// falls back to the neutral hover tone so the tint can't leak the hidden colour.
const SELECTED_ROW_VARIANT = 'tint'

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
  onChangeBubbleColor,
  lockIndex,
  onRequestUnlock,
  onToggleLock,
}) {
  const [expanded, setExpanded] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [pickingColor, setPickingColor] = useState(false)
  const { draggingId, dropTarget, startDrag, cancelDrag } = useContext(DragContext)
  // Press-and-hold arbitration state for the current press (see handleRowPointerDown),
  // and a flag that eats the click a drag or menu press would otherwise leave behind.
  const pressRef = useRef(null)
  const suppressClickRef = useRef(false)
  const children = bubbles.filter(b => b.parent_id === bubble.id)
  // A locked bubble is hidden here too, or the sidebar would be a way around the
  // lock: its name, its note count and (by selecting it) its whole contents.
  const gated = !!lockIndex?.gatedBubbleIds.has(bubble.id)
  const noteCount = gated ? 0 : getNoteCountForBubble(notes, bubble.id, bubbles)
  const isSelected = activeBubbleId === bubble.id
  // Children of a locked bubble aren't listed at all — even as "Locked" rows they'd
  // give away how much is nested inside.
  const showChildren = (expanded || forceExpandIds.has(bubble.id)) && !gated
  const isDragging = draggingId === bubble.id
  const isNestTarget = dropTarget?.kind === 'nest' && dropTarget.id === bubble.id

  useEscapeLayer(showDeleteConfirm, () => setShowDeleteConfirm(false), ESC_LEVEL.modal)
  useEscapeLayer(pickingColor, () => setPickingColor(false), ESC_LEVEL.modal)

  function handleRename() {
    const name = renameValue.trim()
    if (name) onRenameBubble(bubble.id, name)
    setRenaming(false)
  }

  function handleDelete() {
    setShowDeleteConfirm(true)
  }

  // Press-and-hold arbitration — the same sequence as the canvas (see
  // utils/pressArbitration.js): a stationary press picks the row up for
  // drag-to-reorder, holding still all the way to the menu threshold abandons
  // the pickup and opens the options menu, and moving early hands the press
  // to the scroller. A plain tap resolves before either timer and selects via
  // the row's onClick as before.
  function handleRowPointerDown(e) {
    if (e.button != null && e.button !== 0) return
    const st = {
      mode: 'pending',
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      dragTimer: null, menuTimer: null,
    }
    pressRef.current = st

    const clearTimers = () => {
      if (st.dragTimer) { clearTimeout(st.dragTimer); st.dragTimer = null }
      if (st.menuTimer) { clearTimeout(st.menuTimer); st.menuTimer = null }
    }
    const teardown = () => {
      clearTimers()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      if (pressRef.current === st) pressRef.current = null
    }

    const onMove = (ev) => {
      if (st.mode === 'menu') return
      st.lastX = ev.clientX; st.lastY = ev.clientY
      if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) > PRESS_MOVE_CANCEL_PX) {
        // Moved → this press is never a menu; before pickup it's a scroll, so
        // the press dies and the scroller keeps the gesture.
        if (st.menuTimer) { clearTimeout(st.menuTimer); st.menuTimer = null }
        if (st.mode === 'pending') teardown()
      }
    }
    const onUp = () => {
      teardown()
      // The click that follows this release must be eaten if the press became a
      // drag or a menu — cleared on a macrotask so the click sees the flag first.
      setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    const onCancel = () => {
      if (st.mode === 'drag') cancelDrag()
      teardown()
      setTimeout(() => { suppressClickRef.current = false }, 0)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)

    st.dragTimer = setTimeout(() => {
      st.dragTimer = null
      if (pressRef.current !== st || st.mode !== 'pending') return
      st.mode = 'drag'
      suppressClickRef.current = true
      navigator.vibrate?.(40)
      startDrag(bubble, {
        clientX: st.lastX, clientY: st.lastY,
        preventDefault() {}, stopPropagation() {},
      })
    }, DRAG_PICKUP_PAGED_MS)

    st.menuTimer = setTimeout(() => {
      st.menuTimer = null
      if (pressRef.current !== st) return
      if (st.mode === 'drag') cancelDrag()
      st.mode = 'menu'
      suppressClickRef.current = true
      navigator.vibrate?.(15)
      setMenuOpen(true)
    }, LONG_PRESS_MENU_MS)
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
        {/* Expand/collapse toggle */}
        {children.length > 0 && !gated ? (
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
            <div className="flex-1 min-w-0">
              <BubbleNameInput
                autoFocus
                value={renameValue}
                onChange={setRenameValue}
                onSubmit={handleRename}
                onCancel={() => setRenaming(false)}
                // Its own name is a sibling, so the list won't offer the name it
                // already has — nor any other name taken at this level.
                exclude={bubbles
                  .filter(b => (b.parent_id ?? null) === (bubble.parent_id ?? null))
                  .map(b => b.name)}
                ariaLabel="Rename bubble"
                className="w-full px-1.5 py-0.5 text-xs border border-indigo-600 rounded outline-none bg-gray-800 text-white"
              />
            </div>
            <button onClick={handleRename} className="text-xs text-indigo-400 font-medium px-1">OK</button>
          </div>
        ) : (
          <button
            onPointerDown={handleRowPointerDown}
            onClick={() => {
              if (suppressClickRef.current) { suppressClickRef.current = false; return }
              gated ? onRequestUnlock?.(bubble) : onSelectBubble(bubble.id)
            }}
            className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-base transition-colors text-left min-w-0 ${
              isSelected
                ? (SELECTED_ROW_VARIANT === 'indigo' ? 'bg-indigo-950 text-indigo-400 font-medium' : 'font-medium')
                : 'text-gray-300 hover:bg-gray-800'
            }`}
            style={{
              minHeight: 38,
              ...(isSelected && SELECTED_ROW_VARIANT !== 'indigo'
                ? gated
                  ? { background: 'var(--hover)', color: 'var(--text)' }
                  : SELECTED_ROW_VARIANT === 'tint'
                    ? { background: `${bubble.color}26`, color: 'var(--text)' }
                    : { background: 'var(--hover)', color: 'var(--text)', boxShadow: `inset 3px 0 0 0 ${bubble.color}` }
                : {}),
            }}
          >
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: gated ? 'var(--text-faint)' : bubble.color }}
            />
            {gated ? (
              <>
                <svg className="w-3 h-3 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span className="truncate text-gray-500">Locked</span>
              </>
            ) : (
              <span className="truncate">{bubble.name}</span>
            )}
            <span className="ml-auto text-xs text-gray-400 opacity-70 flex-shrink-0">{noteCount || ''}</span>
          </button>
        )}

        {/* Actions dropdown — opened by press-and-hold on the row */}
        {menuOpen && !renaming && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div
              className="absolute right-0 top-full mt-0.5 flex flex-col rounded-lg shadow-lg z-20 py-1 min-w-[130px]"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
            >
              {gated ? (
                /* Add child / Rename are withheld while locked — the rename field
                   would put the hidden name straight back on screen. */
                <button
                  onClick={() => { onRequestUnlock?.(bubble); setMenuOpen(false) }}
                  className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
                >
                  Unlock
                </button>
              ) : (
                <>
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
                onClick={() => { setPickingColor(true); setMenuOpen(false) }}
                className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Change color
              </button>
              <button
                onClick={() => { onToggleLock?.(bubble); setMenuOpen(false) }}
                className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                {bubble.locked ? 'Remove Lock' : 'Lock'}
              </button>
                </>
              )}
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
              onChangeBubbleColor={onChangeBubbleColor}
              lockIndex={lockIndex}
              onRequestUnlock={onRequestUnlock}
              onToggleLock={onToggleLock}
            />
          ))}
        </div>
      )}

      {createPortal(
        <AnimatePresence>
          {showDeleteConfirm && (
            <motion.div
              key="bubble-delete-modal"
              data-modal
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

      {createPortal(
        <AnimatePresence>
          {pickingColor && (
            <motion.div
              key="bubble-color-modal"
              data-modal
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 flex items-center justify-center z-50"
              style={{ background: 'rgba(0,0,0,0.6)' }}
              onClick={() => setPickingColor(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{ duration: 0.15 }}
                className="mx-6 w-full max-w-xs rounded-2xl p-5"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                onClick={e => e.stopPropagation()}
              >
                <h2 className="text-white font-semibold text-base text-center mb-4 truncate">{bubble.name}</h2>
                <BubbleColorPicker
                  value={bubble.color}
                  onChange={c => { onChangeBubbleColor?.(bubble.id, c); setPickingColor(false) }}
                />
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
  onChangeBubbleColor,
  onSetBubbleLocked,
}) {
  const rootBubbles = bubbles.filter(b => b.parent_id === parentId)
  const forceExpandIds = getAncestorIds(bubbles, activeBubbleId)
  const { unlockedIds, requestUnlock, ensurePassword, relockIds } = useLock()
  const lockIndex = useMemo(
    () => buildLockIndex(bubbles, notes, unlockedIds),
    [bubbles, notes, unlockedIds]
  )
  // Unlocking from the sidebar reveals the bubble in place; it doesn't navigate.
  function handleRequestUnlock(bubble) {
    requestUnlock(lockIndex.gatingIdsFor({ ...bubble, type: 'bubble' }))
  }

  // Same decision the canvas menu's toggleItemLock makes, for a sidebar row.
  function handleToggleLock(bubble) {
    if (lockIndex.gatedBubbleIds.has(bubble.id)) {
      handleRequestUnlock(bubble)
      return
    }
    if (bubble.locked) { onSetBubbleLocked?.(bubble.id, false); return }
    ensurePassword(() => { relockIds(bubble.id); onSetBubbleLocked?.(bubble.id, true) })
  }

  // drag = { id, name, color, x, y } while a drag is in progress, else null.
  const [drag, setDrag] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  // Root element of the tree — used to find the enclosing scroll container for
  // edge auto-scroll during a drag.
  const treeRef = useRef(null)
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

  // Abandon an in-flight drag without moving anything — used when a held press
  // gives up the pickup in favor of the row's menu, mirroring the canvas.
  function cancelDrag() {
    document.body.classList.remove('bubble-dragging')
    setDrag(null)
    setDropTarget(null)
    dragIdRef.current = null
    forbiddenRef.current = null
    dropRef.current = null
  }

  // Global pointer listeners live only while a drag is active.
  useEffect(() => {
    if (!drag) return

    // Last known pointer position — shared by the move handler and the
    // auto-scroll loop, which re-resolves the drop target while the list moves
    // under a stationary pointer.
    const last = { x: drag.x, y: drag.y }

    function updateDropTarget(x, y) {
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

    function onMove(e) {
      const x = e.clientX, y = e.clientY
      last.x = x; last.y = y
      setDrag(d => (d ? { ...d, x, y } : d))
      updateDropTarget(x, y)
    }

    // ── Edge auto-scroll ────────────────────────────────────────────────────
    // Holding the drag near the scroll container's top or bottom edge scrolls
    // the list so a bubble can be dropped outside the current viewport. Speed
    // ramps with proximity: ~0 at the zone's inner boundary, EDGE_SCROLL_MAX_SPEED
    // at (or past) the very edge. scrollTop is set programmatically and clamped
    // by the browser at the ends, so it never enters the overscroll range and
    // never triggers the container's rubber-band bounce.
    const EDGE_SCROLL_ZONE = 48         // px from each edge
    const EDGE_SCROLL_MAX_SPEED = 700   // px/s at the very edge
    let scroller = null
    for (let el = treeRef.current?.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        scroller = el
        break
      }
    }

    let rafId = null
    let lastFrameT = null
    function autoScrollFrame(t) {
      rafId = requestAnimationFrame(autoScrollFrame)
      if (!scroller) return
      const dt = lastFrameT == null ? 16 : Math.min(48, t - lastFrameT)
      lastFrameT = t
      const rect = scroller.getBoundingClientRect()
      let dir = 0, ratio = 0
      if (last.y < rect.top + EDGE_SCROLL_ZONE) {
        dir = -1
        ratio = Math.min(1, (rect.top + EDGE_SCROLL_ZONE - last.y) / EDGE_SCROLL_ZONE)
      } else if (last.y > rect.bottom - EDGE_SCROLL_ZONE) {
        dir = 1
        ratio = Math.min(1, (last.y - (rect.bottom - EDGE_SCROLL_ZONE)) / EDGE_SCROLL_ZONE)
      }
      if (!dir) return
      const before = scroller.scrollTop
      scroller.scrollTop = before + dir * EDGE_SCROLL_MAX_SPEED * ratio * (dt / 1000)
      // At the ends scrollTop stops changing — nothing to re-resolve then. The
      // drop indicator only needs a refresh when rows actually moved under the
      // pointer.
      if (scroller.scrollTop !== before) updateDropTarget(last.x, last.y)
    }
    rafId = requestAnimationFrame(autoScrollFrame)

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

    // The drag now starts from a press on a pan-y scroll surface (no dedicated
    // handle), so native scrolling must be blocked for the drag's duration or
    // the first vertical move would scroll the list and cancel the pointer.
    // The pickup only fires on a stationary press, so no scroll is in flight yet.
    function preventScroll(e) { e.preventDefault() }
    window.addEventListener('touchmove', preventScroll, { passive: false })

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('touchmove', preventScroll)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    // Only (re)subscribe when a drag starts or ends, not on every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag != null])

  // Safety: always drop the body class if this tree unmounts mid-drag.
  useEffect(() => () => document.body.classList.remove('bubble-dragging'), [])

  const ctx = { draggingId: drag?.id ?? null, dropTarget, startDrag, cancelDrag }

  return (
    <DragContext.Provider value={ctx}>
      <div ref={treeRef}>
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
              onChangeBubbleColor={onChangeBubbleColor}
              lockIndex={lockIndex}
              onRequestUnlock={handleRequestUnlock}
              onToggleLock={handleToggleLock}
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
