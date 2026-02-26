import { useState } from 'react'
import { formatDate, getPreview, contrastColor } from '../utils/helpers'

export default function NoteCard({ note, bubbles, allNotes, onClick, onDelete }) {
  const [showMenu, setShowMenu] = useState(false)
  const preview = getPreview(note.content, 3)
  const noteBubbles = bubbles.filter(b => note.bubble_ids.includes(b.id))

  function handleDelete(e) {
    e.stopPropagation()
    if (window.confirm('Delete this note?')) {
      onDelete()
    }
    setShowMenu(false)
  }

  return (
    <div
      onClick={onClick}
      className="relative bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md hover:border-gray-200 transition-all cursor-pointer group p-4"
    >
      {/* Menu button */}
      <button
        onClick={e => { e.stopPropagation(); setShowMenu(m => !m) }}
        className="absolute top-3 right-3 p-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 rounded transition-opacity"
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
          <div className="absolute top-8 right-3 bg-white rounded-lg shadow-lg border border-gray-100 z-20 py-1 min-w-[120px]">
            <button
              onClick={e => { e.stopPropagation(); onClick(); setShowMenu(false) }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Edit
            </button>
            <button
              onClick={handleDelete}
              className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        </>
      )}

      {/* Content preview */}
      <div className="pr-6">
        {preview ? (
          <p className="text-sm text-gray-800 whitespace-pre-wrap line-clamp-3 leading-relaxed">
            {preview}
          </p>
        ) : (
          <p className="text-sm text-gray-300 italic">Empty note</p>
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

      {/* Tags */}
      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {note.tags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Connections indicator */}
      {note.connections.length > 0 && (
        <div className="flex items-center gap-1 mt-2 text-xs text-gray-400">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          {note.connections.length} connection{note.connections.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  )
}
