import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { formatDate, noteTitle, contrastColor, realBubbleIds } from '../utils/helpers'
import { useEscapeLayer, ESC_LEVEL } from '../lib/escapeStack'
import { useToast } from '../contexts/ToastContext'
import { canShareNotes, copyNoteText, shareNoteText } from '../utils/noteShare'
import { TAG_COLORS } from '../data/defaultData'

export default function NoteCard({ note, bubbles, allNotes, onClick, onDelete, onTogglePin, onToggleLock, locked = false, pinned = false, customTagColors = {}, selectMode = false, selected = false, onToggleSelect }) {
  const [showMenu, setShowMenu] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const title = noteTitle(note)
  const allLines = (note.content || '').split('\n')
  const titleLineIdx = allLines.findIndex(l => l.trim())
  const bodyPreview = allLines
    .slice(titleLineIdx + 1)
    .filter(l => l.trim())
    .join(' ')
  // `locked` here means "hidden right now" (the note's own lock, or an inherited one
  // from a locked bubble, that hasn't been unlocked this session). Everything derived
  // from the note's content is withheld while it's true — title, preview, tags,
  // bubbles and the connection count would all leak something about the note.
  const noteBubbles = locked ? [] : bubbles.filter(b => realBubbleIds(note).includes(b.id))
  // Count both forward connections (this note → others) and reverse (others → this note)
  const reverseConnectionCount = allNotes
    ? allNotes.filter(n => n.id !== note.id && n.connections.some(c => c.note_id === note.id)).length
    : 0
  const totalConnectionCount = locked ? 0 : note.connections.length + reverseConnectionCount

  useEscapeLayer(showDeleteConfirm, () => setShowDeleteConfirm(false), ESC_LEVEL.modal)

  const showToast = useToast()
  // Share is only offered where a share sheet exists; read once, since it can't appear
  // partway through the life of a card.
  const canShare = canShareNotes()

  // Both actions close the menu first and report through the toast, because the menu is
  // gone by the time the clipboard write or the share sheet settles.
  function handleCopy(e) {
    e.stopPropagation()
    setShowMenu(false)
    copyNoteText(note).then(showToast)
  }

  function handleShare(e) {
    e.stopPropagation()
    setShowMenu(false)
    shareNoteText(note).then(showToast)
  }

  function handleDelete(e) {
    e.stopPropagation()
    setShowMenu(false)
    setShowDeleteConfirm(true)
  }

  return (
    <div
      onClick={selectMode ? onToggleSelect : onClick}
      className="relative rounded-xl shadow-sm hover:shadow-md transition-all cursor-pointer group p-4"
      style={{
        // Neutral surface (was navy bg-gray-900 with a gray-800 border). The
        // selection ring keeps the app-wide indigo — it marks a functional state,
        // same as the canvas SelectionOverlay.
        background: 'var(--surface)',
        border: `1px solid ${selected ? '#6366f1' : 'var(--border)'}`,
        boxShadow: selected ? '0 0 0 1px #6366f1' : undefined,
      }}
    >
      {/* Pin icon — hidden in select mode (menu/checkbox take that corner) */}
      {pinned && !selectMode && (
        <svg className="absolute top-3 right-9 w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z" />
        </svg>
      )}

      {/* Selection badge (select mode, SELECTED cards only — unselected cards get
          no circle: everything is selectable in select mode, so the empty-circle
          affordance was pure noise) or the options menu (normal) */}
      {selectMode ? (
        selected && (
        <span
          className="absolute top-3 right-3 w-5 h-5 rounded-full flex items-center justify-center transition-colors"
          style={{ background: '#6366f1' }}
        >
          <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
          </svg>
        </span>
        )
      ) : (
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
      )}

      {showMenu && !selectMode && (
        <>
          <div className="fixed inset-0 z-10" onClick={e => { e.stopPropagation(); setShowMenu(false) }} />
          <div
            className="absolute top-8 right-3 rounded-lg shadow-lg z-20 py-1 min-w-[120px]"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
          >
            <button
              onClick={e => { e.stopPropagation(); onTogglePin?.(); setShowMenu(false) }}
              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
            >
              {pinned ? 'Unpin' : 'Pin'}
            </button>
            {/* Withheld while the note is hidden: the whole point of the lock is that the
                content is out of reach, and a Copy one tap away would be a way around it
                rather than a shortcut through it. */}
            {!locked && (
              <button
                onClick={handleCopy}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Copy
              </button>
            )}
            {!locked && canShare && (
              <button
                onClick={handleShare}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Share
              </button>
            )}
            <button
              onClick={e => { e.stopPropagation(); onToggleLock?.(); setShowMenu(false) }}
              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
            >
              {/* Hidden (by its own lock or an inherited one) → ask for the password.
                  Visible but locked → drop the lock. Otherwise → lock it. */}
              {locked ? 'Unlock' : note.locked ? 'Remove Lock' : 'Lock'}
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

      {/* Title + body preview — replaced by a lock placeholder while hidden */}
      <div className="pr-6">
        {locked ? (
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <p className="text-sm font-medium text-gray-500 leading-snug">Locked</p>
          </div>
        ) : title ? (
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

      {/* Timestamp (left) + bubble badges (bottom-right, same line) */}
      <div className="flex items-end justify-between gap-2 mt-2">
        <p className="text-xs text-gray-400 flex-shrink-0">{formatDate(note.created_at)}</p>
        {noteBubbles.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 min-w-0">
            {noteBubbles.map(bubble => (
              <span
                key={bubble.id}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium max-w-[9rem]"
                style={{
                  backgroundColor: bubble.color + '22',
                  color: bubble.color,
                  border: `1px solid ${bubble.color}44`,
                }}
              >
                <span className="truncate">{bubble.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Bottom row: tags bottom-left as a compact hashtag cluster (first 3 +
          "+N" overflow count — wrapping would grow the card), connections
          indicator on the right. */}
      {(totalConnectionCount > 0 || (!locked && note.tags.length > 0)) && (
        <div className="flex items-end justify-between gap-2 mt-2">
          {!locked && note.tags.length > 0 ? (
            <div className="flex items-center gap-x-2 min-w-0">
              {note.tags.slice(0, 3).map(tag => {
                const color = TAG_COLORS[tag] || customTagColors[tag]
                return (
                  <span
                    key={tag}
                    className="text-xs font-medium truncate max-w-[8rem]"
                    style={{ color: color || 'rgb(107,114,128)' }}
                  >
                    #{tag}
                  </span>
                )
              })}
              {note.tags.length > 3 && (
                <span className="text-xs text-gray-500 flex-shrink-0">+{note.tags.length - 3}</span>
              )}
            </div>
          ) : <span />}
          {totalConnectionCount > 0 && (
            <div className="flex items-center gap-1 text-xs text-gray-400 flex-shrink-0">
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              {totalConnectionCount} connection{totalConnectionCount !== 1 ? 's' : ''}
            </div>
          )}
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
