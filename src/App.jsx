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
import { useAuth } from './contexts/AuthContext'

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

function LoginScreen() {
  const { signInWithGoogle } = useAuth()
  return (
    <div className="flex flex-col items-center justify-center h-dvh bg-gray-950 gap-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">FlowNotes</h1>
        <p className="text-gray-400">Sign in to access your notes</p>
      </div>
      <button
        onClick={signInWithGoogle}
        className="flex items-center gap-3 px-6 py-3 bg-white hover:bg-gray-100 text-gray-800 font-medium rounded-xl shadow-lg transition-colors"
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Continue with Google
      </button>
    </div>
  )
}

export default function App() {
  const { user, loading } = useAuth()
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="text-gray-600 text-lg">Loading…</div>
      </div>
    )
  }

  if (!user) return <LoginScreen />

  if (!activeProject) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
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
