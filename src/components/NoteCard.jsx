import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { formatDate, getNoteTitle, contrastColor } from '../utils/helpers'
import { TAG_COLORS } from '../data/defaultData'

export default function NoteCard({ note, bubbles, allNotes, onClick, onDelete, onTogglePin, pinned = false, customTagColors = {} }) {
  const [showMenu, setShowMenu] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const title = getNoteTitle(note.content)
  const allLines = (note.content || '').split('\n')
  const titleLineIdx = allLines.findIndex(l => l.trim())
  const bodyPreview = allLines
    .slice(titleLineIdx + 1)
    .filter(l => l.trim())
    .join(' ')
  const noteBubbles = bubbles.filter(b => note.bubble_ids.includes(b.id))
  // Count both forward connections (this note → others) and reverse (others → this note)
  const reverseConnectionCount = allNotes
    ? allNotes.filter(n => n.id !== note.id && n.connections.some(c => c.note_id === note.id)).length
    : 0
  const totalConnectionCount = note.connections.length + reverseConnectionCount

  function handleDelete(e) {
    e.stopPropagation()
    setShowMenu(false)
    setShowDeleteConfirm(true)
  }

  return (
    <div
      onClick={onClick}
      className="relative bg-gray-900 rounded-xl border border-gray-800 shadow-sm hover:shadow-md hover:border-gray-700 transition-all cursor-pointer group p-4"
    >
      {/* Pin icon */}
      {pinned && (
        <svg className="absolute top-3 right-9 w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z" />
        </svg>
      )}

      {/* Menu button */}
      <button
        onClick={e => { e.stopPropagation(); setShowMenu(m => !m) }}
        className="absolute top-3 right-3 p-1 text-gray-600 hover:text-gray-400 rounded"
        aria-label="Note options"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="5" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="19" cy="12" r="1.5" />
        </svg>
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-10" onClick={e => { e.stopPropagation(); setShowMenu(false) }} />
          <div className="absolute top-8 right-3 bg-gray-900 rounded-lg shadow-lg border border-gray-800 z-20 py-1 min-w-[120px]">
            <button
              onClick={e => { e.stopPropagation(); onTogglePin?.(); setShowMenu(false) }}
              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
            >
              {pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              onClick={handleDelete}
              className="w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-red-950"
            >
              Delete
            </button>
          </div>
        </>
      )}

      {/* Title + body preview */}
      <div className="pr-6">
        {title ? (
          <>
            <p className="text-sm font-medium text-gray-100 truncate leading-snug">{title}</p>
            {bodyPreview && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">{bodyPreview}</p>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-600 italic">Empty note</p>
        )}
      </div>

      {/* Timestamp */}
      <p className="text-xs text-gray-400 mt-2">{formatDate(note.created_at)}</p>

      {/* Bubble badges */}
      {noteBubbles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {noteBubbles.map(bubble => (
            <span
              key={bubble.id}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
              style={{
                backgroundColor: bubble.color + '22',
                color: bubble.color,
                border: `1px solid ${bubble.color}44`,
              }}
            >
              {bubble.name}
            </span>
          ))}
        </div>
      )}

      {/* Tags — displayed as hashtags to visually distinguish from bubble pills */}
      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {note.tags.map(tag => {
            const color = TAG_COLORS[tag] || customTagColors[tag]
            return (
              <span
                key={tag}
                className="text-xs font-medium"
                style={{ color: color || 'rgb(107,114,128)' }}
              >
                #{tag}
              </span>
            )
          })}
        </div>
      )}

      {/* Connections indicator — counts both forward and reverse connections */}
      {totalConnectionCount > 0 && (
        <div className="flex items-center gap-1 mt-2 text-xs text-gray-400">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          {totalConnectionCount} connection{totalConnectionCount !== 1 ? 's' : ''}
        </div>
      )}

      {/* Delete confirmation modal */}
      <AnimatePresence>
        {showDeleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 flex items-center justify-center z-50"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={e => { e.stopPropagation(); setShowDeleteConfirm(false) }}
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
                  onClick={e => { e.stopPropagation(); setShowDeleteConfirm(false) }}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={e => { e.stopPropagation(); setShowDeleteConfirm(false); onDelete() }}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
