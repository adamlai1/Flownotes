import { useState, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { createDefaultProject } from './data/defaultData'
import { generateId } from './utils/helpers'
import {
  loadProjectList,
  saveProjectList,
  loadProject,
  saveProject,
  deleteProject as deleteProjectFromStorage,
} from './utils/storage'
import { TAG_COLORS } from './data/defaultData'

// Ensure default tag colors exist in customTagColors for projects created before they were unified
function migrateTagColors(project) {
  if (!project) return project
  const existing = project.customTagColors || {}
  const needsAny = Object.keys(TAG_COLORS).some(t => !(t in existing))
  if (!needsAny) return project
  return { ...project, customTagColors: { ...TAG_COLORS, ...existing } }
}
import { getNoteTitle } from './utils/helpers'
import TopNav from './components/TopNav'
import Sidebar from './components/Sidebar'
import MainView from './components/MainView'
import NoteEditor from './components/NoteEditor'
import Settings from './components/Settings'
import Onboarding from './components/Onboarding'
import { ThemeProvider } from './contexts/ThemeContext'

function initializeData() {
  let projectList = loadProjectList()
  if (!projectList) {
    const defaultProject = createDefaultProject()
    projectList = [{ id: defaultProject.id, name: defaultProject.name, created_at: defaultProject.created_at }]
    saveProjectList(projectList)
    saveProject(defaultProject)
    return { projectList, activeProject: defaultProject }
  }
  const activeProject = migrateTagColors(loadProject(projectList[0].id))
  return { projectList, activeProject }
}

export default function App() {
  const [projectList, setProjectList] = useState([])
  const [activeProject, setActiveProject] = useState(null)
  const [selectedBubbleId, setSelectedBubbleId] = useState(null)
  const [navigateBubbleId, setNavigateBubbleId] = useState(null)
  const [currentBubbleId, setCurrentBubbleId] = useState(null) // tracks where user is in bubble nav
  const [viewMode, setViewMode] = useState('bubble') // 'bubble' | 'chronological'
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 768px)').matches)

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = e => {
      setIsDesktop(e.matches)
      if (e.matches) setSidebarOpen(true)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  // Stack of note IDs open in the editor (last = topmost/active)
  const [noteStack, setNoteStack] = useState([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(() =>
    !localStorage.getItem('hasSeenOnboarding')
  )
  const saveTimerRef = useRef(null)
  // Always-current ref so deferred callbacks (debounced saves) never read stale state
  const activeProjectRef = useRef(null)
  activeProjectRef.current = activeProject

  useEffect(() => {
    const { projectList: pl, activeProject: ap } = initializeData()
    setProjectList(pl)
    setActiveProject(ap)
  }, [])

  const scheduleSave = useCallback((project) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveProject(project)
    }, 400)
  }, [])

  function updateProject(updatedProject) {
    setActiveProject(updatedProject)
    scheduleSave(updatedProject)
  }

  function switchProject(id) {
    const proj = migrateTagColors(loadProject(id))
    if (proj) {
      setActiveProject(proj)
      setSelectedBubbleId(null)
      setNoteStack([])
      setCurrentBubbleId(null)
      setViewMode('bubble')
    }
  }

  function createProject(name) {
    const now = new Date().toISOString()
    const newProject = {
      id: generateId(),
      name,
      created_at: now,
      bubbles: [],
      notes: [],
    }
    const newList = [...projectList, { id: newProject.id, name: newProject.name, created_at: now }]
    setProjectList(newList)
    saveProjectList(newList)
    saveProject(newProject)
    switchProject(newProject.id)
  }

  function renameProject(id, newName) {
    const newList = projectList.map(p => p.id === id ? { ...p, name: newName } : p)
    setProjectList(newList)
    saveProjectList(newList)
    if (activeProject?.id === id) {
      const updated = { ...activeProject, name: newName }
      setActiveProject(updated)
      saveProject(updated)
    }
  }

  function deleteProject(id) {
    if (projectList.length <= 1) return
    const newList = projectList.filter(p => p.id !== id)
    setProjectList(newList)
    saveProjectList(newList)
    deleteProjectFromStorage(id)
    if (activeProject?.id === id) {
      switchProject(newList[0].id)
    }
  }

  // Bubble operations
  function addBubble(bubble) {
    const updated = { ...activeProject, bubbles: [...activeProject.bubbles, bubble] }
    updateProject(updated)
  }

  function renameBubble(bubbleId, newName) {
    const updated = {
      ...activeProject,
      bubbles: activeProject.bubbles.map(b => b.id === bubbleId ? { ...b, name: newName } : b),
    }
    updateProject(updated)
  }

  function deleteBubble(bubbleId) {
    const toRemove = new Set()
    function collectIds(id) {
      toRemove.add(id)
      activeProject.bubbles.filter(b => b.parent_id === id).forEach(b => collectIds(b.id))
    }
    collectIds(bubbleId)

    const updated = {
      ...activeProject,
      bubbles: activeProject.bubbles.filter(b => !toRemove.has(b.id)),
      notes: activeProject.notes.map(n => ({
        ...n,
        bubble_ids: n.bubble_ids.filter(bid => !toRemove.has(bid)),
      })),
    }
    if (selectedBubbleId && toRemove.has(selectedBubbleId)) {
      setSelectedBubbleId(null)
    }
    updateProject(updated)
  }

  // Note operations
  function createNote(noteData) {
    const now = new Date().toISOString()
    const note = {
      id: generateId(),
      content: noteData.content || '',
      created_at: now,
      updated_at: now,
      bubble_ids: noteData.bubble_ids || [],
      tags: noteData.tags || [],
      connections: [],
    }
    const updated = { ...activeProject, notes: [note, ...activeProject.notes] }
    updateProject(updated)
    return note
  }

  function updateNote(noteId, changes) {
    const now = new Date().toISOString()
    const current = activeProjectRef.current
    const updated = {
      ...current,
      notes: current.notes.map(n =>
        n.id === noteId ? { ...n, ...changes, updated_at: now } : n
      ),
    }
    updateProject(updated)
  }

  function deleteNote(noteId) {
    const updated = {
      ...activeProject,
      notes: activeProject.notes
        .filter(n => n.id !== noteId)
        .map(n => ({
          ...n,
          connections: n.connections.filter(c => c.note_id !== noteId),
        })),
    }
    updateProject(updated)
    setNoteStack(prev => prev.filter(id => id !== noteId))
  }

  function updateCustomTagColors(colors) {
    const current = activeProjectRef.current
    const updated = { ...current, customTagColors: colors }
    updateProject(updated)
  }

  function deleteCustomTag(tagName) {
    const updatedColors = { ...(activeProject.customTagColors || {}) }
    delete updatedColors[tagName]
    const updatedNotes = activeProject.notes.map(n => ({
      ...n,
      tags: n.tags.filter(t => t !== tagName),
    }))
    updateProject({ ...activeProject, customTagColors: updatedColors, notes: updatedNotes })
  }

  function renameCustomTag(oldName, newName) {
    if (!newName || newName === oldName) return
    const existingColors = { ...(activeProject.customTagColors || {}) }
    const color = existingColors[oldName]
    delete existingColors[oldName]
    existingColors[newName] = color
    const updatedNotes = activeProject.notes.map(n => ({
      ...n,
      tags: n.tags.map(t => t === oldName ? newName : t),
    }))
    updateProject({ ...activeProject, customTagColors: existingColors, notes: updatedNotes })
  }

  function handleRefresh() {
    if (!activeProject) return
    const proj = migrateTagColors(loadProject(activeProject.id))
    if (proj) setActiveProject(proj)
  }

  // Open a note, resetting the stack (entry point from list/bubble views)
  function openNote(note) {
    setNoteStack([note.id])
  }

  // Push a connected note on top of the stack (in-editor navigation)
  function navigateToNote(note) {
    setNoteStack(prev => [...prev, note.id])
  }

  // Pop the top note off the stack; if empty, closes the editor
  function closeTopNote() {
    setNoteStack(prev => prev.slice(0, -1))
  }

  // Create an empty note at current bubble context and open editor
  function handleCreateNote() {
    const bubbleIds = currentBubbleId ? [currentBubbleId] : []
    const note = createNote({ content: '', bubble_ids: bubbleIds, tags: [] })
    setNoteStack([note.id])
  }

  if (!activeProject) {
    return (
      <div className="flex items-center justify-center h-screen bg-black">
        <div className="text-gray-600 text-lg">Loading…</div>
      </div>
    )
  }

  return (
    <ThemeProvider>
    <div className="flex flex-col h-dvh overflow-hidden">
      <TopNav
        projectList={projectList}
        activeProject={activeProject}
        onSwitchProject={switchProject}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
        onOpenSettings={() => setSettingsOpen(true)}
        isDesktop={isDesktop}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          open={sidebarOpen}
          isDesktop={isDesktop}
          project={activeProject}
          selectedBubbleId={selectedBubbleId}
          activeBubbleId={currentBubbleId}
          onSelectBubble={(id) => {
            setSelectedBubbleId(id)
            setViewMode('bubble')
            setNavigateBubbleId(id !== null ? id : 'root:' + Date.now())
            if (!isDesktop) setSidebarOpen(false)
          }}
          onAddBubble={addBubble}
          onRenameBubble={renameBubble}
          onDeleteBubble={deleteBubble}
          onUpdateCustomTagColors={updateCustomTagColors}
          onDeleteCustomTag={deleteCustomTag}
          onRenameCustomTag={renameCustomTag}
          onClose={() => setSidebarOpen(false)}
        />

        <MainView
          project={activeProject}
          viewMode={viewMode}
          onSetViewMode={setViewMode}
          onSelectNote={openNote}
          onDeleteNote={deleteNote}
          onCurrentBubbleChange={setCurrentBubbleId}
          navigateBubbleId={navigateBubbleId}
          onRefresh={handleRefresh}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(o => !o)}
        />
      </div>

      {/* Floating Create Button */}
      <button
        onClick={handleCreateNote}
        className="flex fixed bottom-6 right-6 w-14 h-14 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-lg items-center justify-center text-2xl z-40 transition-colors"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Create note"
      >
        +
      </button>

      {/* Settings panel */}
      <AnimatePresence>
        {settingsOpen && (
          <Settings key="settings" onClose={() => setSettingsOpen(false)} zIndex={45} />
        )}
      </AnimatePresence>

      {/* Note editor stack — each entry renders as a layer; only the top is interactive */}
      <AnimatePresence>
        {noteStack.map((noteId, index) => {
          const note = activeProject.notes.find(n => n.id === noteId)
          if (!note) return null
          const isTop = index === noteStack.length - 1
          const prevNote = index > 0
            ? activeProject.notes.find(n => n.id === noteStack[index - 1])
            : null
          const backLabel = prevNote
            ? (getNoteTitle(prevNote.content) || 'Untitled')
            : 'Notes'
          return (
            <NoteEditor
              key={noteId}
              note={note}
              project={activeProject}
              onClose={closeTopNote}
              onUpdateNote={updateNote}
              onDeleteNote={deleteNote}
              onUpdateCustomTagColors={updateCustomTagColors}
              onNavigateToNote={isTop ? navigateToNote : undefined}
              backLabel={backLabel}
              zIndex={50 + index}
            />
          )
        })}
      </AnimatePresence>

      {/* Onboarding overlay — first visit only */}
      <AnimatePresence>
        {showOnboarding && (
          <Onboarding
            key="onboarding"
            onDismiss={() => {
              localStorage.setItem('hasSeenOnboarding', '1')
              setShowOnboarding(false)
            }}
          />
        )}
      </AnimatePresence>
    </div>
    </ThemeProvider>
  )
}
