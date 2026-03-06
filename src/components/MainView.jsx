import { useMemo, useState, useRef, useEffect } from 'react'
import NoteCard from './NoteCard'
import BubbleVisualization from './BubbleVisualization'
import { formatDateGroup } from '../utils/helpers'
import { TAG_COLORS } from '../data/defaultData'

const SORT_MODES = [
  { id: 'newest', label: 'Newest first', dateField: 'created_at', dir: -1 },
  { id: 'oldest', label: 'Oldest first', dateField: 'created_at', dir: 1 },
  { id: 'edited',  label: 'Recently edited', dateField: 'updated_at', dir: -1 },
]


export default function MainView({
  project,
  viewMode,
  onSetViewMode,
  onSelectNote,
  onDeleteNote,
  onCurrentBubbleChange,
  navigateBubbleId,
  onRefresh,
  sidebarOpen,
  onToggleSidebar,
}) {
  const [activeBubbleId, setActiveBubbleId] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('mindmap-sort') || 'newest')
  const [showSortMenu, setShowSortMenu] = useState(false)
  const sortMenuRef = useRef(null)
  const [pinnedIds, setPinnedIds] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`mindmap-pins-${project.id}`)) || []) }
    catch { return new Set() }
  })

  useEffect(() => {
    try { setPinnedIds(new Set(JSON.parse(localStorage.getItem(`mindmap-pins-${project.id}`)) || [])) }
    catch { setPinnedIds(new Set()) }
  }, [project.id])

  function togglePin(noteId) {
    setPinnedIds(prev => {
      const next = new Set(prev)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      localStorage.setItem(`mindmap-pins-${project.id}`, JSON.stringify([...next]))
      return next
    })
  }

  useEffect(() => {
    if (!showSortMenu) return
    function handleOutside(e) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target)) setShowSortMenu(false)
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('touchstart', handleOutside)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('touchstart', handleOutside)
    }
  }, [showSortMenu])

  function handleSortChange(id) {
    setSortMode(id)
    localStorage.setItem('mindmap-sort', id)
    setShowSortMenu(false)
  }

  // Tags in project color map order, then any tags used on notes but not in the map
  const allTags = useMemo(() => {
    const projectTags = Object.keys(project.customTagColors || {})
    const projectTagSet = new Set(projectTags)
    const usedTags = new Set()
    project.notes.forEach(n => n.tags.forEach(t => usedTags.add(t)))
    const extraTags = [...usedTags].filter(t => !projectTagSet.has(t)).sort()
    return [...projectTags, ...extraTags]
  }, [project.notes, project.customTagColors])

  const currentSortMode = SORT_MODES.find(m => m.id === sortMode) || SORT_MODES[0]

  const sortedNotes = useMemo(() => {
    const { dateField, dir } = currentSortMode
    return [...project.notes].sort((a, b) =>
      (new Date(a[dateField]) - new Date(b[dateField])) * dir
    )
  }, [project.notes, sortMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const searchedNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sortedNotes
    return sortedNotes.filter(note => note.content.toLowerCase().includes(q))
  }, [sortedNotes, searchQuery])

  const hasFilters = activeBubbleId !== '' || activeTag !== '' || searchQuery.trim() !== ''

  const filteredNotes = useMemo(() => {
    if (!activeBubbleId && !activeTag) return searchedNotes
    return searchedNotes.filter(note => {
      const matchesBubble = activeBubbleId === '' || note.bubble_ids.includes(activeBubbleId)
      const matchesTag = activeTag === '' || note.tags.includes(activeTag)
      return matchesBubble && matchesTag
    })
  }, [searchedNotes, activeBubbleId, activeTag])

  const pinnedNotes = useMemo(
    () => filteredNotes.filter(n => pinnedIds.has(n.id)),
    [filteredNotes, pinnedIds]
  )

  const unpinnedNotes = useMemo(
    () => filteredNotes.filter(n => !pinnedIds.has(n.id)),
    [filteredNotes, pinnedIds]
  )

  const grouped = useMemo(() => {
    const groups = {}
    unpinnedNotes.forEach(note => {
      const label = formatDateGroup(note[currentSortMode.dateField])
      if (!groups[label]) groups[label] = []
      groups[label].push(note)
    })
    return groups
  }, [unpinnedNotes, sortMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const showFilters = project.bubbles.length > 0 || allTags.length > 0

  function clearFilters() {
    setActiveBubbleId('')
    setActiveTag('')
    setSearchQuery('')
  }

  // Bubble view takes over the entire panel — must come after all hooks
  if (viewMode === 'bubble') {
    return (
      <BubbleVisualization
        project={project}
        onSelectNote={onSelectNote}
        viewMode={viewMode}
        onSetViewMode={onSetViewMode}
        onCurrentBubbleChange={onCurrentBubbleChange}
        navigateToBubbleId={navigateBubbleId}
        onRefresh={onRefresh}
      />
    )
  }

  const selectedBubble = project.bubbles.find(b => b.id === activeBubbleId)

  return (
    <main
      className="flex-1 overflow-y-auto scrollbar-thin bg-black"
      style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}
    >
      {/* Sticky header + filters */}
      <div className="sticky top-0 z-10 bg-black">
        <div className="max-w-2xl mx-auto px-4">
          {/* Title row — h-[52px] matches bubble view sub-bar height exactly */}
          <div className="flex items-center justify-between" style={{ height: 52 }}>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-white">All Notes</h1>
              <span className="text-sm text-gray-400">
                ({filteredNotes.length}{hasFilters ? `/${project.notes.length}` : ''})
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* Sort button */}
              <div className="relative flex-shrink-0" ref={sortMenuRef}>
                <button
                  onClick={() => setShowSortMenu(v => !v)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: showSortMenu ? 'var(--hover)' : 'var(--input-bg)',
                    border: '1px solid var(--input-border)',
                    color: showSortMenu ? 'var(--text)' : 'var(--text-muted)',
                  }}
                >
                  <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                  </svg>
                  <span className="hidden sm:inline">{currentSortMode.label}</span>
                </button>
                {showSortMenu && (
                  <div
                    className="absolute right-0 top-full mt-1.5 rounded-xl shadow-2xl overflow-hidden z-30"
                    style={{
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      minWidth: 168,
                    }}
                  >
                    {SORT_MODES.map(mode => (
                      <button
                        key={mode.id}
                        onClick={() => handleSortChange(mode.id)}
                        className="w-full text-left px-4 py-2.5 text-sm flex items-center justify-between gap-3 transition-colors"
                        style={{
                          color: sortMode === mode.id ? '#818cf8' : 'var(--text-2)',
                          background: sortMode === mode.id ? 'rgba(99,102,241,0.12)' : 'transparent',
                        }}
                      >
                        {mode.label}
                        {sortMode === mode.id && (
                          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Two-mode toggle */}
              <div
                className="flex-shrink-0 flex rounded-xl overflow-hidden"
                style={{
                  background: 'var(--hover)',
                  border: '1px solid var(--border)',
                }}
              >
                {[
                  {
                    id: 'bubble',
                    icon: (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="12" cy="12" r="4" strokeWidth={2} />
                        <circle cx="12" cy="12" r="9" strokeWidth={1.5} strokeDasharray="3 2" />
                      </svg>
                    ),
                  },
                  {
                    id: 'chronological',
                    icon: (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                      </svg>
                    ),
                  },
                ].map(m => (
                  <button
                    key={m.id}
                    onClick={() => onSetViewMode(m.id)}
                    className={`px-3 py-1.5 transition-colors ${
                      viewMode === m.id ? 'bg-white/20 text-white' : 'text-white/45 hover:text-white/80'
                    }`}
                  >
                    {m.icon}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Search bar */}
          <div className="pb-2">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-xl"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}
            >
              <svg className="w-4 h-4 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search notes..."
                className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 outline-none"
                style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-gray-600 hover:text-gray-400 flex-shrink-0 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Filter dropdowns */}
          {showFilters && (
            <div className="flex gap-2 pb-3 -mt-1">
              {/* Bubble dropdown */}
              {project.bubbles.length > 0 && (
                <div className="relative flex-1">
                  <select
                    value={activeBubbleId}
                    onChange={e => setActiveBubbleId(e.target.value)}
                    className="w-full appearance-none text-xs font-medium rounded-lg px-3 py-1.5 pr-7 cursor-pointer transition-colors outline-none"
                    style={activeBubbleId && selectedBubble ? {
                      background: `${selectedBubble.color}22`,
                      border: `1px solid ${selectedBubble.color}66`,
                      color: selectedBubble.color,
                    } : {
                      background: 'var(--input-bg)',
                      border: '1px solid var(--input-border)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <option value="">All Bubbles</option>
                    {project.bubbles.map(bubble => (
                      <option key={bubble.id} value={bubble.id}>{bubble.name}</option>
                    ))}
                  </select>
                  <svg
                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3"
                    style={{ color: activeBubbleId && selectedBubble ? selectedBubble.color : 'var(--text-muted)' }}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              )}

              {/* Tag dropdown */}
              {allTags.length > 0 && (
                <div className="relative flex-1">
                  <select
                    value={activeTag}
                    onChange={e => setActiveTag(e.target.value)}
                    className="w-full appearance-none text-xs font-medium rounded-lg px-3 py-1.5 pr-7 cursor-pointer transition-colors outline-none"
                    style={activeTag && (project.customTagColors?.[activeTag] || TAG_COLORS[activeTag]) ? {
                      background: `${project.customTagColors?.[activeTag] || TAG_COLORS[activeTag]}22`,
                      border: `1px solid ${project.customTagColors?.[activeTag] || TAG_COLORS[activeTag]}66`,
                      color: project.customTagColors?.[activeTag] || TAG_COLORS[activeTag],
                    } : activeTag ? {
                      background: 'var(--input-bg)',
                      border: '1px solid var(--input-border)',
                      color: 'var(--text-2)',
                    } : {
                      background: 'var(--input-bg)',
                      border: '1px solid var(--input-border)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <option value="">All Tags</option>
                    {allTags.map(tag => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </select>
                  <svg
                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3"
                    style={{ color: activeTag && (project.customTagColors?.[activeTag] || TAG_COLORS[activeTag]) ? (project.customTagColors?.[activeTag] || TAG_COLORS[activeTag]) : 'var(--text-muted)' }}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom fade to hint that content scrolls */}
        <div className="h-px bg-white/5" />
      </div>

      {/* Scrollable notes list */}
      <div className="max-w-2xl mx-auto px-4 pt-4 pb-32">
        {sortedNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-gray-400 text-sm">No notes yet</p>
            <p className="text-gray-300 text-xs mt-1">Press + to create one</p>
          </div>
        ) : filteredNotes.length === 0 && searchQuery.trim() ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-gray-400 text-sm">No notes found</p>
            <button
              onClick={() => setSearchQuery('')}
              className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Clear search
            </button>
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-gray-400 text-sm">No notes match these filters</p>
            <button
              onClick={clearFilters}
              className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Pinned section */}
            {pinnedNotes.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z" />
                  </svg>
                  Pinned
                </div>
                <div className="grid grid-cols-1 gap-3 landscape:grid-cols-2">
                  {pinnedNotes.map(note => (
                    <NoteCard
                      key={note.id}
                      note={note}
                      bubbles={project.bubbles}
                      allNotes={project.notes}
                      onClick={() => onSelectNote(note)}
                      onDelete={() => onDeleteNote(note.id)}
                      onTogglePin={() => togglePin(note.id)}
                      pinned
                      customTagColors={project.customTagColors || {}}
                    />
                  ))}
                </div>
              </div>
            )}
            {/* Date groups (unpinned) */}
            {Object.entries(grouped).map(([dateLabel, notes]) => (
              <div key={dateLabel}>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
                  {dateLabel}
                </div>
                <div className="grid grid-cols-1 gap-3 landscape:grid-cols-2">
                  {notes.map(note => (
                    <NoteCard
                      key={note.id}
                      note={note}
                      bubbles={project.bubbles}
                      allNotes={project.notes}
                      onClick={() => onSelectNote(note)}
                      onDelete={() => onDeleteNote(note.id)}
                      onTogglePin={() => togglePin(note.id)}
                      pinned={pinnedIds.has(note.id)}
                      customTagColors={project.customTagColors || {}}
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
