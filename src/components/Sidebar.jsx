import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import BubbleTree from './BubbleTree'
import { BUBBLE_COLORS, CUSTOM_TAG_PALETTE } from '../data/defaultData'
import { generateId } from '../utils/helpers'

export default function Sidebar({
  open,
  project,
  selectedBubbleId,
  activeBubbleId,
  onSelectBubble,
  onAddBubble,
  onRenameBubble,
  onDeleteBubble,
  onUpdateCustomTagColors,
  onDeleteCustomTag,
  onRenameCustomTag,
  onClose,
}) {
  const [addingBubble, setAddingBubble] = useState(false)
  const [newBubbleName, setNewBubbleName] = useState('')
  const [newBubbleColor, setNewBubbleColor] = useState(BUBBLE_COLORS[0])
  const [newBubbleParentId, setNewBubbleParentId] = useState(null)

  const [addingTag, setAddingTag] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [editingTag, setEditingTag] = useState(null)
  const [editTagName, setEditTagName] = useState('')
  const [contextTag, setContextTag] = useState(null)
  const [confirmDeleteTag, setConfirmDeleteTag] = useState(null)

  const newBubbleInputRef = useRef(null)
  const newTagInputRef = useRef(null)
  const editTagInputRef = useRef(null)

  useEffect(() => {
    if (addingBubble && newBubbleInputRef.current) {
      newBubbleInputRef.current.focus({ preventScroll: true })
    }
  }, [addingBubble])

  useEffect(() => {
    if (addingTag && newTagInputRef.current) {
      newTagInputRef.current.focus({ preventScroll: true })
    }
  }, [addingTag])

  useEffect(() => {
    if (editingTag && editTagInputRef.current) {
      editTagInputRef.current.focus({ preventScroll: true })
      editTagInputRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [editingTag])

  // iOS-safe body lock: position:fixed prevents rubber-band scroll behind the sidebar
  useEffect(() => {
    if (open) {
      const scrollY = window.scrollY
      document.body.style.position = 'fixed'
      document.body.style.top = `-${scrollY}px`
      document.body.style.width = '100%'
      document.body.style.overflow = 'hidden'
    } else {
      const top = document.body.style.top
      document.body.style.position = ''
      document.body.style.top = ''
      document.body.style.width = ''
      document.body.style.overflow = ''
      window.scrollTo(0, parseInt(top || '0') * -1)
    }
    return () => {
      document.body.style.position = ''
      document.body.style.top = ''
      document.body.style.width = ''
      document.body.style.overflow = ''
    }
  }, [open])

  // Dismiss contextTag on outside click
  useEffect(() => {
    if (!contextTag) return
    function handleClick() { setContextTag(null) }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [contextTag])

  function handleAddBubble() {
    const name = newBubbleName.trim()
    if (!name) return
    onAddBubble({
      id: generateId(),
      name,
      parent_id: newBubbleParentId,
      color: newBubbleColor,
    })
    setNewBubbleName('')
    setNewBubbleColor(BUBBLE_COLORS[0])
    setNewBubbleParentId(null)
    setAddingBubble(false)
  }

  function handleAddTag() {
    const name = newTagName.trim()
    setAddingTag(false)
    setNewTagName('')
    if (!name) return
    const existingColors = project.customTagColors || {}
    if (existingColors[name]) return
    const usedColors = new Set(Object.values(existingColors))
    const nextColor =
      CUSTOM_TAG_PALETTE.find(c => !usedColors.has(c)) ??
      CUSTOM_TAG_PALETTE[Object.keys(existingColors).length % CUSTOM_TAG_PALETTE.length]
    onUpdateCustomTagColors?.({ ...existingColors, [name]: nextColor })
  }

  function commitEditTag(oldTag) {
    const newName = editTagName.trim()
    setEditingTag(null)
    setEditTagName('')
    if (!newName || newName === oldTag) return
    onRenameCustomTag?.(oldTag, newName)
  }

  function handleDeleteCustomTag(tag) {
    setConfirmDeleteTag(tag)
  }

  const customTagEntries = Object.entries(project.customTagColors ?? {})

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 30 }}
          onClick={onClose}
        />
      )}

      {/*
        Sidebar: fully isolated fixed panel.
        All critical scroll properties in inline styles so nothing overrides them.
        top+bottom instead of height:100vh avoids iOS URL-bar issues.
        overflow-y:scroll + -webkit-overflow-scrolling:touch = native momentum scroll on iOS.
        paddingBottom:300px gives room to scroll the input above the keyboard.
      */}
      <aside
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: '18rem',
          backgroundColor: 'var(--sidebar)',
          borderRight: '1px solid var(--border-hard)',
          overflowY: 'scroll',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'none',
          touchAction: 'pan-y',
          zIndex: 40,
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 200ms ease-in-out',
        }}
      >
        {/* Sticky top row: X close button + All Notes — mirrors the TopNav hamburger position */}
        <div
          className="sticky top-0 z-10 flex items-center border-b border-gray-800"
          style={{ backgroundColor: 'var(--sidebar)', paddingTop: 'max(8px, env(safe-area-inset-top))' }}
        >
          <button
            onClick={onClose}
            className="flex p-2 ml-1 text-gray-400 flex-shrink-0"
            style={{ WebkitTapHighlightColor: 'transparent', outline: 'none', background: 'none' }}
            aria-label="Close sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <button
            onClick={() => { onSelectBubble(null); onClose() }}
            className={`flex-1 text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 mr-2 ${
              activeBubbleId === null
                ? 'bg-indigo-950 text-indigo-400'
                : 'text-gray-400 hover:bg-gray-800'
            }`}
            style={{ WebkitTapHighlightColor: 'transparent', outline: 'none' }}
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {project.name}
            <span className="ml-auto text-xs text-gray-600">{project.notes.length}</span>
          </button>
        </div>

        <div style={{ paddingBottom: '300px' }}>

          {/* Bubbles section */}
          <div className="px-3 pt-4 pb-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Bubbles</span>
              <button
                onClick={() => { setNewBubbleParentId(null); setAddingBubble(true) }}
                className="text-gray-500 hover:text-indigo-400 transition-colors"
                title="Add bubble"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>

            {addingBubble && (
              <div className="space-y-2 mb-2">
                <input
                  ref={newBubbleInputRef}
                  value={newBubbleName}
                  onChange={e => setNewBubbleName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleAddBubble()
                    if (e.key === 'Escape') { setAddingBubble(false); setNewBubbleName(''); setNewBubbleParentId(null) }
                  }}
                  placeholder={newBubbleParentId
                    ? `Child of "${project.bubbles.find(b => b.id === newBubbleParentId)?.name}"`
                    : "Bubble name..."}
                  className="w-full px-2 py-1.5 text-sm border border-gray-700 rounded-lg outline-none focus:border-indigo-500 bg-gray-800 text-white"
                />
                <div className="flex gap-1 flex-wrap">
                  {BUBBLE_COLORS.map(color => (
                    <button
                      key={color}
                      onClick={() => setNewBubbleColor(color)}
                      className={`w-5 h-5 rounded-full transition-transform ${newBubbleColor === color ? 'ring-2 ring-offset-1 ring-offset-gray-900 ring-white scale-110' : ''}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleAddBubble}
                    className="flex-1 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setAddingBubble(false); setNewBubbleName(''); setNewBubbleParentId(null) }}
                    className="flex-1 py-1.5 text-xs font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {project.bubbles.length === 0 && !addingBubble ? (
              <p className="text-xs text-gray-400 px-1">No bubbles yet</p>
            ) : (
              <BubbleTree
                bubbles={project.bubbles}
                notes={project.notes}
                parentId={null}
                selectedBubbleId={selectedBubbleId}
                activeBubbleId={activeBubbleId}
                onSelectBubble={onSelectBubble}
                onRenameBubble={onRenameBubble}
                onDeleteBubble={onDeleteBubble}
                onAddChildBubble={(parentId) => {
                  setNewBubbleParentId(parentId)
                  setAddingBubble(true)
                }}
              />
            )}
          </div>

          {/* Tags section */}
          <div className="px-3 pt-4 pb-3 border-t border-gray-800 mt-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Tags</span>
              <button
                onClick={() => setAddingTag(true)}
                className="text-gray-500 hover:text-indigo-400 transition-colors"
                title="Add tag"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>

            {/* All tags — tap name to reveal Edit / Delete inline */}
            {customTagEntries.map(([tag, color]) =>
              editingTag === tag ? (
                <div key={tag} className="flex items-center gap-2 px-2 py-1 rounded-lg bg-gray-800 mt-0.5">
                  <span className="text-sm font-medium" style={{ color }}>#</span>
                  <input
                    ref={editTagInputRef}
                    value={editTagName}
                    onChange={e => setEditTagName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitEditTag(tag)
                      if (e.key === 'Escape') { setEditingTag(null); setEditTagName('') }
                    }}
                    onBlur={() => commitEditTag(tag)}
                    className="flex-1 text-sm bg-transparent outline-none text-gray-300"
                  />
                </div>
              ) : (
                <button
                  key={tag}
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg mt-0.5 text-left"
                  style={{ backgroundColor: contextTag === tag ? '#1f2937' : 'transparent' }}
                  onClick={e => { e.stopPropagation(); setContextTag(contextTag === tag ? null : tag) }}
                >
                  <span className="text-sm font-medium flex-1 truncate" style={{ color }}>#{tag}</span>
                  {contextTag === tag && (
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); setEditingTag(tag); setEditTagName(tag); setContextTag(null) }}
                        className="text-xs px-2 py-0.5 text-indigo-400 hover:text-indigo-300 rounded transition-colors"
                      >Edit</button>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); handleDeleteCustomTag(tag); setContextTag(null) }}
                        className="text-xs px-2 py-0.5 text-red-400 hover:text-red-300 rounded transition-colors"
                      >Delete</button>
                    </span>
                  )}
                </button>
              )
            )}

            {/* New tag input */}
            {addingTag && (
              <div className="flex items-center gap-2 px-2 py-1.5 bg-gray-800 rounded-lg mt-0.5">
                <span className="text-sm font-medium text-blue-400">#</span>
                <input
                  ref={newTagInputRef}
                  value={newTagName}
                  onChange={e => setNewTagName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleAddTag()
                    if (e.key === 'Escape') { setAddingTag(false); setNewTagName('') }
                  }}
                  onBlur={handleAddTag}
                  placeholder="Tag name…"
                  className="flex-1 text-sm bg-transparent outline-none text-gray-300 placeholder-gray-500"
                />
              </div>
            )}

            {customTagEntries.length === 0 && !addingTag && (
              <p className="text-xs text-gray-600 px-2 mt-0.5">No tags yet</p>
            )}
          </div>

        </div>
      </aside>

      <AnimatePresence>
        {confirmDeleteTag && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 flex items-center justify-center z-50"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={() => setConfirmDeleteTag(null)}
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
              <h2 className="text-white font-semibold text-lg text-center mb-1">Delete Tag?</h2>
              <p className="text-gray-400 text-sm text-center mb-5">This cannot be undone.</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmDeleteTag(null)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => { onDeleteCustomTag?.(confirmDeleteTag); setConfirmDeleteTag(null) }}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
