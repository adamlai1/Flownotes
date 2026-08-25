import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CONNECTION_TYPES, CUSTOM_TAG_PALETTE, ROOT_BUBBLE_ID } from '../data/defaultData'
import { getNoteTitle, noteTitle, realBubbleIds, connectionType, generateId } from '../utils/helpers'
import { buildLockIndex } from '../utils/locks'
import { useLock } from '../contexts/LockContext'
import { useToast } from '../contexts/ToastContext'
import { copyNoteText } from '../utils/noteShare'
import { useEscapeLayer, ESC_LEVEL } from '../lib/escapeStack'
import { useBodyScrollLock } from '../lib/bodyScrollLock'
import BubblePickerTree from './BubblePickerTree'


function formatNoteDate(isoStr) {
  const d = new Date(isoStr)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}


export default function NoteEditor({ note, project, onClose, onUpdateNote, onDeleteNote, onUpdateCustomTagColors, onNavigateToNote, onSwipeProgress, backLabel = 'Notes', zIndex = 50 }) {
  const { unlockedIds, requestUnlock } = useLock()
  const showToast = useToast()
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = e => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  // Single source of truth: the full note text. The title shown in the header is
  // DERIVED from the first non-empty line, so the first line stays in the text and
  // is never pulled out / hidden.
  const [text, setText] = useState(note.content || '')
  // '' = no manual title: the header derives from the first body line and
  // follows it live. Non-empty = the user set it by hand; it stays fixed
  // until they clear it, which reverts to deriving (stored as null).
  const [customTitle, setCustomTitle] = useState((note.title ?? '').trim())
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleDraftInitialRef = useRef('')
  // A note always has at least one location: legacy notes saved with an empty
  // bubble_ids open as pinned to the project canvas, and the next save
  // persists that normalization.
  const [selectedBubbleIds, setSelectedBubbleIds] = useState(() =>
    (note.bubble_ids ?? []).length ? note.bubble_ids : [ROOT_BUBBLE_ID])
  const [tags, setTags] = useState(note.tags)
  const [tagInput, setTagInput] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [connections, setConnections] = useState(note.connections)
  const [addingConnection, setAddingConnection] = useState(false)
  const [connNoteId, setConnNoteId] = useState('')
  const [connType, setConnType] = useState(CONNECTION_TYPES[0])
  const [customConnType, setCustomConnType] = useState('')
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isClosing, setIsClosing] = useState(false)
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const bodyRef = useRef(null)
  const scrollAreaRef = useRef(null)

  // Desktop-only wheel chaining for the body textarea. Its
  // overscroll-behavior: contain (kept — it is what the touch path needs)
  // makes it a scroll container that swallows wheel events even when it has
  // nothing to scroll, so the editor page beneath never moves. Chain by
  // hand: with no overflow every wheel tick forwards to the scroll area;
  // with overflow the textarea scrolls natively and only the ticks it cannot
  // consume — top edge scrolling up, bottom edge scrolling down, each
  // direction independently — are forwarded. Purely additive (no
  // preventDefault, no focus changes), so text selection, caret placement
  // and typing are untouched; wheel events never fire from touch, so mobile
  // scrolling is untouched too.
  function handleBodyWheel(e) {
    const el = e.currentTarget
    const outer = scrollAreaRef.current
    if (!outer) return
    const scrollable = el.scrollHeight > el.clientHeight
    const atTop = el.scrollTop <= 0
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
    if (!scrollable || (e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) {
      // deltaMode: 0 = pixels, 1 = lines (Firefox), 2 = pages.
      const step = e.deltaMode === 1 ? e.deltaY * 16
        : e.deltaMode === 2 ? e.deltaY * outer.clientHeight
        : e.deltaY
      outer.scrollTop += step
    }
  }
  const tagInputRef = useRef(null)
  const saveTimerRef = useRef(null)
  const swipeRef = useRef({ active: false, startX: 0, currentX: 0 })

  const scheduleSave = useCallback((content, bubbleIds, tagsArr, connsArr) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      onUpdateNote(note.id, {
        content,
        bubble_ids: bubbleIds,
        tags: tagsArr,
        connections: connsArr,
      })
    }, 500)
  }, [note.id, onUpdateNote])

  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [])


  useEffect(() => {
    if (addingTag) tagInputRef.current?.focus({ preventScroll: true })
  }, [addingTag])

  // A brand-new (empty) note opens straight into typing mode — focused, cursor
  // ready, keyboard up — with no extra tap.
  useEffect(() => {
    if (note.content) return
    const el = bodyRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    try { el.setSelectionRange(end, end) } catch { /* not all inputs support it */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: register any custom tags on this note that aren't yet in the project color map.
  // This ensures toggling a custom tag off never removes the pill — it just deselects it.
  useEffect(() => {
    const existingColors = project.customTagColors || {}
    const unregistered = note.tags.filter(t => !existingColors[t])
    if (unregistered.length === 0) return
    const updated = { ...existingColors }
    unregistered.forEach(tag => {
      const usedColors = new Set(Object.values(updated))
      updated[tag] = CUSTOM_TAG_PALETTE.find(c => !usedColors.has(c)) ??
        CUSTOM_TAG_PALETTE[Object.keys(updated).length % CUSTOM_TAG_PALETTE.length]
    })
    onUpdateCustomTagColors?.(updated)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps


  function handleClose() {
    if (isClosing) return
    setIsClosing(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (!text.trim()) {
      onDeleteNote(note.id)
    } else {
      onUpdateNote(note.id, { content: text, bubble_ids: selectedBubbleIds, tags, connections })
    }
    onClose()
  }

  // Escape closes the note the same way the back arrow does — same save, same
  // slide-back. The body textarea isn't handled here: while it has focus the global
  // listener just blurs it, so it takes a second press to reach this.
  useEscapeLayer(true, handleClose, zIndex)
  // Its own delete confirm sits above it (matching the modal's zIndex + 10).
  useEscapeLayer(showDeleteConfirm, () => setShowDeleteConfirm(false), zIndex + 10)
  // The editor is mounted only while open, and its textarea raises the keyboard —
  // hold the app shell still for its whole lifetime (see bodyScrollLock). The
  // editor's own body row scrolls internally and is unaffected.
  useBodyScrollLock(true)

  function pushHistory(prevText) {
    setPast(p => [...p.slice(-49), prevText])
    setFuture([])
  }

  function undo() {
    if (past.length === 0) return
    const prev = past[past.length - 1]
    setPast(p => p.slice(0, -1))
    setFuture(f => [text, ...f])
    setText(prev)
    scheduleSave(prev, selectedBubbleIds, tags, connections)
  }

  function redo() {
    if (future.length === 0) return
    const next = future[0]
    setFuture(f => f.slice(1))
    setPast(p => [...p, text])
    setText(next)
    scheduleSave(next, selectedBubbleIds, tags, connections)
  }

  function handleTextChange(e) {
    const val = e.target.value
    pushHistory(text)
    setText(val)
    scheduleSave(val, selectedBubbleIds, tags, connections)
  }

  // Membership invariants: a note always has at least one selection. The
  // project-canvas sentinel deselects itself when the FIRST real bubble is
  // picked (the note has moved into a bubble), re-selects itself when the
  // last real bubble is removed (a note is never left with no location), can
  // be re-added manually at any time without evicting real bubbles, and can
  // only be removed while a real bubble remains.
  function toggleBubble(id) {
    let updated
    if (selectedBubbleIds.includes(id)) {
      updated = selectedBubbleIds.filter(b => b !== id)
      if (id === ROOT_BUBBLE_ID) {
        if (realBubbleIds(updated).length === 0) return // sole location — keep it
      } else if (realBubbleIds(updated).length === 0 && !updated.includes(ROOT_BUBBLE_ID)) {
        updated = [...updated, ROOT_BUBBLE_ID]
      }
    } else {
      updated = [...selectedBubbleIds, id]
      // Only the 0 → first real bubble transition evicts the sentinel;
      // adding further bubbles never removes a manually re-selected pin.
      if (id !== ROOT_BUBBLE_ID && realBubbleIds(selectedBubbleIds).length === 0) {
        updated = updated.filter(b => b !== ROOT_BUBBLE_ID)
      }
    }
    setSelectedBubbleIds(updated)
    scheduleSave(text, updated, tags, connections)
  }

  function toggleTag(tag) {
    const updated = tags.includes(tag)
      ? tags.filter(t => t !== tag)
      : [...tags, tag]
    setTags(updated)
    scheduleSave(text, selectedBubbleIds, updated, connections)
  }

  function addCustomTag() {
    const tag = tagInput.trim().replace(/^#/, '')
    if (tag && !tags.includes(tag)) {
      const updated = [...tags, tag]
      setTags(updated)
      const existingColors = project.customTagColors || {}
      if (!existingColors[tag]) {
        const usedColors = new Set(Object.values(existingColors))
        const nextColor =
          CUSTOM_TAG_PALETTE.find(c => !usedColors.has(c)) ??
          CUSTOM_TAG_PALETTE[Object.keys(existingColors).length % CUSTOM_TAG_PALETTE.length]
        onUpdateCustomTagColors?.({ ...existingColors, [tag]: nextColor })
      }
      scheduleSave(text, selectedBubbleIds, updated, connections)
    }
    setTagInput('')
    setAddingTag(false)
  }

  function removeTag(tag) {
    const updated = tags.filter(t => t !== tag)
    setTags(updated)
    scheduleSave(text, selectedBubbleIds, updated, connections)
  }

  function addConnection() {
    if (!connNoteId) return
    const type = connType === '__custom__' ? customConnType.trim() : connType
    if (!type) return
    // `type` is the canonical field (what the cloud loader produces and the
    // uploader sends); reads go through connectionType so legacy local
    // objects that used relationship_type keep working. The id is client-made
    // like note/bubble ids — connections.id has no DB default, and a stable
    // id is what lets syncs upsert instead of multiplying rows.
    const updated = [...connections, { id: generateId(), note_id: connNoteId, type }]
    setConnections(updated)
    onUpdateNote(note.id, { connections: updated })
    setConnNoteId('')
    setConnType(CONNECTION_TYPES[0])
    setCustomConnType('')
    setAddingConnection(false)
  }

  function removeConnection(idx) {
    const updated = connections.filter((_, i) => i !== idx)
    setConnections(updated)
    onUpdateNote(note.id, { connections: updated })
  }

  function handleDelete() {
    setShowDeleteConfirm(true)
  }

  function confirmDelete() {
    setShowDeleteConfirm(false)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    onDeleteNote(note.id)
    onClose()
  }

  function handleNavigateToConnectedNote(targetNote) {
    if (!onNavigateToNote) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (text.trim()) {
      onUpdateNote(note.id, { content: text, bubble_ids: selectedBubbleIds, tags, connections })
    }
    onNavigateToNote(targetNote)
  }

  // Edge-swipe back gesture. Tracking is 1:1 with the finger (no lag): swipeOffset
  // is local state so only this panel re-renders. onSwipeProgress lets the parent
  // drive a parallax on the view beneath (revealed as the panel slides away).
  function handleTouchStart(e) {
    const touch = e.touches[0]
    if (touch.clientX < 28) {
      swipeRef.current = { active: true, startX: touch.clientX, currentX: touch.clientX }
      // Move the layer beneath to its parallax start position while it's still fully
      // hidden behind this panel, so there's no visible jump when the reveal begins.
      onSwipeProgress?.(0, true)
    }
  }

  function handleTouchMove(e) {
    if (!swipeRef.current.active) return
    const dx = e.touches[0].clientX - swipeRef.current.startX
    swipeRef.current.currentX = e.touches[0].clientX
    if (dx > 0) {
      setSwipeOffset(dx)
      onSwipeProgress?.(Math.min(1, dx / window.innerWidth), true)
    }
  }

  function handleTouchEnd() {
    if (!swipeRef.current.active) return
    swipeRef.current.active = false
    const dx = swipeRef.current.currentX - swipeRef.current.startX
    // Past 40% of the screen width → complete the back navigation; otherwise cancel
    // and snap the panel back to full screen.
    if (dx > window.innerWidth * 0.4) {
      onSwipeProgress?.(1, false) // let the layer beneath settle to its resting position
      handleClose()
    } else {
      setSwipeOffset(0)
      onSwipeProgress?.(0, false)
    }
  }

  // The bubble rows themselves; tree order, indentation and fit-based
  // auto-collapse come from BubblePickerTree. Tapping a row still only
  // toggles membership — the chevron is its own hit target.
  function renderBubblePickerRow(bubble) {
    const selected = selectedBubbleIds.includes(bubble.id)
    const color = bubble.color
    return (
      <button
        onClick={() => toggleBubble(bubble.id)}
        className="flex-1 min-w-0 flex items-center gap-2 px-2 rounded-lg text-left transition-all"
        style={{ background: selected ? `${color}22` : 'transparent' }}
      >
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all"
          style={{ backgroundColor: selected ? color : `${color}55` }}
        />
        <span
          className="text-sm transition-colors truncate"
          style={{ color: selected ? 'var(--text)' : '#6b7280' }}
        >
          {bubble.name}
        </span>
      </button>
    )
  }

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0
  // Manual title when set, else the first non-empty body line, tracking the
  // live text rather than the last saved copy.
  const displayTitle = customTitle || getNoteTitle(text)

  function startTitleEdit() {
    titleDraftInitialRef.current = displayTitle
    setTitleDraft(displayTitle)
    setEditingTitle(true)
  }

  // Commit on blur/Enter. An untouched draft keeps the prior mode — tapping
  // in and back out never freezes a derived title. A cleared draft reverts
  // to deriving (stored as null).
  function commitTitle() {
    setEditingTitle(false)
    if (titleDraft === titleDraftInitialRef.current) return
    const next = titleDraft.trim()
    setCustomTitle(next)
    onUpdateNote(note.id, { title: next || null })
  }
  // A locked note's title must not surface through the connections UI either — it's
  // shown as "Locked" in existing connections, and can't be picked as a new one.
  const lockIndex = buildLockIndex(project.bubbles, project.notes, unlockedIds)

  // Back-button label, capped the same way for EVERY origin (bubble and
  // project names can run as long as note titles). Orientation is the job,
  // not fidelity: roughly a couple of words. Over the cap it's cut at the
  // character budget with an ellipsis; if even that can't leave a few
  // readable characters (or the label is blank), the chevron stands alone.
  const BACK_LABEL_MAX = 10
  // The centered title's reserve on EACH side is MEASURED, not assumed: after
  // each commit the layout effect below reads the real rendered width of the
  // back button and of the icon cluster, takes the wider of the two plus a
  // small gap, and applies it to both sides — so the box stays symmetric
  // around the panel's center, can't collide with either side at any label
  // length, and a short (or absent) back label hands the title the room it
  // isn't using. TITLE_INSET is only the pre-measurement fallback, sized for
  // the worst case (pad + chevron + a full capped label).
  const TITLE_INSET = 128
  const [titleInset, setTitleInset] = useState(TITLE_INSET)
  const headerRowRef = useRef(null)
  const backBtnRef = useRef(null)
  const iconGroupRef = useRef(null)
  useLayoutEffect(() => {
    const hdr = headerRowRef.current
    const back = backBtnRef.current
    const icons = iconGroupRef.current
    if (!hdr || !back || !icons) return
    const h = hdr.getBoundingClientRect()
    const leftSide = back.getBoundingClientRect().right - h.left
    const rightSide = h.right - icons.getBoundingClientRect().left
    const next = Math.round(Math.max(leftSide, rightSide)) + 8
    setTitleInset(prev => (prev === next ? prev : next))
  })
  const backTrimmed = (backLabel ?? '').trim()
  const backCut = backTrimmed.length > BACK_LABEL_MAX
    ? backTrimmed.slice(0, BACK_LABEL_MAX - 1).trimEnd()
    : backTrimmed
  const backText = backTrimmed.length > BACK_LABEL_MAX
    ? (backCut.length >= 4 ? backCut + '…' : '')
    : backTrimmed
  const connectableNotes = project.notes.filter(
    n => n.id !== note.id && !lockIndex.gatedNoteIds.has(n.id)
  )
  const titleOf = (n) =>
    lockIndex.gatedNoteIds.has(n.id) ? 'Locked' : (noteTitle(n) || 'Untitled')
  const swipeTransition = swipeRef.current.active
    ? 'none'
    : 'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)'

  // All custom tags come from the project-level color map (toggling off just deselects, never removes)
  const allCustomTags = Object.keys(project.customTagColors || {})

  return (
    <motion.div
      data-modal
      className="fixed inset-0"
      style={{
        zIndex,
        // Mobile: transparent so the view beneath (bubble/all-notes/previous note)
        // shows through as this panel slides away during a swipe-back.
        background: isDesktop ? 'rgba(0,0,0,0.6)' : 'transparent',
        display: isDesktop ? 'flex' : 'block',
        alignItems: isDesktop ? 'stretch' : undefined,
        justifyContent: isDesktop ? 'center' : undefined,
      }}
      initial={isDesktop ? { opacity: 0 } : { x: '100%' }}
      animate={isDesktop ? { opacity: 1 } : { x: 0 }}
      exit={isDesktop ? { opacity: 0 } : { x: '100%' }}
      transition={{ type: 'tween', duration: isDesktop ? 0.18 : 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
      // Desktop only: pressing the dimmed backdrop closes the note the same way
      // the back arrow does (same pending-edit save). target===currentTarget
      // means presses inside the panel — or on any menu/dialog it spawns, which
      // are all children — can never reach here; mousedown (not click) means a
      // text-selection drag that ends outside the panel can't close it either.
      // Touch devices keep swipe-back/Escape only, where a stray tap is too easy.
      onMouseDown={isDesktop ? (e => { if (e.target === e.currentTarget) handleClose() }) : undefined}
    >
    <div
      // The column is minmax(0, 1fr), NOT the implicit auto: grid items
      // default to min-width auto, so the header's intrinsic width (a nowrap
      // title) would otherwise blow the track — and with it every row —
      // wider than the panel. minmax(0,1fr) caps the track at the panel
      // width, which is what lets min-w-0 flex items inside actually shrink.
      style={isDesktop ? {
        position: 'relative',
        width: '100%',
        maxWidth: 820,
        // EXPERIMENT (neutral scheme): was var(--surface) — the panel matches the
        // pitch-black ground so the bare header doesn't read as a black band on a
        // lighter panel (both branches below).
        background: 'var(--bg)',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        gridTemplateColumns: 'minmax(0, 1fr)',
        overflow: 'hidden',
        borderLeft: '1px solid var(--border)',
        borderRight: '1px solid var(--border)',
      } : {
        position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
        background: 'var(--bg)',
        display: 'grid', gridTemplateRows: 'auto 1fr',
        gridTemplateColumns: 'minmax(0, 1fr)', overflow: 'hidden',
        transform: `translateX(${swipeOffset}px)`, transition: swipeTransition,
        // Left-edge shadow gives the sliding panel depth over the revealed layer.
        boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
      }}
      onTouchStart={!isDesktop ? handleTouchStart : undefined}
      onTouchMove={!isDesktop ? handleTouchMove : undefined}
      onTouchEnd={!isDesktop ? handleTouchEnd : undefined}
    >
      {/* ── Header — grid row 1 (auto height, never scrolls) ─────────────────── */}
      {/* EXPERIMENT (neutral scheme): header had a border-b divider and painted
          var(--surface); now bare on the panel ground like the canvas header. */}
      <div
        ref={headerRowRef}
        className="relative flex items-center px-3"
        style={{
          paddingTop: 'max(12px, env(safe-area-inset-top))', paddingBottom: 10,
          background: 'var(--bg)',
        }}
      >
        <button
          ref={backBtnRef}
          onClick={handleClose}
          className="flex items-center gap-0.5 text-indigo-400 hover:text-indigo-300 font-medium text-[15px] py-1 -ml-1 flex-shrink-0 transition-colors z-10 max-w-[140px]"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          {backText && <span className="truncate">{backText}</span>}
        </button>

        {/* Title. Follows the first body line until manually edited (tap to
            edit); a manual title is fixed and no longer tracks the body, and
            clearing it reverts to deriving. Absolutely positioned in a box
            centered on the panel (the measured titleInset each side), so it
            stays centered at any back-label length; out of flow, it also
            can't blow the grid track (and the panel's minmax(0,1fr) column
            guards that regardless). The back button and icons carry z-10, so
            they layer above it and keep their full hit areas. */}
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitTitle() }
              if (e.key === 'Escape') { e.stopPropagation(); setEditingTitle(false) }
            }}
            placeholder="Untitled"
            aria-label="Note title"
            className="absolute text-center text-[15px] font-semibold outline-none bg-transparent px-2"
            style={{ left: titleInset, right: titleInset, color: 'var(--text)', userSelect: 'text', WebkitUserSelect: 'text' }}
          />
        ) : (
          <button
            onClick={startTitleEdit}
            className="absolute text-center text-[15px] font-semibold truncate px-2"
            style={{ left: titleInset, right: titleInset, color: displayTitle ? 'var(--text)' : '#6b7280' }}
            title="Edit title"
          >
            {displayTitle || 'Untitled'}
          </button>
        )}

        <div className="flex-1" />

        {/* Icon cluster — one wrapper so the title-inset measurement reads the
            group's true extent in a single rect. */}
        <div ref={iconGroupRef} className="flex items-center flex-shrink-0">
          {/* Copy — the text as it stands in the editor, not the last saved version, so
              what lands on the clipboard is what's on screen. */}
          <button
            onClick={() => copyNoteText({ content: text, title: customTitle || null }).then(showToast)}
            disabled={!text.trim()}
            className="p-1.5 rounded-lg transition-opacity flex-shrink-0 z-10 text-gray-400 disabled:opacity-25"
            title="Copy note"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 8V5a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1h-3M5 8h10a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V9a1 1 0 011-1z" />
            </svg>
          </button>

          <button
            onClick={handleDelete}
            className="p-1.5 text-gray-500 hover:text-red-500 rounded-lg transition-colors -mr-1 flex-shrink-0 z-10"
            title="Delete note"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Scroll area — grid row 2 (1fr), only this scrolls ───────────────── */}
      <div ref={scrollAreaRef} style={{ overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>

        {/* Text content */}
        <div className="px-5 md:px-10 pt-4 md:pt-8 pb-3 border-b border-white/10">
          <textarea
            ref={bodyRef}
            value={text}
            onChange={handleTextChange}
            onWheel={handleBodyWheel}
            placeholder="Start writing…"
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck={true}
            className="w-full text-[16px] md:text-[17px] text-gray-200 placeholder-gray-700 outline-none resize-none bg-transparent leading-relaxed"
            style={{ height: '60dvh', overflowY: 'auto', overscrollBehavior: 'contain', userSelect: 'text', WebkitUserSelect: 'text' }}
          />
          <div className="flex items-end justify-between pt-2">
            {/* Undo / Redo — moved down from the header */}
            <div className="flex items-center gap-1 -ml-1.5">
              <button
                onClick={undo}
                disabled={past.length === 0}
                className="p-1.5 rounded-lg transition-opacity flex-shrink-0 text-gray-400 disabled:opacity-25"
                title="Undo"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 10h10a6 6 0 010 12H9m-6-12l4-4m-4 4l4 4" />
                </svg>
              </button>
              <button
                onClick={redo}
                disabled={future.length === 0}
                className="p-1.5 rounded-lg transition-opacity flex-shrink-0 text-gray-400 disabled:opacity-25"
                title="Redo"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M21 10H11a6 6 0 000 12h4m6-12l-4-4m4 4l-4 4" />
                </svg>
              </button>
            </div>
            <div className="text-right space-y-0.5">
              <p className="text-[11px] text-gray-700">
                {wordCount} {wordCount === 1 ? 'word' : 'words'}
              </p>
              <p className="text-[11px] text-gray-600">Created {formatNoteDate(note.created_at)}</p>
              <p className="text-[11px] text-gray-700">Last edited {formatNoteDate(note.updated_at)}</p>
            </div>
          </div>
        </div>

        {/* ── Metadata (scrolls with content) ───────────────────────────────── */}
        <div className="px-4 md:px-10 pt-5 space-y-6" style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}>

          {/* Tags — all in one wrapping row */}
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 items-center">
            {allCustomTags.map(tag => {
              const selected = tags.includes(tag)
              const color = (project.customTagColors || {})[tag] || '#0A84FF'
              return (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className="text-sm font-medium transition-colors"
                  style={{ color: selected ? color : '#6b7280' }}
                >
                  #{tag}
                </button>
              )
            })}
            {addingTag ? (
              <input
                ref={tagInputRef}
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCustomTag() }
                  if (e.key === 'Escape') { setTagInput(''); setAddingTag(false) }
                }}
                onBlur={addCustomTag}
                placeholder="Tag name…"
                className="text-sm px-3 py-1.5 rounded-full outline-none bg-transparent text-gray-300 placeholder-gray-600"
                style={{ border: '1px solid var(--border)', width: 112 }}
              />
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm text-gray-500 border border-white/10 hover:border-white/25 hover:text-gray-400 transition-colors"
              >
                + Tag
              </button>
            )}
          </div>

          {/* Bubble membership */}
          <div>
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Project</p>
            <div className="space-y-0.5">
              {/* Project root — selecting it puts the note loose on the canvas */}
              {(() => {
                const selected = selectedBubbleIds.includes(ROOT_BUBBLE_ID)
                const color = '#6b7280'
                return (
                  <button
                    onClick={() => toggleBubble(ROOT_BUBBLE_ID)}
                    className="flex items-center gap-2 py-1 px-2 rounded-lg w-full text-left transition-all"
                    style={{ background: selected ? `${color}22` : 'transparent' }}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all"
                      style={{ backgroundColor: selected ? color : `${color}55` }}
                    />
                    <span
                      className="text-sm transition-colors"
                      style={{ color: selected ? 'var(--text)' : '#6b7280' }}
                    >
                      {project.name}
                    </span>
                  </button>
                )
              })()}
            </div>
            <div className="my-3" style={{ borderTop: '1px solid var(--border)' }} />
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Bubble</p>
            <div>
              {/* "Fits without scrolling" here means the whole tree can be on
                  screen at once inside the editor's scroll panel — the list
                  sits partway down a long page, so the panel's viewport height
                  is the budget. Uniform 36px rows keep the check arithmetic. */}
              <BubblePickerTree
                bubbles={project.bubbles}
                rowHeight={36}
                measureAvailable={() => scrollAreaRef.current?.clientHeight ?? null}
                observeResize={() => scrollAreaRef.current}
                renderRow={renderBubblePickerRow}
              />
            </div>
          </div>

          {/* Connections */}
          <div>
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Connections</p>

            {/* Forward connections: this note → other note (deletable) */}
            {connections.map((conn, idx) => {
              const otherNote = project.notes.find(n => n.id === conn.note_id)
              const thisTitle = displayTitle || 'Untitled'
              const otherTitle = otherNote ? titleOf(otherNote) : null
              const otherLocked = otherNote ? lockIndex.gatedNoteIds.has(otherNote.id) : false
              return (
                <div key={`fwd-${idx}`} className="flex items-center gap-2 bg-white/6 rounded-lg px-3 py-2 mb-1.5">
                  <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
                    <span className="text-gray-300 truncate max-w-[120px]">{thisTitle}</span>
                    <span className="text-gray-500 italic flex-shrink-0">{connectionType(conn)}</span>
                    {otherNote ? (
                      <button
                        onClick={() => otherLocked
                          ? requestUnlock(lockIndex.gatingIdsFor({ ...otherNote, type: 'note' }))
                          : handleNavigateToConnectedNote(otherNote)}
                        className={`transition-colors truncate max-w-[120px] ${otherLocked ? 'text-gray-500' : 'text-indigo-400 hover:text-indigo-300'}`}
                      >
                        {otherTitle}
                      </button>
                    ) : (
                      <span className="text-gray-600 italic">Deleted note</span>
                    )}
                  </div>
                  <button onClick={() => removeConnection(idx)} className="text-gray-400 hover:text-red-500 flex-shrink-0 text-base leading-none">×</button>
                </div>
              )
            })}

            {/* Reverse connections: other notes that point to this note (read-only here) */}
            {project.notes.flatMap(n => {
              if (n.id === note.id) return []
              return n.connections
                .filter(c => c.note_id === note.id)
                .map((conn, i) => {
                  const otherTitle = titleOf(n)
                  const otherLocked = lockIndex.gatedNoteIds.has(n.id)
                  const thisTitle = displayTitle || 'Untitled'
                  return (
                    <div key={`rev-${n.id}-${i}`} className="flex items-center gap-2 bg-white/6 rounded-lg px-3 py-2 mb-1.5">
                      <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
                        <button
                          onClick={() => otherLocked
                            ? requestUnlock(lockIndex.gatingIdsFor({ ...n, type: 'note' }))
                            : handleNavigateToConnectedNote(n)}
                          className={`transition-colors truncate max-w-[120px] ${otherLocked ? 'text-gray-500' : 'text-indigo-400 hover:text-indigo-300'}`}
                        >
                          {otherTitle}
                        </button>
                        <span className="text-gray-500 italic flex-shrink-0">{connectionType(conn)}</span>
                        <span className="text-gray-300 truncate max-w-[120px]">{thisTitle}</span>
                      </div>
                    </div>
                  )
                })
            })}

            {addingConnection ? (
              <div className="space-y-2 bg-white/5 rounded-xl p-3">
                <select
                  value={connNoteId}
                  onChange={e => setConnNoteId(e.target.value)}
                  className="w-full text-sm border border-white/15 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-500 bg-[#2C2C2E] text-white"
                >
                  <option value="">Select a note…</option>
                  {connectableNotes.map(n => (
                    <option key={n.id} value={n.id}>
                      {titleOf(n).slice(0, 60)}
                    </option>
                  ))}
                </select>
                <select
                  value={connType}
                  onChange={e => setConnType(e.target.value)}
                  className="w-full text-sm border border-white/15 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-500 bg-[#2C2C2E] text-white"
                >
                  {CONNECTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  <option value="__custom__">Custom type…</option>
                </select>
                {connType === '__custom__' && (
                  <input
                    value={customConnType}
                    onChange={e => setCustomConnType(e.target.value)}
                    placeholder="Relationship type…"
                    className="w-full text-sm border border-white/15 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-500 bg-[#2C2C2E] text-white placeholder-gray-600"
                  />
                )}
                <div className="flex gap-2">
                  <button
                    onClick={addConnection}
                    disabled={!connNoteId}
                    className="flex-1 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                  >Add Connection</button>
                  <button
                    onClick={() => setAddingConnection(false)}
                    className="flex-1 py-1.5 text-xs font-medium bg-white/8 text-gray-300 rounded-lg hover:bg-white/12 transition-colors"
                  >Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingConnection(true)}
                disabled={connectableNotes.length === 0}
                className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <span className="text-sm leading-none font-bold">+</span>
                Add connection
              </button>
            )}
          </div>

        </div>
      </div>

    </div>

    {/* Delete confirmation modal */}
    <AnimatePresence>
      {showDeleteConfirm && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: zIndex + 10, background: 'rgba(0,0,0,0.6)' }}
          // Destructive confirm: no outside-press dismissal — explicit
          // choice or Escape only.
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
            <h2 className="text-white font-semibold text-lg text-center mb-1">Delete Note?</h2>
            <p className="text-gray-400 text-sm text-center mb-5">This note will be permanently deleted.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
                style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
              >
                Delete
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </motion.div>
  )
}
