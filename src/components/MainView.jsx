import { useMemo } from 'react'
import NoteCard from './NoteCard'
import BubbleVisualization from './BubbleVisualization'
import { formatDateGroup } from '../utils/helpers'

export default function MainView({
  project,
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

  // Chronological: all notes newest-first, grouped by date
  const sortedNotes = useMemo(() =>
    [...project.notes].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    [project.notes]
  )

  const grouped = useMemo(() => {
    const groups = {}
    sortedNotes.forEach(note => {
      const label = formatDateGroup(note.created_at)
      if (!groups[label]) groups[label] = []
      groups[label].push(note)
    })
    return groups
  }, [sortedNotes])

  return (
    <main className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="max-w-2xl mx-auto px-4 py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-gray-800">All Notes</h1>
            <span className="text-sm text-gray-400">({project.notes.length})</span>
          </div>

          {/* Two-mode toggle */}
          <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
            <button
              onClick={() => onSetViewMode('bubble')}
              className="px-3 py-1 text-xs font-medium rounded-md transition-colors text-gray-500 hover:text-gray-700"
            >
              ◉ Bubble
            </button>
            <button
              className="px-3 py-1 text-xs font-medium rounded-md transition-colors bg-white shadow text-gray-800"
            >
              Chrono
            </button>
          </div>
        </div>

        {/* Notes grouped by date */}
        {sortedNotes.length === 0 ? (
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
        ) : (
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
        )}
      </div>
    </main>
  )
}
