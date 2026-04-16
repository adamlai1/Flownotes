import { useState, useRef, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CONNECTION_TYPES, CUSTOM_TAG_PALETTE, ROOT_BUBBLE_ID } from '../data/defaultData'
import { getNoteTitle } from '../utils/helpers'


function formatNoteDate(isoStr) {
  const d = new Date(isoStr)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function splitContent(content) {
  const idx = content.indexOf('\n')
  if (idx === -1) return { title: content, body: '' }
  return { title: content.slice(0, idx), body: content.slice(idx + 1) }
}

export default function NoteEditor({ note, project, onClose, onUpdateNote, onDeleteNote, onUpdateCustomTagColors, onNavigateToNote, backLabel = 'Notes', zIndex = 50 }) {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = e => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  const { title: initTitle, body: initBody } = splitContent(note.content)
  const [title, setTitle] = useState(initTitle)
  const [body, setBody] = useState(initBody)
  const [selectedBubbleIds, setSelectedBubbleIds] = useState(note.bubble_ids)
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
  const tagInputRef = useRef(null)
  const saveTimerRef = useRef(null)
  const swipeRef = useRef({ active: false, startX: 0, currentX: 0 })

  const buildContent = useCallback((t, b) => b ? `${t}\n${b}` : t, [])

  const scheduleSave = useCallback((t, b, bubbleIds, tagsArr, connsArr) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      onUpdateNote(note.id, {
        content: buildContent(t, b),
        bubble_ids: bubbleIds,
        tags: tagsArr,
        connections: connsArr,
      })
    }, 500)
  }, [note.id, onUpdateNote, buildContent])

  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [])


  useEffect(() => {
    if (addingTag) tagInputRef.current?.focus({ preventScroll: true })
  }, [addingTag])

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
    const content = buildContent(title, body)
    if (!content.trim()) {
      onDeleteNote(note.id)
    } else {
      onUpdateNote(note.id, { content, bubble_ids: selectedBubbleIds, tags, connections })
    }
    onClose()
  }

  function pushHistory(prevTitle, prevBody) {
    setPast(p => [...p.slice(-49), { title: prevTitle, body: prevBody }])
    setFuture([])
  }

  function undo() {
    if (past.length === 0) return
    const prev = past[past.length - 1]
    setPast(p => p.slice(0, -1))
    setFuture(f => [{ title, body }, ...f])
    setTitle(prev.title)
    setBody(prev.body)
    scheduleSave(prev.title, prev.body, selectedBubbleIds, tags, connections)
  }

  function redo() {
    if (future.length === 0) return
    const next = future[0]
    setFuture(f => f.slice(1))
    setPast(p => [...p, { title, body }])
    setTitle(next.title)
    setBody(next.body)
    scheduleSave(next.title, next.body, selectedBubbleIds, tags, connections)
  }

  function handleTitleChange(e) {
    const val = e.target.value.replace(/\n/g, '')
    pushHistory(title, body)
    setTitle(val)
    scheduleSave(val, body, selectedBubbleIds, tags, connections)
  }

  function handleBodyChange(e) {
    const val = e.target.value
    pushHistory(title, body)
    setBody(val)
    scheduleSave(title, val, selectedBubbleIds, tags, connections)
  }

  function toggleBubble(id) {
    const updated = selectedBubbleIds.includes(id)
      ? selectedBubbleIds.filter(b => b !== id)
      : [...selectedBubbleIds, id]
    setSelectedBubbleIds(updated)
    scheduleSave(title, body, updated, tags, connections)
  }

  function toggleTag(tag) {
    const updated = tags.includes(tag)
      ? tags.filter(t => t !== tag)
      : [...tags, tag]
    setTags(updated)
    scheduleSave(title, body, selectedBubbleIds, updated, connections)
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
      scheduleSave(title, body, selectedBubbleIds, updated, connections)
    }
    setTagInput('')
    setAddingTag(false)
  }

  function removeTag(tag) {
    const updated = tags.filter(t => t !== tag)
    setTags(updated)
    scheduleSave(title, body, selectedBubbleIds, updated, connections)
  }

  function addConnection() {
    if (!connNoteId) return
    const type = connType === '__custom__' ? customConnType.trim() : connType
    if (!type) return
    const updated = [...connections, { note_id: connNoteId, relationship_type: type }]
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
    const content = buildContent(title, body)
    if (content.trim()) {
      onUpdateNote(note.id, { content, bubble_ids: selectedBubbleIds, tags, connections })
    }
    onNavigateToNote(targetNote)
  }

  function handleTouchStart(e) {
    const touch = e.touches[0]
    if (touch.clientX < 28) {
      swipeRef.current = { active: true, startX: touch.clientX, currentX: touch.clientX }
    }
  }

  function handleTouchMove(e) {
    if (!swipeRef.current.active) return
    const dx = e.touches[0].clientX - swipeRef.current.startX
    swipeRef.current.currentX = e.touches[0].clientX
    if (dx > 0) setSwipeOffset(dx)
  }

  function handleTouchEnd() {
    if (!swipeRef.current.active) return
    swipeRef.current.active = false
    const dx = swipeRef.current.currentX - swipeRef.current.startX
    if (dx > window.innerWidth * 0.3) handleClose()
    else setSwipeOffset(0)
  }

  function renderBubbleChips(parentId = null, depth = 0) {
    const items = project.bubbles.filter(b => b.parent_id === parentId)
    if (items.length === 0) return null
    return items.map(bubble => {
      const selected = selectedBubbleIds.includes(bubble.id)
      const color = bubble.color
      return (
        <div key={bubble.id}>
          <button
            onClick={() => toggleBubble(bubble.id)}
            className="flex items-center gap-2 py-1 px-2 rounded-lg w-full text-left transition-all"
            style={{
              paddingLeft: `${depth * 24 + 8}px`,
              background: selected ? `${color}22` : 'transparent',
            }}
          >
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all"
              style={{ backgroundColor: selected ? color : `${color}55` }}
            />
            <span
              className="text-sm transition-colors"
              style={{ color: selected ? 'var(--text)' : '#6b7280' }}
            >
              {bubble.name}
            </span>
          </button>
          {renderBubbleChips(bubble.id, depth + 1)}
        </div>
      )
    })
  }

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0
  const connectableNotes = project.notes.filter(n => n.id !== note.id)
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
        background: isDesktop ? 'rgba(0,0,0,0.6)' : 'var(--surface)',
        display: isDesktop ? 'flex' : 'block',
        alignItems: isDesktop ? 'stretch' : undefined,
        justifyContent: isDesktop ? 'center' : undefined,
      }}
      initial={isDesktop ? { opacity: 0 } : { x: '100%' }}
      animate={isDesktop ? { opacity: 1 } : { x: 0 }}
      exit={isDesktop ? { opacity: 0 } : { x: '100%' }}
      transition={{ type: 'tween', duration: isDesktop ? 0.18 : 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
    <div
      style={isDesktop ? {
        position: 'relative',
        width: '100%',
        maxWidth: 820,
        background: 'var(--surface)',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        overflow: 'hidden',
        borderLeft: '1px solid var(--border)',
        borderRight: '1px solid var(--border)',
      } : {
        position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
        background: 'var(--surface)',
        display: 'grid', gridTemplateRows: 'auto 1fr', overflow: 'hidden',
        transform: `translateX(${swipeOffset}px)`, transition: swipeTransition,
      }}
      onTouchStart={!isDesktop ? handleTouchStart : undefined}
      onTouchMove={!isDesktop ? handleTouchMove : undefined}
      onTouchEnd={!isDesktop ? handleTouchEnd : undefined}
    >
      {/* ── Header — grid row 1 (auto height, never scrolls) ─────────────────── */}
      <div
        className="relative flex items-center px-3 border-b border-white/10"
        style={{
          paddingTop: 'max(12px, env(safe-area-inset-top))', paddingBottom: 10,
          background: 'var(--surface)',
        }}
      >
        <button
          onClick={handleClose}
          className="flex items-center gap-0.5 text-indigo-400 hover:text-indigo-300 font-medium text-[15px] py-1 -ml-1 flex-shrink-0 transition-colors z-10 max-w-[140px]"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          <span className="truncate">{backLabel}</span>
        </button>

        <input
          type="text"
          value={title}
          onChange={handleTitleChange}
          onKeyDown={e => e.key === 'Enter' && bodyRef.current?.focus()}
          placeholder="Untitled"
          autoComplete="off"
          className="absolute inset-x-0 mx-auto w-1/2 text-center text-[15px] font-semibold text-white placeholder-gray-600 outline-none bg-transparent pointer-events-auto"
          style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        />

        <div className="flex-1" />

        {/* Undo / Redo */}
        <button
          onClick={undo}
          disabled={past.length === 0}
          className="p-1.5 rounded-lg transition-opacity flex-shrink-0 z-10 text-gray-400 disabled:opacity-25"
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
          className="p-1.5 rounded-lg transition-opacity flex-shrink-0 z-10 text-gray-400 disabled:opacity-25"
          title="Redo"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 10H11a6 6 0 000 12h4m6-12l-4-4m4 4l-4 4" />
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

      {/* ── Scroll area — grid row 2 (1fr), only this scrolls ───────────────── */}
      <div style={{ overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>

        {/* Text content */}
        <div className="px-5 md:px-10 pt-4 md:pt-8 pb-3 border-b border-white/10">
          <textarea
            ref={bodyRef}
            value={body}
            onChange={handleBodyChange}
            placeholder="Start writing…"
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck={true}
            className="w-full text-[16px] md:text-[17px] text-gray-200 placeholder-gray-700 outline-none resize-none bg-transparent leading-relaxed"
            style={{ height: '60vh', overflowY: 'auto', overscrollBehavior: 'contain', userSelect: 'text', WebkitUserSelect: 'text' }}
          />
          <div className="flex items-end justify-between pt-2">
            <p className="text-[11px] text-gray-700">
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
            </p>
            <div className="text-right space-y-0.5">
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
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Bubble</p>
            <div className="space-y-0.5">
              {/* Root-level option — always shown first */}
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
              {renderBubbleChips()}
            </div>
          </div>

          {/* Connections */}
          <div>
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Connections</p>

            {/* Forward connections: this note → other note (deletable) */}
            {connections.map((conn, idx) => {
              const otherNote = project.notes.find(n => n.id === conn.note_id)
              const thisTitle = getNoteTitle(note.content) || 'Untitled'
              const otherTitle = otherNote ? (getNoteTitle(otherNote.content) || 'Untitled') : null
              return (
                <div key={`fwd-${idx}`} className="flex items-center gap-2 bg-white/6 rounded-lg px-3 py-2 mb-1.5">
                  <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
                    <span className="text-gray-300 truncate max-w-[120px]">{thisTitle}</span>
                    <span className="text-gray-500 italic flex-shrink-0">{conn.relationship_type}</span>
                    {otherNote ? (
                      <button
                        onClick={() => handleNavigateToConnectedNote(otherNote)}
                        className="text-indigo-400 hover:text-indigo-300 transition-colors truncate max-w-[120px]"
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
                  const otherTitle = getNoteTitle(n.content) || 'Untitled'
                  const thisTitle = getNoteTitle(note.content) || 'Untitled'
                  return (
                    <div key={`rev-${n.id}-${i}`} className="flex items-center gap-2 bg-white/6 rounded-lg px-3 py-2 mb-1.5">
                      <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
                        <button
                          onClick={() => handleNavigateToConnectedNote(n)}
                          className="text-indigo-400 hover:text-indigo-300 transition-colors truncate max-w-[120px]"
                        >
                          {otherTitle}
                        </button>
                        <span className="text-gray-500 italic flex-shrink-0">{conn.relationship_type}</span>
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
                      {(getNoteTitle(n.content) || 'Untitled').slice(0, 60)}
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
