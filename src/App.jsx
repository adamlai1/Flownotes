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
  loadAllProjects,
} from './utils/storage'
import {
  loadAllFromCloud,
  syncAllToCloud,
} from './lib/syncService'
import {
  enqueueDelete,
  markProjectDirty,
  clearProjectDirty,
  hasPending,
  flushOutbox,
} from './lib/outbox'
import { TAG_COLORS } from './data/defaultData'

// Ensure default tag colors exist in customTagColors for projects created before they were unified,
// and ensure every tag has a stable id (older projects were stored without tag ids).
function migrateTagColors(project) {
  if (!project) return project
  let result = project
  const existing = project.customTagColors || {}
  const needsColors = Object.keys(TAG_COLORS).some(t => !(t in existing))
  if (needsColors) {
    result = { ...result, customTagColors: { ...TAG_COLORS, ...existing } }
  }
  // Backfill an id for every tag name, and drop ids for tags that no longer exist.
  const colors = result.customTagColors || {}
  const ids = { ...(result.customTagIds || {}) }
  let idsChanged = false
  for (const name of Object.keys(colors)) {
    if (!ids[name]) { ids[name] = generateId(); idsChanged = true }
  }
  for (const name of Object.keys(ids)) {
    if (!(name in colors)) { delete ids[name]; idsChanged = true }
  }
  if (idsChanged) result = { ...result, customTagIds: ids }
  return result
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

// ── One-time "leading newline" bug migration ────────────────────────────────
// The old title/body editor stored a note whose title line was empty as
// "\n<body>", adding a single leading newline. Remove exactly one leading newline
// (only when it's a lone one — never touch "\n\n…", which is intentional spacing).
// Guarded by the localStorage flag below so it runs at most once per device.
const NEWLINE_FLAG = 'newlineBugFixed'

function stripBugNewline(content) {
  const c = content || ''
  return (c.startsWith('\n') && !c.startsWith('\n\n')) ? c.slice(1) : c
}

function migrateProjectsNewline(projects) {
  let changed = false
  const out = projects.map(p => {
    if (!p?.notes?.length) return p
    let pChanged = false
    const notes = p.notes.map(n => {
      const fixed = stripBugNewline(n.content)
      if (fixed !== (n.content || '')) { pChanged = true; return { ...n, content: fixed } }
      return n
    })
    if (!pChanged) return p
    changed = true
    return { ...p, notes }
  })
  return { projects: out, changed }
}

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
  const { signInWithGoogle, continueAsGuest } = useAuth()
  return (
    <div className="flex flex-col items-center justify-center h-dvh bg-[#1C1C1E] gap-6 px-6">
      <div className="text-center mb-2">
        <h1 className="text-4xl font-bold text-white mb-2">FlowNotes</h1>
        <p className="text-gray-400">Your thoughts, connected.</p>
      </div>

      <div className="flex flex-col items-center gap-3 w-full max-w-xs">
        <button
          onClick={signInWithGoogle}
          className="flex items-center justify-center gap-3 w-full px-6 py-3 bg-white hover:bg-gray-100 text-gray-800 font-medium rounded-xl shadow-lg transition-colors"
        >
          <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Sign in with Google
        </button>

        <button
          onClick={continueAsGuest}
          className="text-gray-400 hover:text-gray-200 text-sm py-2 transition-colors"
        >
          Continue as Guest
        </button>
        <p className="text-gray-600 text-xs text-center -mt-1">
          Your notes will only be saved on this device
        </p>
      </div>
    </div>
  )
}

export default function App() {
  const { user, loading, guestMode } = useAuth()
  // 'offline' = we have unsent work and no connection; it's a normal resting state,
  // not a failure, so it reads differently from 'error' in the UI.
  const [syncStatus, setSyncStatus] = useState('idle') // 'idle' | 'syncing' | 'synced' | 'error' | 'offline'
  const syncedUserRef = useRef(null)
  const cloudSaveTimerRef = useRef(null)
  const flushingRef = useRef(false)
  const flushAgainRef = useRef(false)
  const userRef = useRef(user)
  userRef.current = user
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
  // Wrapper around MainView; the swipe-back gesture drives a parallax transform on
  // it imperatively (via this ref) so MainView isn't re-rendered on every frame.
  const beneathWrapRef = useRef(null)

  useEffect(() => {
    const { projectList: pl, activeProject: ap } = initializeData()
    setProjectList(pl)
    setActiveProject(ap)
  }, [])

  // One-time newline-bug migration for guest data. Signed-in users are migrated
  // inside the initial cloud sync (the source of truth for them); we require actual
  // guest mode here so the flag isn't set prematurely while on the login screen.
  useEffect(() => {
    if (loading || user || !guestMode) return
    if (localStorage.getItem(NEWLINE_FLAG)) return
    const list = loadProjectList()
    if (list?.length) {
      const { projects, changed } = migrateProjectsNewline(loadAllProjects(list))
      if (changed) {
        for (const p of projects) saveProject(p)
        setActiveProject(prev => (prev ? migrateTagColors(loadProject(prev.id)) : prev))
      }
    }
    localStorage.setItem(NEWLINE_FLAG, '1')
  }, [loading, user, guestMode])

  const scheduleSave = useCallback((project) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveProject(project)
    }, 400)
  }, [])

  // Drain the offline queue. Serialised: a flush already in flight just sets a flag so
  // one more runs afterwards, so overlapping triggers (online + focus + timer) can't
  // race each other into duplicate uploads.
  const runFlush = useCallback(async () => {
    const uid = userRef.current?.id
    if (!uid) return
    if (!navigator.onLine) {
      setSyncStatus(hasPending(uid) ? 'offline' : 'synced')
      return
    }
    if (flushingRef.current) { flushAgainRef.current = true; return }
    flushingRef.current = true
    setSyncStatus('syncing')
    try {
      await flushOutbox(uid)
      setSyncStatus(hasPending(uid) ? 'error' : 'synced')
    } catch (e) {
      console.error('Sync flush error:', e)
      // A failure while offline is expected — the work stays queued for reconnect.
      setSyncStatus(navigator.onLine ? 'error' : 'offline')
    } finally {
      flushingRef.current = false
      if (flushAgainRef.current) { flushAgainRef.current = false; runFlush() }
    }
  }, [])

  // Record the intent to upload BEFORE attempting it, so a failed (or never-attempted,
  // e.g. tab closed) sync is retried later instead of being lost. The flush re-reads the
  // project's current local state, so this doesn't need to capture `project`.
  function scheduleCloudSync(project) {
    const uid = userRef.current?.id
    if (!uid) return
    markProjectDirty(uid, project.id)
    setSyncStatus(navigator.onLine ? 'syncing' : 'offline')
    if (cloudSaveTimerRef.current) clearTimeout(cloudSaveTimerRef.current)
    cloudSaveTimerRef.current = setTimeout(() => { runFlush() }, 2000)
  }

  // Cancel any queued debounced saves. A pending save was scheduled with the
  // pre-delete project (which still contains the item being removed); if it fired
  // after the cloud delete it would re-upload the deleted item. Cancel it first.
  function cancelPendingSaves() {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (cloudSaveTimerRef.current) { clearTimeout(cloudSaveTimerRef.current); cloudSaveTimerRef.current = null }
  }

  // Commit a deletion, local-first: the UI and localStorage are updated immediately and
  // never wait on the network (previously the local delete sat behind an awaited cloud
  // call, so deleting while offline silently did nothing at all).
  //
  // `op` is a tombstone descriptor for the outbox — see lib/outbox.js. Because the
  // regular sync is upsert-only it can never remove a row, so the tombstone is what
  // actually stops a deleted item reappearing from the cloud later. Marking the project
  // dirty covers the leftover cleanup on surviving items (connections, tags).
  function commitDelete(updatedProject, op) {
    cancelPendingSaves()
    setActiveProject(updatedProject)
    saveProject(updatedProject)
    const uid = userRef.current?.id
    if (!uid) return // Guest mode — localStorage only.
    enqueueDelete(uid, op)
    markProjectDirty(uid, updatedProject.id)
    runFlush()
  }

  // Initial sync: run once per user sign-in, after local data is loaded
  useEffect(() => {
    if (!user) {
      setSyncStatus('idle')
      syncedUserRef.current = null
      return
    }
    if (!projectList.length) return
    if (syncedUserRef.current === user.id) return
    syncedUserRef.current = user.id

    async function doInitialSync() {
      // Offline at startup: keep the local data as-is and don't touch the cloud. Pulling
      // is impossible anyway, and marking this user as synced would skip the real pull
      // once we reconnect — so leave that flag clear.
      if (!navigator.onLine) {
        syncedUserRef.current = null
        setSyncStatus(hasPending(user.id) ? 'offline' : 'idle')
        return
      }
      setSyncStatus('syncing')
      try {
        // Push anything queued from a previous offline session BEFORE pulling. The pull
        // below overwrites local storage with cloud state, so flushing second would
        // discard offline edits and resurrect offline deletes.
        await flushOutbox(user.id)
        const cloudData = await loadAllFromCloud(user.id)
        const needNewlineFix = !localStorage.getItem(NEWLINE_FLAG)
        if (cloudData) {
          // Cloud has data — use it as source of truth. One-time: strip the leading
          // newline bug from cloud notes and push the fixed content back up.
          let projects = cloudData.projects
          if (needNewlineFix) {
            const res = migrateProjectsNewline(projects)
            projects = res.projects
            if (res.changed) await syncAllToCloud(user.id, projects)
            localStorage.setItem(NEWLINE_FLAG, '1')
          }
          saveProjectList(cloudData.projectList)
          for (const p of projects) saveProject(p)
          setProjectList(cloudData.projectList)
          setActiveProject(migrateTagColors(projects[0]))
          setSelectedBubbleId(null)
          setNoteStack([])
          setCurrentBubbleId(null)
        } else {
          // First-time sync — migrate then upload all local data
          let allLocal = loadAllProjects(projectList)
          if (needNewlineFix) {
            allLocal = migrateProjectsNewline(allLocal).projects
            for (const p of allLocal) saveProject(p)
            localStorage.setItem(NEWLINE_FLAG, '1')
          }
          await syncAllToCloud(user.id, allLocal)
        }
        setSyncStatus('synced')
      } catch (e) {
        console.error('Initial sync error:', e)
        // Let a later reconnect retry the whole thing rather than leaving this user
        // permanently marked as synced after a failed first attempt.
        syncedUserRef.current = null
        setSyncStatus(navigator.onLine ? 'error' : 'offline')
      }
    }

    doInitialSync()
  }, [user, projectList])

  // Reconnect / retry triggers. `online` is the main one; visibility covers the common
  // mobile case where the tab was backgrounded while offline and the event never fired,
  // and the slow interval is a backstop for flaky connections that never fire `online`.
  useEffect(() => {
    if (!user) return
    const onOnline = () => runFlush()
    const onOffline = () => setSyncStatus(hasPending(user.id) ? 'offline' : 'synced')
    const onVisible = () => { if (document.visibilityState === 'visible') runFlush() }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(() => { if (hasPending(user.id)) runFlush() }, 30000)
    if (hasPending(user.id)) runFlush() // catch work left over from a previous session
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [user, runFlush])

  function updateProject(updatedProject) {
    setActiveProject(updatedProject)
    scheduleSave(updatedProject)
    scheduleCloudSync(updatedProject)
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
    scheduleCloudSync(newProject)
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
    // Grab the project's notes before removing it from storage so we can delete
    // them (and their connections) from the cloud too.
    const projectToDelete = activeProject?.id === id ? activeProject : loadProject(id)
    // If the active project is being deleted, cancel its queued debounced saves so
    // they can't re-upsert its notes/bubbles after the cloud delete runs.
    if (activeProject?.id === id) cancelPendingSaves()
    const newList = projectList.filter(p => p.id !== id)
    setProjectList(newList)
    saveProjectList(newList)
    deleteProjectFromStorage(id)
    if (activeProject?.id === id) {
      switchProject(newList[0].id)
    }
    if (userRef.current) {
      const noteIds = (projectToDelete?.notes ?? []).map(n => n.id)
      // Drop any queued re-upload of this project first, or the flush would push it
      // back up after the tombstone removed it.
      clearProjectDirty(userRef.current.id, id)
      enqueueDelete(userRef.current.id, { kind: 'project', projectId: id, noteIds })
      runFlush()
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
    commitDelete(updated, { kind: 'bubbles', bubbleIds: [...toRemove] })
  }

  // Move a bubble to a new parent (drag-and-drop reparenting). newParentId === null
  // moves it to the root level. Persists to localStorage and syncs to Supabase via
  // updateProject, and the change is reflected immediately in the bubble view.
  function moveBubble(bubbleId, newParentId) {
    const current = activeProjectRef.current
    const target = current.bubbles.find(b => b.id === bubbleId)
    if (!target) return
    if ((target.parent_id ?? null) === (newParentId ?? null)) return // no-op
    // Guard against cycles: a bubble can't become a child of itself or its own descendants.
    const descendants = new Set()
    ;(function collect(id) {
      descendants.add(id)
      current.bubbles.filter(b => b.parent_id === id).forEach(c => collect(c.id))
    })(bubbleId)
    if (newParentId != null && descendants.has(newParentId)) return
    const updated = {
      ...current,
      bubbles: current.bubbles.map(b =>
        b.id === bubbleId ? { ...b, parent_id: newParentId } : b
      ),
    }
    updateProject(updated)
  }

  // Bulk-create notes (used by the Import flow). Adds them all in one update so it's
  // saved to localStorage and synced to Supabase in a single pass. Returns the count.
  function importNotes(notesData) {
    if (!notesData?.length) return 0
    const now = new Date().toISOString()
    const newNotes = notesData.map(nd => ({
      id: generateId(),
      content: nd.content || '',
      created_at: now,
      updated_at: now,
      bubble_ids: nd.bubble_ids || [],
      tags: [],
      connections: [],
    }))
    const current = activeProjectRef.current
    updateProject({ ...current, notes: [...newNotes, ...current.notes] })
    return newNotes.length
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
    commitDelete(updated, { kind: 'notes', noteIds: [noteId] })
    setNoteStack(prev => prev.filter(id => id !== noteId))
  }

  function updateCustomTagColors(colors) {
    const current = activeProjectRef.current
    // Assign an id to any newly-added tag and drop ids for removed tags, so a tag
    // never reaches the cloud sync without one.
    const ids = { ...(current.customTagIds || {}) }
    for (const name of Object.keys(colors)) {
      if (!ids[name]) ids[name] = generateId()
    }
    for (const name of Object.keys(ids)) {
      if (!(name in colors)) delete ids[name]
    }
    const updated = { ...current, customTagColors: colors, customTagIds: ids }
    updateProject(updated)
  }

  function deleteCustomTag(tagName) {
    const updatedColors = { ...(activeProject.customTagColors || {}) }
    delete updatedColors[tagName]
    const updatedIds = { ...(activeProject.customTagIds || {}) }
    delete updatedIds[tagName]
    const updatedNotes = activeProject.notes.map(n => ({
      ...n,
      tags: n.tags.filter(t => t !== tagName),
    }))
    commitDelete(
      { ...activeProject, customTagColors: updatedColors, customTagIds: updatedIds, notes: updatedNotes },
      { kind: 'tag', tagName },
    )
  }

  function renameCustomTag(oldName, newName) {
    if (!newName || newName === oldName) return
    const existingColors = { ...(activeProject.customTagColors || {}) }
    const color = existingColors[oldName]
    delete existingColors[oldName]
    existingColors[newName] = color
    // The cloud row is keyed by (user_id, name), so a rename is really a new row.
    // Give the new name a fresh id (reusing the old id would collide with the
    // still-present old row's primary key on upsert).
    const existingIds = { ...(activeProject.customTagIds || {}) }
    delete existingIds[oldName]
    existingIds[newName] = generateId()
    const updatedNotes = activeProject.notes.map(n => ({
      ...n,
      tags: n.tags.map(t => t === oldName ? newName : t),
    }))
    updateProject({ ...activeProject, customTagColors: existingColors, customTagIds: existingIds, notes: updatedNotes })
    // Remove the old-name row from the cloud so it doesn't reappear on reload. Queued
    // rather than fired-and-forgotten, so an offline rename still cleans up on reconnect.
    if (userRef.current) {
      enqueueDelete(userRef.current.id, { kind: 'tag', tagName: oldName })
      runFlush()
    }
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

  // Drive the parallax on the view beneath the note editor during a swipe-back.
  // Only applies when a single note is open (MainView is the layer beneath); for
  // note→note the panel beneath is another editor that reveals itself directly.
  // Updated imperatively to avoid re-rendering MainView on every touch move.
  const applyBeneathParallax = useCallback((progress, active) => {
    const el = beneathWrapRef.current
    if (!el || isDesktop || noteStack.length !== 1) return
    if (active) {
      // 1:1 tracking during the drag — no animation.
      el.style.transition = 'none'
      el.style.transform = `translateX(${-(1 - progress) * 0.3 * window.innerWidth}px)`
    } else {
      // Released: animate back to rest IN SYNC with the note panel, using the exact
      // same duration & easing. Force a reflow so iOS Safari registers the current
      // drag position as the animation's start instead of snapping straight to 0
      // (changing transition none→value and transform in one update otherwise jumps).
      el.style.transition = 'none'
      void el.offsetWidth // force reflow
      el.style.transition = 'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
      el.style.transform = 'translateX(0)'
    }
  }, [isDesktop, noteStack.length])

  // When the editor fully closes, make sure the beneath layer is back at rest.
  useEffect(() => {
    if (noteStack.length === 0 && beneathWrapRef.current) {
      beneathWrapRef.current.style.transition = 'none'
      beneathWrapRef.current.style.transform = 'translateX(0)'
    }
  }, [noteStack.length])

  // Create an empty note at current bubble context and open editor
  function handleCreateNote() {
    const bubbleIds = currentBubbleId ? [currentBubbleId] : []
    const note = createNote({ content: '', bubble_ids: bubbleIds, tags: [] })
    setNoteStack([note.id])
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-dvh bg-gray-950">
        <div className="text-gray-600 text-lg">Loading…</div>
      </div>
    )
  }

  if (!user && !guestMode) return <LoginScreen />

  if (!activeProject) {
    return (
      <div className="flex items-center justify-center h-dvh bg-gray-950">
        <div className="text-gray-600 text-lg">Loading…</div>
      </div>
    )
  }

  return (
    <ThemeProvider>
    <div className="flex flex-col h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
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
        syncStatus={syncStatus}
      />

      <div className="relative flex flex-1 min-h-0 overflow-hidden" style={{ background: 'var(--bg)' }}>
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
          onMoveBubble={moveBubble}
          onUpdateCustomTagColors={updateCustomTagColors}
          onDeleteCustomTag={deleteCustomTag}
          onRenameCustomTag={renameCustomTag}
          onClose={() => setSidebarOpen(false)}
        />

        <div
          ref={beneathWrapRef}
          style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', willChange: 'transform' }}
        >
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
      </div>

      {/* Floating Create Button */}
      <button
        onClick={handleCreateNote}
        className="flex fixed right-6 w-14 h-14 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-lg items-center justify-center text-2xl z-40 transition-colors"
        style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
        aria-label="Create note"
      >
        +
      </button>

      {/* Settings panel */}
      <AnimatePresence>
        {settingsOpen && (
          <Settings key="settings" onClose={() => setSettingsOpen(false)} zIndex={45} project={activeProject} onImportNotes={importNotes} />
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
              onSwipeProgress={isTop ? applyBeneathParallax : undefined}
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
