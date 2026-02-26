import { useMemo } from 'react'
import NoteCard from './NoteCard'
import BubbleVisualization from './BubbleVisualization'
import { getBubbleDescendantIds, formatDateGroup } from '../utils/helpers'

export default function MainView({
  project,
  selectedBubbleId,
  viewMode,
  onSetViewMode,
  onSelectNote,
  onDeleteNote,
}) {
  // Bubble view takes over the entire panel
  if (viewMode === 'bubble') {
    return (
      <BubbleVisualization
        project={project}
        onSelectNote={onSelectNote}
        viewMode={viewMode}
        onSetViewMode={onSetViewMode}
      />
    )
  }

  const selectedBubble = selectedBubbleId
    ? project.bubbles.find(b => b.id === selectedBubbleId)
    : null

  const filteredNotes = useMemo(() => {
    if (viewMode === 'chronological') {
      return [...project.notes].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    }
    if (selectedBubbleId === null) {
      return [...project.notes].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    }
    const ids = getBubbleDescendantIds(project.bubbles, selectedBubbleId)
    return project.notes
      .filter(n => n.bubble_ids.some(bid => ids.includes(bid)))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [project.notes, project.bubbles, selectedBubbleId, viewMode])

  const grouped = useMemo(() => {
    if (viewMode !== 'chronological') return null
    const groups = {}
    filteredNotes.forEach(note => {
      const label = formatDateGroup(note.created_at)
      if (!groups[label]) groups[label] = []
      groups[label].push(note)
    })
    return groups
  }, [filteredNotes, viewMode])

  const title = viewMode === 'chronological'
    ? 'All Notes'
    : selectedBubble
      ? selectedBubble.name
      : 'All Notes'

  return (
    <main className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="max-w-2xl mx-auto px-4 py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {selectedBubble && (
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: selectedBubble.color }}
              />
            )}
            <h1 className="text-lg font-semibold text-gray-800">{title}</h1>
            <span className="text-sm text-gray-400">({filteredNotes.length})</span>
          </div>

          {/* View mode toggle — three options */}
          <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
            <button
              onClick={() => onSetViewMode('bubble')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'bubble'
                  ? 'bg-white shadow text-gray-800'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              ◉ Bubble
            </button>
            <button
              onClick={() => onSetViewMode('filtered')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'filtered'
                  ? 'bg-white shadow text-gray-800'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Filtered
            </button>
            <button
              onClick={() => onSetViewMode('chronological')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                viewMode === 'chronological'
                  ? 'bg-white shadow text-gray-800'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Chrono
            </button>
          </div>
        </div>

        {/* Notes */}
        {filteredNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-gray-400 text-sm">No notes yet</p>
            <p className="text-gray-300 text-xs mt-1">Press + to create one</p>
          </div>
        ) : viewMode === 'chronological' && grouped ? (
          <div className="space-y-6">
            {Object.entries(grouped).map(([dateLabel, notes]) => (
              <div key={dateLabel}>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
                  {dateLabel}
                </div>
                <div className="space-y-3">
                  {notes.map(note => (
                    <NoteCard
                      key={note.id}
                      note={note}
                      bubbles={project.bubbles}
                      allNotes={project.notes}
                      onClick={() => onSelectNote(note)}
                      onDelete={() => onDeleteNote(note.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredNotes.map(note => (
              <NoteCard
                key={note.id}
                note={note}
                bubbles={project.bubbles}
                allNotes={project.notes}
                onClick={() => onSelectNote(note)}
                onDelete={() => onDeleteNote(note.id)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
