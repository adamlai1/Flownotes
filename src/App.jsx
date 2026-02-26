import { useState, useEffect, useCallback, useRef } from 'react'
import { createDefaultProject, DEFAULT_PROJECT_ID } from './data/defaultData'
import { generateId } from './utils/helpers'
import {
  loadProjectList,
  saveProjectList,
  loadProject,
  saveProject,
  deleteProject as deleteProjectFromStorage,
} from './utils/storage'
import TopNav from './components/TopNav'
import Sidebar from './components/Sidebar'
import MainView from './components/MainView'
import CreateNoteModal from './components/CreateNoteModal'
import NoteModal from './components/NoteModal'

function initializeData() {
  let projectList = loadProjectList()
  if (!projectList) {
    const defaultProject = createDefaultProject()
    projectList = [{ id: defaultProject.id, name: defaultProject.name, created_at: defaultProject.created_at }]
    saveProjectList(projectList)
    saveProject(defaultProject)
    return { projectList, activeProject: defaultProject }
  }
  const activeProject = loadProject(projectList[0].id)
  return { projectList, activeProject }
}

export default function App() {
  const [projectList, setProjectList] = useState([])
  const [activeProject, setActiveProject] = useState(null)
  const [selectedBubbleId, setSelectedBubbleId] = useState(null)
  const [viewMode, setViewMode] = useState('bubble') // 'bubble' | 'chronological'
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [createNoteOpen, setCreateNoteOpen] = useState(false)
  const [selectedNote, setSelectedNote] = useState(null)
  const saveTimerRef = useRef(null)

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
    const proj = loadProject(id)
    if (proj) {
      setActiveProject(proj)
      setSelectedBubbleId(null)
      setSelectedNote(null)
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
    // Remove bubble and its descendants, also clean up note bubble_ids
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
      content: noteData.content,
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
    const updated = {
      ...activeProject,
      notes: activeProject.notes.map(n =>
        n.id === noteId ? { ...n, ...changes, updated_at: now } : n
      ),
    }
    updateProject(updated)
    // Keep selectedNote in sync
    if (selectedNote?.id === noteId) {
      setSelectedNote(prev => ({ ...prev, ...changes, updated_at: now }))
    }
  }

  function deleteNote(noteId) {
    // Remove note and any connections referencing it
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
    if (selectedNote?.id === noteId) setSelectedNote(null)
  }

  if (!activeProject) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-gray-400 text-lg">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50">
      <TopNav
        projectList={projectList}
        activeProject={activeProject}
        onSwitchProject={switchProject}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          open={sidebarOpen}
          project={activeProject}
          selectedBubbleId={selectedBubbleId}
          onSelectBubble={(id) => {
            setSelectedBubbleId(id)
          }}
          onAddBubble={addBubble}
          onRenameBubble={renameBubble}
          onDeleteBubble={deleteBubble}
          onClose={() => setSidebarOpen(false)}
        />

        <MainView
          project={activeProject}
          viewMode={viewMode}
          onSetViewMode={setViewMode}
          onSelectNote={setSelectedNote}
          onDeleteNote={deleteNote}
        />
      </div>

      {/* Floating Create Button */}
      <button
        onClick={() => setCreateNoteOpen(true)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl z-40 transition-colors"
        aria-label="Create note"
      >
        +
      </button>

      {createNoteOpen && (
        <CreateNoteModal
          project={activeProject}
          onClose={() => setCreateNoteOpen(false)}
          onCreateNote={createNote}
        />
      )}

      {selectedNote && (
        <NoteModal
          note={selectedNote}
          project={activeProject}
          onClose={() => setSelectedNote(null)}
          onUpdateNote={updateNote}
          onDeleteNote={deleteNote}
        />
      )}
    </div>
  )
}
