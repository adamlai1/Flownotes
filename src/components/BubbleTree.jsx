import { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getNoteCountForBubble } from '../utils/helpers'

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
  const children = bubbles.filter(b => b.parent_id === bubble.id)
  const noteCount = getNoteCountForBubble(notes, bubble.id, bubbles)
  const isSelected = activeBubbleId === bubble.id
  const showChildren = expanded || forceExpandIds.has(bubble.id)

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
        className="relative flex items-center group"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
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
  onAddChildBubble,
}) {
  const rootBubbles = bubbles.filter(b => b.parent_id === parentId)
  const forceExpandIds = getAncestorIds(bubbles, activeBubbleId)

  return (
    <div className="space-y-0.5">
      {rootBubbles.map(bubble => (
        <BubbleNode
          key={bubble.id}
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
      ))}
    </div>
  )
}
