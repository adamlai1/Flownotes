import { useState, useEffect, useRef, useCallback } from 'react'
import { formatDate, contrastColor } from '../utils/helpers'
import { CONNECTION_TYPES } from '../data/defaultData'

export default function NoteModal({ note, project, onClose, onUpdateNote, onDeleteNote }) {
  const [content, setContent] = useState(note.content)
  const [selectedBubbleIds, setSelectedBubbleIds] = useState(note.bubble_ids)
  const [tags, setTags] = useState(note.tags)
  const [tagInput, setTagInput] = useState('')
  const [connections, setConnections] = useState(note.connections)
  const [addingConnection, setAddingConnection] = useState(false)
  const [connNoteId, setConnNoteId] = useState('')
  const [connType, setConnType] = useState(CONNECTION_TYPES[0])
  const [customConnType, setCustomConnType] = useState('')
  const [moreInfoOpen, setMoreInfoOpen] = useState(false)
  const saveTimerRef = useRef(null)

  // Autosave content
  const scheduleContentSave = useCallback((newContent) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      onUpdateNote(note.id, { content: newContent })
    }, 600)
  }, [note.id, onUpdateNote])

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [content, selectedBubbleIds, tags, connections])

  function handleClose() {
    // Flush any pending saves immediately
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    onUpdateNote(note.id, { content, bubble_ids: selectedBubbleIds, tags, connections })
    onClose()
  }

  function handleContentChange(e) {
    const val = e.target.value
    setContent(val)
    scheduleContentSave(val)
  }

  function toggleBubble(id) {
    const updated = selectedBubbleIds.includes(id)
      ? selectedBubbleIds.filter(b => b !== id)
      : [...selectedBubbleIds, id]
    setSelectedBubbleIds(updated)
    onUpdateNote(note.id, { bubble_ids: updated })
  }

  function addTag() {
    const tag = tagInput.trim().replace(/^#/, '')
    if (tag && !tags.includes(tag)) {
      const updated = [...tags, tag]
      setTags(updated)
      onUpdateNote(note.id, { tags: updated })
    }
    setTagInput('')
  }

  function removeTag(tag) {
    const updated = tags.filter(t => t !== tag)
    setTags(updated)
    onUpdateNote(note.id, { tags: updated })
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
    if (window.confirm('Delete this note?')) {
      onDeleteNote(note.id)
      onClose()
    }
  }

  // Notes available for connection (exclude self)
  const connectableNotes = project.notes.filter(n => n.id !== note.id)
  const connectedNoteIds = new Set(connections.map(c => c.note_id))

  function renderBubbleCheckboxes(parentId = null, depth = 0) {
    const items = project.bubbles.filter(b => b.parent_id === parentId)
    if (items.length === 0) return null
    return items.map(bubble => (
      <div key={bubble.id}>
        <label
          className="flex items-center gap-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer"
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          <input
            type="checkbox"
            checked={selectedBubbleIds.includes(bubble.id)}
            onChange={() => toggleBubble(bubble.id)}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: bubble.color }} />
          <span className="text-sm text-gray-700">{bubble.name}</span>
        </label>
        {renderBubbleCheckboxes(bubble.id, depth + 1)}
      </div>
    ))
  }

  const noteBubbles = project.bubbles.filter(b => selectedBubbleIds.includes(b.id))

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-end sm:justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={handleClose} />

      {/* Slide-over panel */}
      <div className="relative bg-white w-full sm:max-w-2xl h-full sm:h-auto sm:max-h-[90vh] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={handleClose}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <span className="text-xs text-gray-400">{formatDate(note.created_at)}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleDelete}
              className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
              title="Delete note"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {/* Bubble badges (current) */}
          {noteBubbles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {noteBubbles.map(b => (
                <span
                  key={b.id}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer"
                  style={{ backgroundColor: b.color + '22', color: b.color, border: `1px solid ${b.color}44` }}
                  onClick={() => toggleBubble(b.id)}
                  title="Click to remove"
                >
                  {b.name} ×
                </span>
              ))}
            </div>
          )}

          {/* Note content editor */}
          <div className="px-4 py-3">
            <textarea
              value={content}
              onChange={handleContentChange}
              placeholder="Write your note..."
              className="w-full text-sm text-gray-800 placeholder-gray-300 outline-none resize-none leading-relaxed min-h-[200px]"
              rows={10}
            />
          </div>

          {/* Tags row */}
          {(tags.length > 0 || true) && (
            <div className="px-4 pb-3 flex flex-wrap gap-1.5 items-center border-t border-gray-50 pt-3">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs"
                >
                  #{tag}
                  <button onClick={() => removeTag(tag)} className="hover:text-red-500 font-medium">×</button>
                </span>
              ))}
              <div className="flex items-center gap-1">
                <input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() }
                  }}
                  placeholder="+ tag"
                  className="text-xs px-2 py-0.5 border border-gray-200 rounded-full outline-none w-20 focus:w-32 focus:border-indigo-300 transition-all"
                />
              </div>
            </div>
          )}

          {/* More Info accordion */}
          <div className="border-t border-gray-100">
            <button
              onClick={() => setMoreInfoOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <span>More Info</span>
              <svg className={`w-4 h-4 transition-transform ${moreInfoOpen ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {moreInfoOpen && (
              <div className="px-4 pb-4 space-y-4">
                {/* Timestamps */}
                <div className="text-xs text-gray-400 space-y-0.5">
                  <div>Created: {formatDate(note.created_at)}</div>
                  <div>Edited: {formatDate(note.updated_at)}</div>
                </div>

                {/* Bubble multi-selector */}
                {project.bubbles.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Bubbles</p>
                    <div className="space-y-0.5 max-h-36 overflow-y-auto scrollbar-thin">
                      {renderBubbleCheckboxes()}
                    </div>
                  </div>
                )}

                {/* Connections */}
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Connections</p>

                  {connections.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      {connections.map((conn, idx) => {
                        const connNote = project.notes.find(n => n.id === conn.note_id)
                        return (
                          <div key={idx} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                            <div className="flex-1 min-w-0">
                              <span className="text-xs text-indigo-600 font-medium">{conn.relationship_type}</span>
                              <span className="text-xs text-gray-400 mx-1">→</span>
                              <span className="text-xs text-gray-700 truncate">
                                {connNote ? connNote.content.slice(0, 60) : 'Deleted note'}
                              </span>
                            </div>
                            <button
                              onClick={() => removeConnection(idx)}
                              className="text-gray-400 hover:text-red-500 flex-shrink-0"
                            >×</button>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {addingConnection ? (
                    <div className="space-y-2 bg-gray-50 rounded-xl p-3">
                      <select
                        value={connNoteId}
                        onChange={e => setConnNoteId(e.target.value)}
                        className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-300 bg-white"
                      >
                        <option value="">Select a note...</option>
                        {connectableNotes.map(n => (
                          <option key={n.id} value={n.id}>
                            {n.content.slice(0, 60)}{n.content.length > 60 ? '...' : ''}
                          </option>
                        ))}
                      </select>

                      <select
                        value={connType}
                        onChange={e => setConnType(e.target.value)}
                        className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-300 bg-white"
                      >
                        {CONNECTION_TYPES.map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                        <option value="__custom__">Custom type...</option>
                      </select>

                      {connType === '__custom__' && (
                        <input
                          value={customConnType}
                          onChange={e => setCustomConnType(e.target.value)}
                          placeholder="Relationship type..."
                          className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-300"
                        />
                      )}

                      <div className="flex gap-2">
                        <button
                          onClick={addConnection}
                          disabled={!connNoteId}
                          className="flex-1 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                        >
                          Add Connection
                        </button>
                        <button
                          onClick={() => setAddingConnection(false)}
                          className="flex-1 py-1.5 text-xs font-medium bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingConnection(true)}
                      disabled={connectableNotes.length === 0}
                      className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span className="text-base leading-none">+</span>
                      Add connection
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
