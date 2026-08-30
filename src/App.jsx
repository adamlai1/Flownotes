import { useState, useEffect, useCallback, useRef } from 'react'
import { Capacitor } from '@capacitor/core'
import { AnimatePresence } from 'framer-motion'
import { createDefaultProject, leastUsedBubbleColor, isPristineSeedBubble, isPristineSeedNote } from './data/defaultData'
import { generateId, realBubbleIds, ROOT_BUBBLE_ID } from './utils/helpers'
import {
  loadProjectList,
  saveProjectList,
  loadProject,
  saveProject,
  deleteProject as deleteProjectFromStorage,
  loadAllProjects,
  clearAllProjectData,
  loadLastProjectId,
  saveLastProjectId,
  backfillUserContentStamp,
} from './utils/storage'
import {
  loadAllFromCloud,
  loadNoteTombstones,
  isNoteTombstoned,
  parseTs,
  syncAllToCloud,
  syncProjectToCloud,
  saveNotesToCloud,
  deleteBubblesFromCloud,
  deleteProjectFromCloud,
  deleteAccountOnServer,
} from './lib/syncService'
import {
  SEED_PROJECT_ID,
  SEED_IDEAS_ID,
  SEED_IDEAS_SELF_ID,
  SEED_TODO_ID,
  SEED_JOURNAL_ID,
} from './data/defaultData'
import {
  enqueueDelete,
  markProjectDirty,
  clearProjectDirty,
  hasPending,
  pendingCount,
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
import { noteTitle } from './utils/helpers'
import TopNav from './components/TopNav'
import Sidebar from './components/Sidebar'
import MainView from './components/MainView'
import NoteEditor from './components/NoteEditor'
import Settings from './components/Settings'
import Onboarding from './components/Onboarding'
import CreateBubbleSheet from './components/CreateBubbleSheet'
import CreateButton from './components/CreateButton'
import { ThemeProvider, useTheme } from './contexts/ThemeContext'
import { BUBBLE_BG_VARIANT, vignetteShadowFor } from './components/BubbleVisualization'
import { PreferencesProvider } from './contexts/PreferencesContext'
import { ToastProvider, useToast } from './contexts/ToastContext'
import { LockProvider } from './contexts/LockContext'
import { useAuth } from './contexts/AuthContext'
import { useEscapeShortcut, useKeyShortcuts } from './lib/escapeStack'
import { onShareImport } from './lib/shareImport'

// EXPERIMENT (neutral scheme): the bubble-colour vignette, drawn at the app shell
// so the band spans the FULL screen — safe-area top to bottom — instead of clipping
// at the canvas boundary below the header. Rendered as the app root's first
// positioned child with no z-index: the content wrapper (also positioned) follows
// it in DOM order and paints above, so every item, header control and breadcrumb
// sits over the band, exactly as they did over the old canvas-level layer.
// currentBubbleId is only ever a level the user has opened, so a locked bubble's
// colour cannot leak into the header zone. Geometry/strength live with their dials
// in BubbleVisualization (vignetteShadowFor).
function AppVignette({ bubble }) {
  const { theme } = useTheme()
  if (!bubble || BUBBLE_BG_VARIANT !== 'vignette') return null
  return (
    <div
      aria-hidden
      // fixed, not absolute: resolves against the viewport itself — safe-area top
      // to bottom, edge to edge — independent of any ancestor's bounds.
      className="fixed inset-0 pointer-events-none"
      style={{
        boxShadow: vignetteShadowFor(bubble.color, theme === 'light'),
        transition: 'box-shadow 0.6s ease-in-out',
      }}
    />
  )
}

// How long the + button has to be held before it creates a bubble instead of a note.
// Deliberately the same figure as the bubble view's LONG_PRESS_MENU_MS: the app has one
// hold gesture, and it should take the same hold everywhere it appears.
const LONG_PRESS_MS = 750

// ── One-time "leading newline" bug migration ────────────────────────────────
// The old title/body editor stored a note whose title line was empty as
// "\n<body>", adding a single leading newline. Remove exactly one leading newline
// (only when it's a lone one — never touch "\n\n…", which is intentional spacing).
// Guarded by the localStorage flag below so it runs at most once per device.
const NEWLINE_FLAG = 'newlineBugFixed'

// ── Local-data ownership ────────────────────────────────────────────────────
// Which account the data in localStorage belongs to. Written once a sign-in's
// initial sync completes and on every cloud load; absent for guest-created
// data, which has no owner.
//
// The interactive sign-out (handleSignOut) clears local data outright, so on
// that path this stamp never survives to matter. It exists for the sign-outs
// that DON'T run that flow: an expired or revoked session just drops the user
// on the login screen with the account's snapshot still in localStorage, and
// this stamp is what stops a different account's sign-in from mistaking that
// snapshot for guest data — no merge offer, no upload, just that account's own
// cloud (see the different-account branch in doInitialSync).
//
// The stamp describes the DATA, not the device: the moment a signed-out
// session writes anything (see disownLocalDataIfGuest), the store is no longer
// purely that snapshot, so the stamp is cleared and the store reverts to
// unowned guest data — the next sign-in must offer the merge dialog rather
// than silently discard it.
const DATA_OWNER_KEY = 'mindmap-data-owner'

// ── "Keep separate" import progress ─────────────────────────────────────────
// Which SOURCE (device) projects have already landed in which account, so a
// retry after a partial "Keep separate" failure resumes where it stopped
// instead of re-importing what already arrived — which would duplicate it
// under the next name suffix. Keyed by user id because progress toward one
// account must never skip imports into another, and cleared whenever a
// sign-in resolves (any choice) or the device is cleared: after that, a
// source id could belong to different data than the record remembers.
const IMPORT_PROGRESS_KEY = 'mindmap-import-progress'

function readImportProgress(userId) {
  try {
    const raw = JSON.parse(localStorage.getItem(IMPORT_PROGRESS_KEY))
    return raw?.userId === userId && Array.isArray(raw.done) ? new Set(raw.done) : new Set()
  } catch {
    return new Set()
  }
}

function markImportDone(userId, sourceProjectId) {
  const done = [...readImportProgress(userId), sourceProjectId]
  try { localStorage.setItem(IMPORT_PROGRESS_KEY, JSON.stringify({ userId, done })) } catch {}
}

function clearImportProgress() {
  localStorage.removeItem(IMPORT_PROGRESS_KEY)
}

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

// ── Guest ⇄ cloud reconciliation ────────────────────────────────────────────

function countNotes(projects) {
  return projects.reduce((sum, p) => sum + (p?.notes?.length ?? 0), 0)
}

function countBubbles(projects) {
  return projects.reduce((sum, p) => sum + (p?.bubbles?.length ?? 0), 0)
}

// ── One-time legacy seed-id migration ───────────────────────────────────────
// Installs prior to the fixed seed ids (see defaultData.js) generated random
// ids for the seeded project and its four starter bubbles, so identical seed
// items carry a different id on every install. Remap those legacy ids to the
// canonical constants — scoped strictly to the seeded shape: the three root
// bubbles by their seed names, "Self" only when its parent resolves to the
// canonical Ideas id, and the seeded project by its seed name. Idempotent: a
// canonical id never tests as legacy, so once remapped this is a no-op, and it
// creates nothing — a deleted seed item stays deleted.

const SEED_ROOT_BUBBLES = {
  'Ideas': SEED_IDEAS_ID,
  'To Do': SEED_TODO_ID,
  'Journal': SEED_JOURNAL_ID,
}
// Every name the seed project has EVER shipped with. The name gate in
// migrateSeedIds below (twin-fold residue detection and legacy-id adoption
// alike) matches against all of them, so renaming the default can never make
// an older install's seed project stop folding. SAME RULE as SEED_NOTE_TEXTS:
// when the default project name changes, append the new name here — never
// remove an entry. Existing users' projects are never renamed; only
// createDefaultProject uses the current name, and only for new data.
const SEED_PROJECT_NAME = 'Personal Notes'
const SEED_PROJECT_NAMES = [SEED_PROJECT_NAME, 'My Notes']

// generateId() output only — never 'seed:*', never the '__root__' sentinel.
const isLegacyId = id => typeof id === 'string' && /^[0-9a-z]+$/.test(id)

// Legacy seed furniture in a bubble list: the root bubbles with the seed
// names (and "Self" under the Ideas that resolves canonically), mapped to
// their fixed ids. Besides driving the remap, this doubles as the residue
// test in migrateSeedIds: only a project born from a seed carries this
// furniture — a project the user created starts empty — so a legacy twin is
// distinguishable from a genuine user project that merely shares the name.
function seedBubbleMap(bubbles) {
  const present = new Set(bubbles.map(b => b.id))
  const idMap = new Map() // legacy bubble id → canonical seed id
  for (const [name, canonical] of Object.entries(SEED_ROOT_BUBBLES)) {
    if (present.has(canonical)) continue
    const legacy = bubbles.find(b =>
      (b.parent_id ?? null) === null && b.name === name && isLegacyId(b.id))
    if (legacy) idMap.set(legacy.id, canonical)
  }
  if (!present.has(SEED_IDEAS_SELF_ID)) {
    const self = bubbles.find(b => b.name === 'Self' && isLegacyId(b.id) &&
      (idMap.get(b.parent_id) ?? b.parent_id) === SEED_IDEAS_ID)
    if (self) idMap.set(self.id, SEED_IDEAS_SELF_ID)
  }
  return idMap
}

// Pure: returns { projects, changed, oldBubbleIds, projectIdMap } and never
// touches storage. oldBubbleIds / projectIdMap tell the caller which stale
// cloud rows to delete — the upsert sync can never remove them itself.
function migrateSeedIds(projects) {
  let changed = false
  const oldBubbleIds = []
  const projectIdMap = new Map() // legacy project id → SEED_PROJECT_ID

  // Project mapping. A canonical row already existing does NOT mean the
  // migration is done: the cloud half is a two-phase move (upsert under new
  // ids, then purge the old rows), so an interruption strands a twin — and,
  // common since sign-out started clearing devices, a fresh install seeds
  // seed:project directly with its own created_at, so a later sign-in plants
  // a canonical row no timestamp can tie back to the twins. Residue is
  // recognized by BIRTH STRUCTURE instead: a legacy-id project with the seed
  // name folds only when it still carries legacy seed furniture (see
  // seedBubbleMap) — every seed project of any era was born with it, while a
  // project the user created under the same name is born empty and never
  // maps. However many such twins exist, they all fold. When no canonical
  // project exists at all, the first legacy-named project still maps without
  // the furniture check — the original adoption rule, unchanged.
  const canonicalExists = projects.some(p => p.id === SEED_PROJECT_ID)
  for (const p of projects) {
    if (p.id === SEED_PROJECT_ID || !SEED_PROJECT_NAMES.includes(p.name) || !isLegacyId(p.id)) continue
    const firstWithoutCanonical = !canonicalExists && projectIdMap.size === 0
    if (firstWithoutCanonical || seedBubbleMap(p.bubbles ?? []).size > 0) {
      projectIdMap.set(p.id, SEED_PROJECT_ID)
    }
  }

  const out = projects.map(project => {
    let p = project
    if (projectIdMap.has(p.id)) {
      changed = true
      p = { ...p, id: projectIdMap.get(p.id) }
    }

    const bubbles = p.bubbles ?? []
    const idMap = seedBubbleMap(bubbles)
    if (!idMap.size) return p

    changed = true
    oldBubbleIds.push(...idMap.keys())
    return {
      ...p,
      bubbles: bubbles.map(b => {
        const id = idMap.get(b.id) ?? b.id
        const parent = idMap.get(b.parent_id) ?? b.parent_id
        return (id === b.id && parent === b.parent_id) ? b : { ...b, id, parent_id: parent }
      }),
      notes: (p.notes ?? []).map(n => {
        const mapped = (n.bubble_ids ?? []).map(bid => idMap.get(bid) ?? bid)
        const same = mapped.every((v, i) => v === n.bubble_ids[i])
        return same ? n : { ...n, bubble_ids: mapped }
      }),
    }
  })

  // Fold projects that now share an id — the remapped residue twin lands on
  // the canonical project's id and merges into it here: bubbles union by id
  // with the first (canonical) copy winning, notes concatenate deduped by id,
  // tags union. Dropping the twin from the output is what finally lets the
  // caller's purge delete its rows.
  const byId = new Map()
  for (const p of out) {
    const prev = byId.get(p.id)
    if (!prev) { byId.set(p.id, p); continue }
    changed = true
    const bubbles = new Map()
    for (const b of prev.bubbles ?? []) bubbles.set(b.id, b)
    for (const b of p.bubbles ?? []) if (!bubbles.has(b.id)) bubbles.set(b.id, b)
    const notes = new Map()
    for (const n of prev.notes ?? []) notes.set(n.id, n)
    for (const n of p.notes ?? []) if (!notes.has(n.id)) notes.set(n.id, n)
    byId.set(p.id, {
      ...prev,
      bubbles: [...bubbles.values()],
      notes: [...notes.values()],
      customTagColors: { ...(p.customTagColors ?? {}), ...(prev.customTagColors ?? {}) },
      customTagIds: { ...(p.customTagIds ?? {}), ...(prev.customTagIds ?? {}) },
    })
  }

  return { projects: [...byId.values()], changed, oldBubbleIds, projectIdMap }
}

// Union of the data on this device and the account's cloud data — nothing from
// either side is dropped. Notes and bubbles match on id (ids are client-made
// and survive the Supabase round trip unchanged), and a collision keeps the
// newer updated_at with local winning exact ties. Bubbles carry no timestamps
// today, so their collisions degrade to local-wins; the comparison is written
// against the real rule so it starts working the day they get one.
function mergeGuestAndCloud(localProjects, cloudProjects) {
  const ts = n => Date.parse(n?.updated_at ?? n?.created_at ?? '') || 0

  // Winning copy of every note across both sides, remembering which project it
  // was in. Local runs second with >= so it wins exact-timestamp ties. The
  // note→bubble memberships (bubble_ids, many-to-many) are collected from BOTH
  // sides regardless of which note object wins, and unioned back on below.
  const noteWinners = new Map() // note id → { note, projectId }
  const noteBubbleIds = new Map() // note id → Set of bubble ids from either side
  for (const projects of [cloudProjects, localProjects]) {
    for (const p of projects) {
      for (const n of p.notes ?? []) {
        const prev = noteWinners.get(n.id)
        if (!prev || ts(n) >= ts(prev.note)) noteWinners.set(n.id, { note: n, projectId: p.id })
        let ids = noteBubbleIds.get(n.id)
        if (!ids) noteBubbleIds.set(n.id, ids = new Set())
        for (const bid of n.bubble_ids ?? []) ids.add(bid)
      }
    }
  }

  // Projects: cloud order first, local-only ones appended — a guest-only
  // project survives whole. A collision keeps the local fields but the union
  // of both sides' bubbles and tags.
  const projectsById = new Map()
  for (const p of cloudProjects) projectsById.set(p.id, { ...p })
  for (const p of localProjects) {
    const cloud = projectsById.get(p.id)
    if (!cloud) { projectsById.set(p.id, { ...p }); continue }
    // Bubbles union by id, same rule as notes — a guest-only bubble survives,
    // and with it the parent_id link that keeps its subtree attached.
    const bubbles = new Map()
    for (const b of cloud.bubbles ?? []) bubbles.set(b.id, b)
    for (const b of p.bubbles ?? []) {
      const prev = bubbles.get(b.id)
      if (!prev || ts(b) >= ts(prev)) bubbles.set(b.id, b)
    }
    projectsById.set(p.id, {
      ...cloud,
      ...p,
      bubbles: [...bubbles.values()],
      customTagColors: { ...(cloud.customTagColors ?? {}), ...(p.customTagColors ?? {}) },
      customTagIds: { ...(cloud.customTagIds ?? {}), ...(p.customTagIds ?? {}) },
    })
  }

  // The bubble tree renders by following parent_id chains, so a bubble whose
  // parent survived on neither side would take its whole subtree invisible.
  // Promote such bubbles to the root of their project instead.
  for (const p of projectsById.values()) {
    const ids = new Set((p.bubbles ?? []).map(b => b.id))
    p.bubbles = (p.bubbles ?? []).map(b =>
      b.parent_id != null && !ids.has(b.parent_id) ? { ...b, parent_id: null } : b
    )
  }

  // Re-deal the winning notes into their winning project; the first project
  // catches any orphan whose project didn't survive on either side. Each note
  // keeps the winner's bubble order with the other side's memberships appended.
  const firstId = projectsById.keys().next().value
  const notesByProject = new Map()
  for (const { note, projectId } of noteWinners.values()) {
    const pid = projectsById.has(projectId) ? projectId : firstId
    const bubbleIds = [...(note.bubble_ids ?? [])]
    for (const bid of noteBubbleIds.get(note.id) ?? []) {
      if (!bubbleIds.includes(bid)) bubbleIds.push(bid)
    }
    const outNote = bubbleIds.length === (note.bubble_ids?.length ?? 0)
      ? note
      : { ...note, bubble_ids: bubbleIds }
    if (!notesByProject.has(pid)) notesByProject.set(pid, [])
    notesByProject.get(pid).push(outNote)
  }

  return [...projectsById.values()].map(p => ({ ...p, notes: notesByProject.get(p.id) ?? [] }))
}

// The merge dialog's "Keep separate" choice: rebuild the device's projects as
// brand-new projects for the account. Every project, bubble, and note gets a
// fresh id, so nothing can collide with — or silently fold into — the
// account's existing rows; the guest's seed bubbles get ordinary generated ids
// for the same reason (reusing the canonical seed:* ids would merge them into
// the account's own seed bubbles). One id map spans all projects so a
// connection between notes in different projects survives the rewrite. Names
// take a numeric suffix on the project's real name ("Personal Notes 2"),
// incremented past every name the account already uses. Custom tags are
// account-global (upserted by name), so only tag names the account does NOT
// already have come across — an existing tag's color is never overwritten —
// and their ids are dropped so the upload generates fresh ones. Pure: storage
// and cloud writes are the caller's job.
function buildSeparateImport(localProjects, cloudProjects, cloudList) {
  const takenNames = new Set(cloudList.map(p => p.name))
  const accountTagNames = new Set(Object.keys(cloudProjects[0]?.customTagColors ?? {}))

  const idMap = new Map()
  for (const p of localProjects) {
    for (const b of p.bubbles ?? []) idMap.set(b.id, generateId())
    for (const n of p.notes ?? []) idMap.set(n.id, generateId())
  }

  return localProjects.map(p => {
    let n = 2
    let name = `${p.name} ${n}`
    while (takenNames.has(name)) { n++; name = `${p.name} ${n}` }
    takenNames.add(name)

    const guestTags = Object.entries(p.customTagColors ?? {})
      .filter(([tagName]) => !accountTagNames.has(tagName))

    return {
      id: generateId(),
      name,
      created_at: p.created_at ?? new Date().toISOString(),
      bubbles: (p.bubbles ?? []).map(b => ({
        ...b,
        id: idMap.get(b.id),
        // A parent that somehow isn't in this import can't be reached under any
        // id — promote to root rather than leak the old id into the account.
        parent_id: b.parent_id != null ? (idMap.get(b.parent_id) ?? null) : null,
      })),
      notes: (p.notes ?? []).map(note => ({
        ...note,
        id: idMap.get(note.id),
        // The '__root__' canvas-pin sentinel is not a bubble id: it survives
        // the rewrite as-is rather than being mapped (and dropped).
        bubble_ids: (note.bubble_ids ?? [])
          .map(bid => (bid === ROOT_BUBBLE_ID ? bid : idMap.get(bid)))
          .filter(Boolean),
        connections: (note.connections ?? [])
          .filter(c => idMap.has(c.note_id))
          // Fresh connection id too — same all-new-ids rule as everything
          // else in the import; the relationship label rides along via the
          // spread whichever field name it uses.
          .map(c => ({ ...c, id: generateId(), note_id: idMap.get(c.note_id) })),
      })),
      customTagColors: guestTags.length ? Object.fromEntries(guestTags) : undefined,
      customTagIds: undefined,
    }
  })
}

// One-time adoption of cloud notes that have no stored project (NULL
// project_id and no surviving bubble membership — see loadAllFromCloud).
// They join the project with the OLDEST created_at in the account:
// deterministic, repeatable, and independent of UI state, so the same orphan
// always lands in the same project no matter what was open — anything
// context-dependent here would reintroduce exactly the guessing project_id
// exists to remove. Ties (equal or missing timestamps) break by id so the
// pick is still deterministic. This replaces the old silent sort-order
// fallback with an explicit assignment that the caller then PERSISTS
// (directly or via its normal upload), so it happens once and sticks.
// Pure apart from the adoption log; returns the adjusted projects plus what
// to persist.
function attachUnassignedNotes(cloudData) {
  const unassigned = cloudData.unassignedNotes ?? []
  if (!unassigned.length) return { projects: cloudData.projects, targetId: null, unassigned }
  const oldest = [...cloudData.projectList].sort((a, b) => {
    const ta = Date.parse(a.created_at ?? '') || 0
    const tb = Date.parse(b.created_at ?? '') || 0
    return (ta - tb) || String(a.id).localeCompare(String(b.id))
  })[0]
  if (!oldest) return { projects: cloudData.projects, targetId: null, unassigned }
  console.log(
    `[adopt] ${unassigned.length} unassigned note(s) adopted into oldest project "${oldest.name}" (${oldest.id})`,
  )
  return {
    projects: cloudData.projects.map(p =>
      p.id === oldest.id ? { ...p, notes: [...(p.notes ?? []), ...unassigned] } : p),
    targetId: oldest.id,
    unassigned,
  }
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
  // Legacy seed ids → canonical constants, once. The old project file is
  // removed after the remapped copy is saved so nothing is orphaned.
  const seedFix = migrateSeedIds(loadAllProjects(projectList))
  if (seedFix.changed) {
    for (const p of seedFix.projects) saveProject(p)
    for (const oldId of seedFix.projectIdMap.keys()) deleteProjectFromStorage(oldId)
    projectList = projectList.map(e =>
      seedFix.projectIdMap.has(e.id) ? { ...e, id: seedFix.projectIdMap.get(e.id) } : e)
      .filter((e, i, a) => a.findIndex(x => x.id === e.id) === i) // folded twin
    saveProjectList(projectList)
  }
  // Data already on the device may predate the splash-gate stamp — derive it
  // here so pre-stamp guests with real work stop seeing the splash. After the
  // seedFix saves above, so it reads the migrated shapes.
  backfillUserContentStamp()
  // Open to the last project the user had open on THIS device. A stale id
  // (project deleted, or a legacy seed id remapped above) falls back to the
  // list head — the pre-restore default.
  let lastId = loadLastProjectId()
  if (seedFix.changed && seedFix.projectIdMap.has(lastId)) {
    lastId = seedFix.projectIdMap.get(lastId)
  }
  const restored = lastId && projectList.some(e => e.id === lastId)
    ? loadProject(lastId)
    : null
  const activeProject = migrateTagColors(restored ?? loadProject(projectList[0].id))
  return { projectList, activeProject }
}

function LoginScreen() {
  const { signInWithGoogle, signInWithApple, signInWithEmail, continueAsGuest } = useAuth()
  const [showEmail, setShowEmail] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleEmailSignIn(e) {
    e.preventDefault()
    if (submitting) return
    setEmailError(null)
    setSubmitting(true)
    try {
      const { error } = await signInWithEmail(email.trim(), password)
      if (error) setEmailError(error.message)
      // On success onAuthStateChange sets the user and this screen unmounts.
    } catch (err) {
      setEmailError(err?.message || 'Sign in failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-dvh bg-[#1C1C1E] gap-6 px-6">
      <div className="text-center mb-2">
        <h1 className="text-4xl font-bold text-white mb-2">Nubble</h1>
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

        {/* White variant per Apple's design guidelines — the screen background is dark */}
        <button
          onClick={signInWithApple}
          className="flex items-center justify-center gap-3 w-full px-6 py-3 bg-white hover:bg-gray-100 text-black font-medium rounded-xl shadow-lg transition-colors"
        >
          <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 384 512" fill="currentColor" aria-hidden="true">
            <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
          </svg>
          Sign in with Apple
        </button>

        {!showEmail ? (
          <button
            onClick={() => setShowEmail(true)}
            className="text-gray-400 hover:text-gray-200 text-sm py-1 transition-colors"
          >
            Sign in with email
          </button>
        ) : (
          <form onSubmit={handleEmailSignIn} className="flex flex-col gap-2 w-full">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              required
              autoFocus
              className="w-full px-4 py-2.5 rounded-xl bg-white/10 text-white placeholder-gray-500 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              required
              className="w-full px-4 py-2.5 rounded-xl bg-white/10 text-white placeholder-gray-500 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none"
            />
            {emailError && (
              <p className="text-red-400 text-xs text-center">{emailError}</p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {submitting ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        )}

        <button
          onClick={continueAsGuest}
          className="text-gray-400 hover:text-gray-200 text-sm py-2 transition-colors"
        >
          Continue as Guest
        </button>
        <p className="text-gray-600 text-xs text-center -mt-1">
          Your notes will only be saved on this device
        </p>

        {/* Official Apple badge asset, used verbatim (public/app-store-badge.svg).
            Never rendered inside the Capacitor shell: Apple rejects apps that
            link out to the App Store from within themselves. */}
        {!Capacitor.isNativePlatform() && (
          <a
            href="https://nubblenotes.com/ios"
            target="_blank"
            rel="noopener"
            className="mt-4 active:opacity-70 transition-opacity"
          >
            <img src="/app-store-badge.svg" alt="Download on the App Store" style={{ height: 40 }} />
          </a>
        )}
      </div>
    </div>
  )
}

// Blocking four-way chooser shown when a sign-in finds notes both on this device
// and in the account. Deliberately NOT dismissable — no backdrop tap, no escape
// layer, no default action — because every way out is a real decision about
// someone's notes. Resolved only through onChoose.
function GuestMergeDialog({ localCount, localBubbleCount, cloudCount, onChoose }) {
  // "3 notes and 2 bubbles", with a zero count omitted rather than shown.
  const parts = []
  if (localCount > 0) parts.push(`${localCount} ${localCount === 1 ? 'note' : 'notes'}`)
  if (localBubbleCount > 0) parts.push(`${localBubbleCount} ${localBubbleCount === 1 ? 'bubble' : 'bubbles'}`)
  const localDesc = parts.join(' and ')
  const cloudNoun = cloudCount === 1 ? 'note' : 'notes'
  return (
    <div
      data-modal
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 80, background: 'rgba(0,0,0,0.6)' }}
    >
      <div
        className="mx-6 w-full max-w-xs rounded-2xl p-6"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-white font-semibold text-lg text-center mb-1">
          Notes on this device
        </h2>
        <p className="text-gray-400 text-sm text-center mb-5">
          This device has {localDesc} not in your account; your account has {cloudCount} cloud {cloudNoun}. Choose what to keep.
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onChoose('merge')}
            className="w-full py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Merge together
            <span className="block text-xs font-normal opacity-75">
              Combine into your account&rsquo;s projects
            </span>
          </button>
          <button
            onClick={() => onChoose('separate')}
            className="w-full py-2.5 rounded-xl text-sm font-medium border border-blue-500 text-blue-400 hover:bg-blue-500/10 transition-colors"
          >
            Keep separate
            <span className="block text-xs font-normal opacity-75">
              Import device notes as a new project
            </span>
          </button>
          <button
            onClick={() => onChoose('cloud')}
            className="w-full py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            Discard {localDesc}
          </button>
          <button
            onClick={() => onChoose('cancel')}
            className="w-full py-2.5 rounded-xl text-sm font-medium transition-colors"
            style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
          >
            Stay signed out
          </button>
        </div>
      </div>
    </div>
  )
}

// Blocking chooser shown when sign-out couldn't flush unsynced changes (offline
// or a sync error). Same rule as GuestMergeDialog: not dismissable except through
// its buttons, because both ways out are a real decision about unsynced notes.
function SignOutWarningDialog({ pending, onChoose }) {
  const noun = pending === 1 ? 'change' : 'changes'
  return (
    <div
      data-modal
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 80, background: 'rgba(0,0,0,0.6)' }}
    >
      <div
        className="mx-6 w-full max-w-xs rounded-2xl p-6"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-white font-semibold text-lg text-center mb-1">
          Unsynced changes
        </h2>
        <p className="text-gray-400 text-sm text-center mb-5">
          {pending} {noun} on this device {pending === 1 ? 'has' : 'have'} not been uploaded to your account.
          Signing out clears this device, so {pending === 1 ? 'it' : 'they'} would be permanently lost.
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onChoose(false)}
            className="w-full py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Stay signed in
          </button>
          <button
            onClick={() => onChoose(true)}
            className="w-full py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            Sign out and lose {pending === 1 ? 'it' : 'them'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Blocking confirmation for account deletion. Same rule as the other blocking
// dialogs — no backdrop dismiss, no escape, no default action — and the
// destructive button additionally stays disabled until the user types DELETE,
// so no single tap can ever destroy an account. Apple 5.1.1(v) requires this
// flow to exist in-app.
function DeleteAccountDialog({ busy, onChoose }) {
  const [text, setText] = useState('')
  const armed = text.trim().toUpperCase() === 'DELETE'
  return (
    <div
      data-modal
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 80, background: 'rgba(0,0,0,0.6)' }}
    >
      <div
        className="mx-6 w-full max-w-xs rounded-2xl p-6"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-white font-semibold text-lg text-center mb-1">
          Delete account?
        </h2>
        <p className="text-gray-400 text-sm text-center mb-4">
          This permanently deletes your account and all notes, bubbles, and
          connections. It cannot be undone.
        </p>
        <p className="text-gray-400 text-xs text-center mb-2">
          Type DELETE to confirm.
        </p>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          disabled={busy}
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="w-full mb-4 px-3 py-2 rounded-xl text-sm text-center text-white outline-none"
          style={{ background: 'var(--hover)', border: '1px solid var(--border)' }}
        />
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onChoose(false)}
            disabled={busy}
            className="w-full py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
          >
            Cancel
          </button>
          <button
            onClick={() => onChoose(true)}
            disabled={!armed || busy}
            className="w-full py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-40 disabled:hover:bg-red-600"
          >
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>
      </div>
    </div>
  )
}

// App itself sits above ToastProvider, so it can't call useToast — this bridge
// renders just inside the provider and hands showToast up through a ref.
function ToastBridge({ toastRef }) {
  toastRef.current = useToast()
  return null
}

export default function App() {
  const { user, loading, guestMode, signOut, continueAsGuest } = useAuth()
  // Single keydown listener for the whole app — Escape (layers register themselves) and
  // the bare-key shortcuts wired up further down.
  useEscapeShortcut()
  // 'offline' = we have unsent work and no connection; it's a normal resting state,
  // not a failure, so it reads differently from 'error' in the UI.
  const [syncStatus, setSyncStatus] = useState('idle') // 'idle' | 'syncing' | 'synced' | 'error' | 'offline'
  const syncedUserRef = useRef(null)
  // Guest ⇄ cloud conflict prompt (see the initial-sync effect). Non-null while
  // the blocking dialog is up; the ref holds the resolver of the promise the
  // sync effect is awaiting.
  const [mergePrompt, setMergePrompt] = useState(null) // { local, cloud }
  const mergeChoiceRef = useRef(null)
  // Unsynced-changes warning raised by sign-out; the ref holds the resolver of
  // the promise handleSignOut is awaiting. Same shape as the merge prompt.
  const [signOutWarning, setSignOutWarning] = useState(null) // null | { pending }
  const signOutChoiceRef = useRef(null)
  const toastRef = useRef(null) // showToast, bridged up from inside ToastProvider
  // Account-deletion confirmation dialog; busy while the edge function call
  // is in flight (both dialog buttons disable).
  const [deleteAccountPrompt, setDeleteAccountPrompt] = useState(false)
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false)
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
  // The header's row-1 slot the canvas portals its view controls into (layout
  // mode / select / view toggle). A state, not a ref, so the canvas re-renders
  // and mounts the portal once the slot element exists.
  const [headerControlsEl, setHeaderControlsEl] = useState(null)
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
  // Text handed over by the iOS Share Extension. The id makes each share a
  // distinct command even when the same text is shared twice, without any UUID
  // machinery — it only needs to be unique within this app run.
  const [shareImport, setShareImport] = useState(null) // { text, id } | null
  const shareImportSeq = useRef(0)
  useEffect(() => onShareImport(text => {
    shareImportSeq.current += 1
    setShareImport({ text, id: shareImportSeq.current })
    // Import lives inside Settings, so the share always lands there — Settings
    // opens (or stays open) and mounts ImportNotes prefilled.
    setSettingsOpen(true)
  }), [])
  const [showOnboarding, setShowOnboarding] = useState(() =>
    !localStorage.getItem('hasSeenOnboarding')
  )
  // Hold the + button → create a bubble instead of a note. See the button below.
  const [createBubbleOpen, setCreateBubbleOpen] = useState(false)
  const [sheetFocusNonce, setSheetFocusNonce] = useState(0)
  const [plusHeld, setPlusHeld] = useState(false)
  const [plusExpanded, setPlusExpanded] = useState(false)
  const holdTimerRef = useRef(null)
  const heldFiredRef = useRef(false)
  // Id of a bubble just created here, handed to the bubble view to place on the page
  // the user is looking at. Command prop, like navigateBubbleId.
  const [placeBubbleId, setPlaceBubbleId] = useState(null)
  // Keyboard-shortcut command props, both carrying a nonce so the same request twice in
  // a row still reads as two — the same shape as sheetFocusNonce.
  const [searchFocusNonce, setSearchFocusNonce] = useState(0)
  const [pageStep, setPageStep] = useState(null) // { dir: -1 | 1, nonce }
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

  // Whatever project is on screen is the one the next launch restores — this
  // single watcher covers every way the project can change (manual switch,
  // create, delete-fallback, merge/import landing) without each site opting in.
  // Keyed on the id so per-edit object churn doesn't rewrite storage.
  useEffect(() => {
    if (activeProject?.id) saveLastProjectId(activeProject.id)
  }, [activeProject?.id])

  // ── True viewport height ──────────────────────────────────────────────────────
  //
  // The app column is sized by --app-h, set here from window.innerHeight — not by a CSS
  // viewport unit. In the installed PWA the column sized with 100dvh ended a safe-area
  // inset short of the real viewport (the red-shell test showed html/body through a
  // ~34px strip at the bottom that no app element ever covered), while innerHeight
  // consistently reported the true bottom. So the truth the probe measures is the truth
  // the layout uses.
  //
  // Which height governs what, deliberately:
  //   PAINT    — this height. The app column, and the canvas filling it, must cover to
  //              the real viewport bottom; the canvas gradient resolves to the shell
  //              colour before the bottom edge, so coverage is what makes the seam
  //              invisible.
  //   MOVEMENT — the canvas-measured size.height (+ safeBottom) in BubbleVisualization.
  //              Item bounds derive from the canvas's own box, so they follow this fix
  //              automatically; if items should someday rest above the home indicator
  //              again, that belongs in bottomEdgeLimit, not here.
  //
  // innerHeight (the layout viewport) does not shrink for the iOS keyboard — only the
  // visual viewport does — so listening to visualViewport is safe: re-reading
  // innerHeight there is a no-op mid-edit and catches the standalone relaunch/rotation
  // moments where dvh goes stale.
  useEffect(() => {
    const setH = () =>
      document.documentElement.style.setProperty('--app-h', `${window.innerHeight}px`)
    setH()
    window.addEventListener('resize', setH)
    window.addEventListener('orientationchange', setH)
    window.visualViewport?.addEventListener('resize', setH)
    return () => {
      window.removeEventListener('resize', setH)
      window.removeEventListener('orientationchange', setH)
      window.visualViewport?.removeEventListener('resize', setH)
    }
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
  function commitDelete(updatedProject, ops) {
    disownLocalDataIfGuest()
    cancelPendingSaves()
    setActiveProject(updatedProject)
    saveProject(updatedProject)
    const uid = userRef.current?.id
    if (!uid) return // Guest mode — localStorage only.
    for (const op of Array.isArray(ops) ? ops : [ops]) enqueueDelete(uid, op)
    markProjectDirty(uid, updatedProject.id)
    runFlush()
  }

  // Initial sync: run once per user sign-in, after local data is loaded
  useEffect(() => {
    if (!user) {
      setSyncStatus('idle')
      syncedUserRef.current = null
      // A prompt can't outlive the sign-in that raised it.
      setMergePrompt(null)
      mergeChoiceRef.current = null
      return
    }
    if (!projectList.length) return
    if (syncedUserRef.current === user.id) return
    syncedUserRef.current = user.id

    // Resolves with 'merge' | 'separate' | 'cloud' | 'cancel' once the user
    // picks a button.
    function askMergeChoice(counts) {
      return new Promise(resolve => {
        mergeChoiceRef.current = resolve
        setMergePrompt(counts)
      })
    }

    // After a seed-id remap of cloud data has been uploaded under the new ids,
    // the stale rows must go explicitly — the upsert sync can never remove them.
    // Delete AFTER the upload so a failure in between loses nothing: the next
    // sign-in just remaps again.
    async function purgeLegacySeedRows(seedFix) {
      if (!seedFix.changed) return
      if (seedFix.oldBubbleIds.length) {
        await deleteBubblesFromCloud(user.id, seedFix.oldBubbleIds)
      }
      for (const oldId of seedFix.projectIdMap.keys()) {
        await deleteProjectFromCloud(user.id, oldId, [])
      }
    }

    // Cloud has data — use it as source of truth. One-time fixes on the way in:
    // remap legacy seed ids (then push the fix up and purge the stale rows) and
    // strip the leading-newline bug from cloud notes.
    async function applyCloudData(cloudData, needNewlineFix) {
      const adoption = attachUnassignedNotes(cloudData)
      let projects = adoption.projects
      let cloudList = cloudData.projectList
      // Persist the adoption immediately — otherwise the NULL rows would be
      // re-adopted into whatever happens to be viewed on every future load.
      // If the target is a residue twin the seed migration below folds, the
      // migration's own upload rewrites project_id to the canonical id.
      if (adoption.targetId) {
        await saveNotesToCloud(user.id, adoption.targetId, adoption.unassigned)
      }
      const seedFix = migrateSeedIds(projects)
      if (seedFix.changed) {
        projects = seedFix.projects
        cloudList = cloudList.map(e =>
          seedFix.projectIdMap.has(e.id) ? { ...e, id: seedFix.projectIdMap.get(e.id) } : e)
          .filter((e, i, a) => a.findIndex(x => x.id === e.id) === i) // folded twin
        await syncAllToCloud(user.id, projects)
        await purgeLegacySeedRows(seedFix)
      }
      if (needNewlineFix) {
        const res = migrateProjectsNewline(projects)
        projects = res.projects
        if (res.changed) await syncAllToCloud(user.id, projects)
        localStorage.setItem(NEWLINE_FLAG, '1')
      }
      // ── Pull guard ────────────────────────────────────────────────────────
      // The cloud snapshot is only as new as the last push that reached it — a
      // note edited here whose push hasn't landed (debounce pending, flush
      // raced, or another device reverted the row) is NEWER than its cloud
      // copy, and replacing local state wholesale would destroy the edit. Keep
      // the local copy of any id-matched note whose updated_at is strictly
      // newer than the cloud's, and mark its project dirty so the kept copy is
      // pushed back up (through the guarded upsert) instead of lingering
      // local-only. Ties take the cloud copy, matching the push guard's rule.
      //
      // Skipped when local storage is stamped for a DIFFERENT account: seed
      // ids (seed:project, …) are identical on every install, so an id match
      // there could graft the previous user's seed-note edits into this
      // account. mergeGuestAndCloud applies the same newer-wins rule on the
      // explicit-merge path, so this covers only the plain load paths.
      const owner = localStorage.getItem(DATA_OWNER_KEY)
      let preservedAny = false
      if (!owner || owner === user.id) {
        const preservedProjects = []
        projects = projects.map(p => {
          const local = loadProject(p.id)
          if (!local?.notes?.length) return p
          const localById = new Map(local.notes.map(n => [n.id, n]))
          let kept = 0
          const notes = (p.notes ?? []).map(cloudNote => {
            const localNote = localById.get(cloudNote.id)
            if (localNote && parseTs(localNote.updated_at) > parseTs(cloudNote.updated_at)) {
              kept++
              return localNote
            }
            return cloudNote
          })
          if (!kept) return p
          preservedProjects.push(p.id)
          return { ...p, notes }
        })
        if (preservedProjects.length) {
          console.log('[sync] pull guard: kept newer local note copies in project(s)', preservedProjects)
          for (const id of preservedProjects) markProjectDirty(user.id, id)
          preservedAny = true
        }
      }
      saveProjectList(cloudList)
      for (const p of projects) saveProject(p)
      setProjectList(cloudList)
      // Honor this device's last-opened project if the account still has it;
      // otherwise the old default (first cloud project). Covers the case where
      // the cloud pull replaces what initializeData already restored.
      const lastId = loadLastProjectId()
      setActiveProject(migrateTagColors(projects.find(p => p.id === lastId) ?? projects[0]))
      setSelectedBubbleId(null)
      setNoteStack([])
      setCurrentBubbleId(null)
      localStorage.setItem(DATA_OWNER_KEY, user.id)
      clearImportProgress()
      // Push the kept copies back up now that they're in local storage (the
      // flush reads from there). Non-fatal: the dirty flags are durable, so a
      // failure here just leaves the re-push to the normal retry triggers —
      // it must not fail an initial sync whose pull already succeeded.
      if (preservedAny) {
        try { await flushOutbox(user.id) } catch (e) {
          console.warn('[sync] pull guard re-push failed — outbox will retry:', e)
        }
      }
    }

    // First-time sync — migrate then upload all local data
    async function uploadLocalData(needNewlineFix) {
      let allLocal = loadAllProjects(projectList)
      if (needNewlineFix) {
        allLocal = migrateProjectsNewline(allLocal).projects
        for (const p of allLocal) saveProject(p)
        localStorage.setItem(NEWLINE_FLAG, '1')
      }
      await syncAllToCloud(user.id, allLocal)
      localStorage.setItem(DATA_OWNER_KEY, user.id)
      clearImportProgress()
    }

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
        const needNewlineFix = !localStorage.getItem(NEWLINE_FLAG)

        // Local data stamped as belonging to a DIFFERENT account is the previous
        // user's snapshot (plus anything typed over it since), not guest work.
        // Never offer to merge it and never upload any of it — load this
        // account's own cloud data, or start it fresh (same seed a brand-new
        // device gets) if it has none. Leaving the old data in place isn't an
        // option even in the empty-cloud case: the first edit would mark it
        // dirty and push it up under the new account. The outbox is flushed
        // only AFTER local storage holds this account's data, so a stale dirty
        // flag can never re-push a project that belonged to someone else.
        const owner = localStorage.getItem(DATA_OWNER_KEY)
        if (owner && owner !== user.id) {
          const cloudData = await loadAllFromCloud(user.id)
          if (cloudData) {
            await applyCloudData(cloudData, needNewlineFix)
          } else {
            console.warn(
              '[sync] Different-account sign-in with an empty cloud — RESETTING local data to a fresh seed project.',
              { previousOwner: owner, signingInAs: user.id },
            )
            const fresh = createDefaultProject()
            const freshList = [{ id: fresh.id, name: fresh.name, created_at: fresh.created_at }]
            saveProjectList(freshList)
            saveProject(fresh)
            setProjectList(freshList)
            setActiveProject(migrateTagColors(fresh))
            setSelectedBubbleId(null)
            setNoteStack([])
            setCurrentBubbleId(null)
            localStorage.setItem(NEWLINE_FLAG, '1')
            await syncAllToCloud(user.id, [fresh])
            localStorage.setItem(DATA_OWNER_KEY, user.id)
            clearImportProgress()
          }
          await flushOutbox(user.id)
          setSyncStatus('synced')
          return
        }

        // The notes and bubbles already on this device are what's at stake
        // below — read them fresh from storage, not from React state.
        const localProjects = loadAllProjects(loadProjectList() ?? [])
        const localNoteCount = countNotes(localProjects)
        const localBubbleCount = countBubbles(localProjects)

        if (localNoteCount > 0 || localBubbleCount > 0) {
          // Read-only peek: is there also cloud data? Nothing is written locally
          // or remotely until this question — and possibly the user — has answered.
          // Seed ids are remapped in memory so a not-yet-migrated cloud account's
          // legacy seed bubbles still id-match this device's canonical ones; the
          // durable cloud migration happens on whichever write path runs below.
          const peekRaw = await loadAllFromCloud(user.id)
          const peek = peekRaw
            ? { ...peekRaw, projects: migrateSeedIds(peekRaw.projects).projects }
            : null
          // A local copy whose cloud tombstone is newer than its updated_at is
          // a deletion this device missed — NOT local-only work. It must not
          // raise the dialog, must not join a merge union, and must not be
          // re-imported under a fresh id by "Keep separate" (fresh ids would
          // slip it past its tombstone for good). Pruned in memory; local
          // storage catches up when the chosen path's write lands. Notes
          // edited AFTER their deletion survive the prune by the same rule
          // the rest of sync uses (isNoteTombstoned).
          const noteTombstones = peek ? await loadNoteTombstones(user.id) : new Map()
          const pruneTombstoned = projects => noteTombstones.size
            ? projects.map(p => ({
                ...p,
                notes: (p.notes ?? []).filter(n => !isNoteTombstoned(noteTombstones, n)),
              }))
            : projects
          const localLive = pruneTombstoned(localProjects)
          // Only items the cloud doesn't have can be lost. After a normal
          // sign-out the local store is just the last cloud snapshot, so every
          // id matches and the dialog would be pure noise — ask only when
          // loading the cloud would actually destroy something. Bubbles count
          // too: a guest bubble holding no new notes is still real work.
          let localOnlyCount = 0
          let localOnlyBubbleCount = 0
          if (peek) {
            const cloudNoteIds = new Set()
            const cloudBubbleIds = new Set()
            for (const p of peek.projects) {
              for (const n of p.notes ?? []) cloudNoteIds.add(n.id)
              for (const b of p.bubbles ?? []) cloudBubbleIds.add(b.id)
            }
            // Unassigned cloud notes are still cloud notes — missing them here
            // would make their local copies look local-only and raise the
            // dialog for nothing.
            for (const n of peek.unassignedNotes ?? []) cloudNoteIds.add(n.id)
            // Untouched seed content never gates the dialog: the app created
            // it, so a fresh install's teaching note or starter bubbles being
            // absent from an older account is not the user's work at stake.
            // An EDITED seed item is real user data and counts like any
            // other. When genuine local-only items raise the dialog, pristine
            // seed items simply ride along with whichever choice is made.
            for (const p of localLive) {
              for (const n of p.notes ?? []) {
                if (!cloudNoteIds.has(n.id) && !isPristineSeedNote(n)) localOnlyCount++
              }
              for (const b of p.bubbles ?? []) {
                if (!cloudBubbleIds.has(b.id) && !isPristineSeedBubble(b)) localOnlyBubbleCount++
              }
            }
          }
          if (peek && (localOnlyCount > 0 || localOnlyBubbleCount > 0)) {
            // Work on both sides. Any automatic pick would silently lose one
            // side, so stop and ask. The counts shown are what discarding local
            // would actually lose, not the totals.
            const choice = await askMergeChoice({
              local: localOnlyCount,
              bubbles: localOnlyBubbleCount,
              cloud: countNotes(peek.projects) + (peek.unassignedNotes?.length ?? 0),
            })

            if (choice === 'cancel') {
              // Back to guest mode with local data untouched. Guest mode is set
              // before signing out so the login screen never flashes.
              syncedUserRef.current = null
              setSyncStatus('idle')
              continueAsGuest()
              await signOut()
              return
            }

            // Push anything queued from a previous offline session BEFORE pulling. The
            // pull below overwrites local storage with cloud state, so flushing second
            // would discard offline edits and resurrect offline deletes.
            await flushOutbox(user.id)
            const cloudData = await loadAllFromCloud(user.id)
            if (!cloudData) {
              // The cloud emptied between the peek and the choice; nothing left
              // to merge or load, so fall back to first-sign-in adoption.
              await uploadLocalData(needNewlineFix)
            } else if (choice === 'cloud') {
              await applyCloudData(cloudData, needNewlineFix)
            } else if (choice === 'separate') {
              // 'separate' — the device's data becomes brand-new projects in
              // the account (fresh ids, suffixed names; see
              // buildSeparateImport) and the account's own projects are left
              // untouched. The one-time seed-id migration of the cloud side
              // still runs, exactly as the other write paths do — skipping it
              // here would store legacy cloud ids locally and reopen the
              // remap-then-flush duplication window on the next launch. All
              // cloud writes are awaited BEFORE local storage is replaced, so
              // a failure partway leaves the device's data intact and the
              // next sign-in simply asks again.
              // Unassigned cloud notes are adopted into the oldest cloud
              // project here too; persisted below (by the seed-migration
              // upload when it runs, explicitly otherwise).
              const adoption = attachUnassignedNotes(cloudData)
              const seedFix = migrateSeedIds(adoption.projects)
              const cloudProjects = seedFix.projects
              const cloudList = seedFix.changed
                ? cloudData.projectList.map(e =>
                    seedFix.projectIdMap.has(e.id) ? { ...e, id: seedFix.projectIdMap.get(e.id) } : e)
                    .filter((e, i, a) => a.findIndex(x => x.id === e.id) === i) // folded twin
                : cloudData.projectList
              // Resume support: sources that already landed in THIS account
              // during an earlier partial attempt are skipped — their copies
              // are in cloudData (and cloudList) already, so re-importing
              // would duplicate them under the next name suffix.
              const alreadyImported = readImportProgress(user.id)
              const sources = pruneTombstoned(loadAllProjects(loadProjectList() ?? []))
                .filter(p => !alreadyImported.has(p.id))
              let imported = buildSeparateImport(sources, cloudProjects, cloudList)
              // The newline fix is applied to what this path writes (the
              // imports). The flag stays unset so the cloud side still gets
              // its fix from the next applyCloudData run.
              if (needNewlineFix) imported = migrateProjectsNewline(imported).projects
              if (seedFix.changed) {
                await syncAllToCloud(user.id, cloudProjects)
              } else if (adoption.targetId) {
                await saveNotesToCloud(user.id, adoption.targetId, adoption.unassigned)
              }
              // Upload one project at a time, recording each source as done
              // the moment its copy lands, so a failure partway resumes here
              // next time instead of restarting the whole import.
              for (let i = 0; i < imported.length; i++) {
                await syncProjectToCloud(user.id, imported[i])
                markImportDone(user.id, sources[i].id)
              }
              await purgeLegacySeedRows(seedFix)
              const combinedList = [
                ...cloudList,
                ...imported.map(p => ({ id: p.id, name: p.name, created_at: p.created_at })),
              ]
              saveProjectList(combinedList)
              for (const p of [...cloudProjects, ...imported]) saveProject(p)
              setProjectList(combinedList)
              // Land on the first imported project — proof at a glance that
              // nothing the guest made was lost. (A resumed retry can have
              // nothing left to import; land on the account's data then.)
              setActiveProject(migrateTagColors(imported[0] ?? cloudProjects[0]))
              setSelectedBubbleId(null)
              setNoteStack([])
              setCurrentBubbleId(null)
              localStorage.setItem(DATA_OWNER_KEY, user.id)
              clearImportProgress()
            } else {
              // 'merge' — union both sides, then write the cloud FIRST. Local
              // storage is only replaced once the upload succeeds, so a failed
              // merge leaves the guest notes intact. Cloud data is seed-id
              // remapped before the union (local was remapped at startup) so
              // twin seed items meet under one id; the stale legacy rows are
              // purged after the merged upload lands.
              // Unassigned cloud notes join the union inside a project (the
              // oldest one) or the merge would drop them; the merged upload
              // below persists their project_id.
              const adoption = attachUnassignedNotes(cloudData)
              const seedFix = migrateSeedIds(adoption.projects)
              let merged = mergeGuestAndCloud(
                pruneTombstoned(loadAllProjects(loadProjectList() ?? [])),
                seedFix.projects,
              )
              if (needNewlineFix) merged = migrateProjectsNewline(merged).projects
              await syncAllToCloud(user.id, merged)
              await purgeLegacySeedRows(seedFix)
              if (needNewlineFix) localStorage.setItem(NEWLINE_FLAG, '1')
              const mergedList = merged.map(p => ({ id: p.id, name: p.name, created_at: p.created_at }))
              saveProjectList(mergedList)
              for (const p of merged) saveProject(p)
              setProjectList(mergedList)
              // Stay on the project the user was just looking at — every local
              // project survives the union, but it may not be merged[0] (cloud
              // projects sort first). Jumping to merged[0] made a guest bubble
              // in any other project look like the merge had dropped it.
              const viewedId = activeProjectRef.current?.id
              setActiveProject(migrateTagColors(merged.find(p => p.id === viewedId) ?? merged[0]))
              setSelectedBubbleId(null)
              setNoteStack([])
              setCurrentBubbleId(null)
              localStorage.setItem(DATA_OWNER_KEY, user.id)
              clearImportProgress()
            }
            setSyncStatus('synced')
            return
          }
          // Fall through: either no cloud data (unchanged first-sign-in path)
          // or every local note already exists in the account (normal cloud
          // load — nothing on this device can be lost).
        }

        // Push anything queued from a previous offline session BEFORE pulling. The pull
        // below overwrites local storage with cloud state, so flushing second would
        // discard offline edits and resurrect offline deletes.
        await flushOutbox(user.id)
        const cloudData = await loadAllFromCloud(user.id)
        if (cloudData) {
          await applyCloudData(cloudData, needNewlineFix)
        } else {
          await uploadLocalData(needNewlineFix)
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

  // Button handler for GuestMergeDialog — hides the dialog and hands the choice
  // to the promise the sync effect is awaiting.
  function resolveMergeChoice(choice) {
    setMergePrompt(null)
    const resolve = mergeChoiceRef.current
    mergeChoiceRef.current = null
    resolve?.(choice)
  }

  // Button handler for SignOutWarningDialog — same pattern as resolveMergeChoice.
  function resolveSignOutWarning(proceed) {
    setSignOutWarning(null)
    const resolve = signOutChoiceRef.current
    signOutChoiceRef.current = null
    resolve?.(proceed)
  }

  // Sign-out clears the device: once this account's data is safely in its own
  // cloud, local storage goes back to the state a fresh install has (seed
  // project included), so nothing left behind can later be mistaken for the
  // next user's guest work. The flush comes FIRST, and a failed flush blocks
  // the clear behind an explicit acknowledgement of loss. Only the user-facing
  // sign-out goes through here — the merge dialog's "stay signed out" path
  // calls the raw signOut() precisely because it must keep local data intact.
  async function handleSignOut() {
    const uid = userRef.current?.id
    if (!uid) { await signOut(); return }

    // Land the newest edits in localStorage so the flush reads current state.
    cancelPendingSaves()
    if (activeProjectRef.current) saveProject(activeProjectRef.current)

    let flushed = false
    if (navigator.onLine) {
      setSyncStatus('syncing')
      try {
        await flushOutbox(uid)
      } catch (e) {
        console.error('Sign-out flush error:', e)
      }
      flushed = !hasPending(uid)
      setSyncStatus(flushed ? 'synced' : 'error')
    } else {
      // Offline with nothing queued means nothing can be lost.
      flushed = !hasPending(uid)
    }

    if (!flushed) {
      const proceed = await new Promise(resolve => {
        signOutChoiceRef.current = resolve
        setSignOutWarning({ pending: pendingCount(uid) })
      })
      if (!proceed) return
    }

    // supabase.auth.signOut() does NOT reject on failure — it resolves with
    // { error } (and only removes the local session when that error is null),
    // so the returned error must be checked explicitly: a try/catch alone would
    // sail past an offline failure and clear data under a still-live session.
    try {
      const { error } = await signOut()
      if (error) throw error
    } catch (e) {
      // Still signed in — leave everything untouched rather than clearing data
      // out from under a session that didn't actually end.
      console.error('Sign-out failed; local data left untouched:', e)
      setSyncStatus(navigator.onLine ? 'error' : 'offline')
      toastRef.current?.(navigator.onLine
        ? 'Sign-out failed — please try again'
        : 'You’re offline — signing out needs a connection')
      return
    }

    clearDeviceToFreshState()
  }

  // Return the device to the state a fresh install has: every piece of user
  // content and per-account marker removed, seed project re-created, and
  // device-level preferences (theme, note size, sort, onboarding/migration
  // flags) kept. Shared by sign-out and account deletion — callers must only
  // reach this AFTER whatever server-side step makes clearing safe.
  function clearDeviceToFreshState() {
    clearAllProjectData()
    localStorage.removeItem(DATA_OWNER_KEY)
    clearImportProgress()
    // The lock record is a privacy feature, and the window between sign-out and
    // the next sign-in is exactly when someone else may open this browser — so
    // it goes too. Safe to drop: it lives in the account's cloud row and the
    // next sign-in restores it from there. Removing only the localStorage key
    // is complete — LockProvider sits below the LoginScreen early-return, so it
    // unmounted with this sign-out and its next mount re-reads storage.
    localStorage.removeItem('mindmap-lock')
    syncedUserRef.current = null
    setSyncStatus('idle')
    const { projectList: pl, activeProject: ap } = initializeData()
    setProjectList(pl)
    setActiveProject(ap)
    setSelectedBubbleId(null)
    setNoteStack([])
    setCurrentBubbleId(null)
  }

  // Account deletion, in two strictly ordered halves: the edge function is the
  // only authority, and the device is cleared ONLY after it confirms the
  // account row is gone — a failed call leaves cloud and device exactly as
  // they were. After a confirmed deletion the local session belongs to a dead
  // user; signOut removes it (the auth server ignores 401/404 from the dead
  // token), and even if that step fails mid-flow the device is still cleared,
  // because the deletion has already happened and the dialog promised it.
  async function confirmDeleteAccount() {
    setDeleteAccountBusy(true)
    try {
      await deleteAccountOnServer()
    } catch (e) {
      console.error('Account deletion failed:', e)
      setDeleteAccountBusy(false)
      setDeleteAccountPrompt(false)
      toastRef.current?.('Couldn’t delete your account — nothing was changed')
      return
    }
    try { await signOut() } catch {}
    setDeleteAccountBusy(false)
    setDeleteAccountPrompt(false)
    clearDeviceToFreshState()
  }

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

  // A write from a signed-out session means the local store is no longer purely
  // the previous account's snapshot — drop the owner stamp so it counts as guest
  // data again and the next sign-in asks instead of silently discarding it.
  // No-op while signed in. Called at every user-initiated mutation entry point.
  function disownLocalDataIfGuest() {
    if (!userRef.current) localStorage.removeItem(DATA_OWNER_KEY)
  }

  function updateProject(updatedProject) {
    disownLocalDataIfGuest()
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
    disownLocalDataIfGuest()
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
    disownLocalDataIfGuest()
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
    disownLocalDataIfGuest()
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

  // Recoloring is a plain field update — bubbles.color already exists locally
  // and in the cloud schema, so this syncs like any other bubble edit.
  function changeBubbleColor(bubbleId, color) {
    const current = activeProjectRef.current
    const updated = {
      ...current,
      bubbles: current.bubbles.map(b => b.id === bubbleId ? { ...b, color } : b),
    }
    updateProject(updated)
  }

  // Single-bubble delete (sidebar row menu). `bubbleMode` chooses what happens
  // to the contents — see deleteItems, which owns the logic for both paths.
  function deleteBubble(bubbleId, bubbleMode = 'everything') {
    deleteItems({ bubbleIds: [bubbleId], bubbleMode })
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
      // A note always has a location — no target bubble means the canvas.
      bubble_ids: nd.bubble_ids?.length ? nd.bubble_ids : [ROOT_BUBBLE_ID],
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
      // The project canvas is the default location for a new note.
      bubble_ids: noteData.bubble_ids?.length ? noteData.bubble_ids : [ROOT_BUBBLE_ID],
      tags: noteData.tags || [],
      connections: [],
      locked: false,
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

  // ── Locking ─────────────────────────────────────────────────────────────────
  // `locked` is a UI gate only: the content is still stored (and synced) in plain
  // text exactly like an unlocked item — see src/utils/locks.js. Locking a bubble
  // hides everything inside it via inheritance, so children keep their own flags
  // untouched and reappear as they were when the parent is unlocked.
  //
  // Deliberately not routed through updateNote(): a lock isn't an edit, so it
  // shouldn't bump updated_at and reshuffle the "Recently edited" sort.
  function setNoteLocked(noteId, locked) {
    const current = activeProjectRef.current
    updateProject({
      ...current,
      notes: current.notes.map(n => n.id === noteId ? { ...n, locked } : n),
    })
  }

  // "Add to" from select mode: append a bubble to each selected note's
  // memberships. Notes are many-to-many, so every existing membership is kept;
  // the root sentinel is dropped only when the note previously had NO real
  // bubble — the same auto-deselect rule the note editor's picker applies.
  function addNotesToBubble(noteIds, bubbleId) {
    const current = activeProjectRef.current
    const idSet = new Set(noteIds)
    updateProject({
      ...current,
      notes: current.notes.map(n => {
        if (!idSet.has(n.id)) return n
        const ids = n.bubble_ids ?? []
        if (ids.includes(bubbleId)) return n
        const real = realBubbleIds(ids)
        const base = real.length === 0 ? real : ids
        return { ...n, bubble_ids: [...base, bubbleId] }
      }),
    })
  }

  // "Remove from this bubble" (select mode): drop each selected item's
  // membership in the container currently being viewed. Non-destructive by
  // construction — a note losing its last real membership is re-pinned to the
  // root canvas, never deleted, and no OTHER membership is ever touched.
  // Bubbles are single-parented, so for them "remove from here" means
  // re-parent to root. containerId is a bubble id, or null for the root canvas.
  function removeItemsFromContainer({ noteIds = [], bubbleIds = [], containerId = null }) {
    const current = activeProjectRef.current
    const noteSet = new Set(noteIds)
    const bubbleSet = new Set(bubbleIds)
    updateProject({
      ...current,
      notes: current.notes.map(n => {
        if (!noteSet.has(n.id)) return n
        const ids = n.bubble_ids ?? []
        if (containerId == null) {
          // Removing the root pin only makes sense while the note still lives
          // in a real bubble; a root-only note stays put (no-op, never orphaned).
          if (realBubbleIds(ids).length === 0 || !ids.includes(ROOT_BUBBLE_ID)) return n
          return { ...n, bubble_ids: ids.filter(bid => bid !== ROOT_BUBBLE_ID) }
        }
        if (!ids.includes(containerId)) return n
        let updatedIds = ids.filter(bid => bid !== containerId)
        // Last real membership gone → the note lands on the root canvas.
        if (realBubbleIds(updatedIds).length === 0 && !updatedIds.includes(ROOT_BUBBLE_ID)) {
          updatedIds = [...updatedIds, ROOT_BUBBLE_ID]
        }
        return { ...n, bubble_ids: updatedIds }
      }),
      bubbles: current.bubbles.map(b =>
        bubbleSet.has(b.id) && (b.parent_id ?? null) !== null ? { ...b, parent_id: null } : b
      ),
    })
  }

  function setBubbleLocked(bubbleId, locked) {
    const current = activeProjectRef.current
    updateProject({
      ...current,
      bubbles: current.bubbles.map(b => b.id === bubbleId ? { ...b, locked } : b),
    })
  }

  // Clear every lock in every project — used when the password is removed, since
  // locked items would otherwise stay hidden with no password left to reveal them.
  function clearAllLocks() {
    disownLocalDataIfGuest()
    // A queued debounced save still holds the pre-clear project; let it fire and it
    // would write the locked flags straight back.
    cancelPendingSaves()
    const uid = userRef.current?.id
    let touchedAny = false
    for (const meta of projectList) {
      const project = meta.id === activeProjectRef.current?.id
        ? activeProjectRef.current
        : loadProject(meta.id)
      if (!project) continue
      const notes = (project.notes ?? []).map(n => n.locked ? { ...n, locked: false } : n)
      const bubbles = (project.bubbles ?? []).map(b => b.locked ? { ...b, locked: false } : b)
      const changed =
        notes.some((n, i) => n !== project.notes[i]) ||
        bubbles.some((b, i) => b !== project.bubbles[i])
      if (!changed) continue
      touchedAny = true
      const updated = { ...project, notes, bubbles }
      saveProject(updated)
      if (activeProjectRef.current?.id === updated.id) setActiveProject(updated)
      if (uid) markProjectDirty(uid, updated.id)
    }
    if (uid && touchedAny) runFlush()
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

  // Bulk delete for multi-select AND every bubble-delete path. Notes in
  // `noteIds` were selected explicitly and hard-delete exactly as before.
  // Bubbles follow `bubbleMode`:
  //
  //   'everything' — the whole subtree goes: every descendant bubble, and any
  //     note whose EVERY membership lies inside that subtree. Survival is
  //     decided against the note's full membership array project-wide, never
  //     just the part visible in the subtree: one real bubble id outside the
  //     deleted closure, or an explicit root-canvas pin, and the note lives on
  //     (only its in-subtree memberships are stripped) — deleting here must
  //     never remove content from somewhere the user isn't looking.
  //
  //   'keep' — only the named bubbles are deleted; their DIRECT children move
  //     up one level (sub-bubbles intact with their own contents). Notes gain
  //     membership in the deleted bubble's parent level — the parent bubble,
  //     or the root canvas pin at top level — and keep all other memberships.
  function deleteItems({ noteIds = [], bubbleIds = [], bubbleMode = 'everything' }) {
    const current = activeProjectRef.current
    const byId = new Map(current.bubbles.map(b => [b.id, b]))
    const named = new Set(bubbleIds.filter(id => byId.has(id)))

    const bubblesToRemove = new Set()
    if (bubbleMode === 'keep') {
      for (const id of named) bubblesToRemove.add(id)
    } else {
      const collect = (id) => {
        bubblesToRemove.add(id)
        current.bubbles.filter(b => b.parent_id === id).forEach(b => collect(b.id))
      }
      named.forEach(collect)
    }

    const notesToRemove = new Set(noteIds)
    if (notesToRemove.size === 0 && bubblesToRemove.size === 0) return

    // The nearest surviving ancestor of a deleted bubble — where its contents
    // land under 'keep'. Selections are same-level siblings so the chain is
    // normally one step, but walking up keeps a parent+child selection sane.
    const liftedParent = (id) => {
      let p = byId.get(id)?.parent_id ?? null
      while (p != null && bubblesToRemove.has(p)) p = byId.get(p)?.parent_id ?? null
      return p
    }

    let bubbles
    if (bubbleMode === 'keep') {
      bubbles = current.bubbles
        .filter(b => !bubblesToRemove.has(b.id))
        .map(b => bubblesToRemove.has(b.parent_id)
          ? { ...b, parent_id: liftedParent(b.parent_id) }
          : b)
    } else {
      bubbles = current.bubbles.filter(b => !bubblesToRemove.has(b.id))
      // Cascade: a note whose memberships ALL sit inside the deleted closure
      // (and that has no root-canvas pin) has nowhere else it exists.
      for (const n of current.notes) {
        if (notesToRemove.has(n.id)) continue
        const ids = n.bubble_ids ?? []
        const real = realBubbleIds(ids)
        if (real.length > 0 && !ids.includes(ROOT_BUBBLE_ID) && real.every(bid => bubblesToRemove.has(bid))) {
          notesToRemove.add(n.id)
        }
      }
    }

    const notes = current.notes
      .filter(n => !notesToRemove.has(n.id))
      .map(n => {
        let bubble_ids = (n.bubble_ids ?? []).filter(bid => !bubblesToRemove.has(bid))
        if (bubbleMode === 'keep') {
          for (const bid of n.bubble_ids ?? []) {
            if (!bubblesToRemove.has(bid)) continue
            const parent = liftedParent(bid) ?? ROOT_BUBBLE_ID
            if (!bubble_ids.includes(parent)) bubble_ids = [...bubble_ids, parent]
          }
        }
        // Safety net, same as ever: a note is never left with no location.
        if (realBubbleIds(bubble_ids).length === 0 && !bubble_ids.includes(ROOT_BUBBLE_ID)) {
          bubble_ids.push(ROOT_BUBBLE_ID)
        }
        return {
          ...n,
          bubble_ids,
          connections: n.connections.filter(c => !notesToRemove.has(c.note_id)),
        }
      })

    const updated = { ...current, bubbles, notes }
    if (selectedBubbleId && bubblesToRemove.has(selectedBubbleId)) setSelectedBubbleId(null)
    setNoteStack(prev => prev.filter(id => !notesToRemove.has(id)))

    const ops = []
    if (notesToRemove.size) ops.push({ kind: 'notes', noteIds: [...notesToRemove] })
    if (bubblesToRemove.size) ops.push({ kind: 'bubbles', bubbleIds: [...bubblesToRemove] })
    commitDelete(updated, ops)
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
    const bubbleIds = currentBubbleId ? [currentBubbleId] : [ROOT_BUBBLE_ID]
    const note = createNote({ content: '', bubble_ids: bubbleIds, tags: [] })
    setNoteStack([note.id])
  }

  // ── + button: tap expands it into Note/Bubble tiles, hold creates a bubble ───
  //
  // The tap expands the + into two icon tiles (Note in the +'s own spot, Bubble
  // above it — see CreateButton) so bubble creation is discoverable; the hold
  // remains a direct fast path to the bubble sheet for anyone who knows it. The
  // two are mutually exclusive by way of heldFiredRef: once the hold has opened
  // the sheet, the release that follows — and the click the browser synthesises
  // from it — is swallowed, so a hold never also expands the tiles over the
  // sheet. The ref resets on the next press. Keyboard activation reaches onClick
  // with no pointer sequence at all, which is why the expansion path lives there
  // and not in onPointerUp.
  function beginPlusHold() {
    heldFiredRef.current = false
    setPlusHeld(true)
    clearTimeout(holdTimerRef.current)
    holdTimerRef.current = setTimeout(() => {
      heldFiredRef.current = true
      setPlusHeld(false)
      setCreateBubbleOpen(true)
    }, LONG_PRESS_MS)
  }

  function endPlusHold() {
    clearTimeout(holdTimerRef.current)
    setPlusHeld(false)
    // The release is itself a user gesture — the one chance to raise the phone
    // keyboard for a sheet that was opened from a timer.
    if (heldFiredRef.current) setSheetFocusNonce(n => n + 1)
  }

  function cancelPlusHold() {
    clearTimeout(holdTimerRef.current)
    setPlusHeld(false)
  }

  function handlePlusClick() {
    if (heldFiredRef.current) { heldFiredRef.current = false; return }
    setPlusExpanded(true)
  }

  // ── Keyboard shortcuts (desktop) ─────────────────────────────────────────────
  //
  // The same two things the + button does — tap for a note, hold for a bubble — plus
  // jumping to search and turning pages. Every guard that matters lives in the listener
  // (see resolveShortcut); what's left here is which action runs what.
  //
  // `enabled` covers the two states the layer stack can't see: there is no project yet,
  // or onboarding is up. Onboarding is the one full-screen thing that doesn't register
  // an Escape layer, so it has to be named.
  function runShortcut(action) {
    switch (action) {
      case 'note':
        handleCreateNote()
        break
      case 'bubble':
        // The sheet focuses its own name field when it opens, so unlike the hold gesture
        // this needs no follow-up nonce to get the caret into it.
        setCreateBubbleOpen(true)
        break
      case 'search':
        // The search field only exists in the chronological view, so the switch has to
        // land before the focus request — hence the nonce rather than a direct call.
        setViewMode('chronological')
        setSearchFocusNonce(n => n + 1)
        break
      case 'prev-page':
        setPageStep(s => ({ dir: -1, nonce: (s?.nonce ?? 0) + 1 }))
        break
      case 'next-page':
        setPageStep(s => ({ dir: 1, nonce: (s?.nonce ?? 0) + 1 }))
        break
      default:
        break
    }
  }

  useKeyShortcuts({
    enabled: !!activeProject && !showOnboarding,
    arrows: viewMode === 'bubble',
    onAction: runShortcut,
  })

  function handleCreateBubble(name, color) {
    const bubble = { id: generateId(), name, parent_id: currentBubbleId, color }
    addBubble(bubble)
    setPlaceBubbleId(bubble.id)
    setCreateBubbleOpen(false)
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
    <PreferencesProvider>
    <ToastProvider>
    <ToastBridge toastRef={toastRef} />
    <LockProvider onRemoveAllLocks={clearAllLocks}>
    <div
      data-app-root=""
      className="flex flex-col overflow-hidden"
      // height: measured innerHeight (see the --app-h effect above), 100dvh only until
      // the first effect tick. h-dvh alone left the column an inset short in standalone.
      style={{ background: 'var(--bg)', height: 'var(--app-h, 100dvh)' }}
    >
      <AppVignette
        bubble={viewMode === 'bubble'
          ? activeProject.bubbles.find(b => b.id === currentBubbleId)
          : null}
      />
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
        onGoToProjectRoot={() => {
          // Already at the root canvas → no-op, not a jarring re-navigation.
          if (viewMode === 'bubble' && currentBubbleId === null) return
          setSelectedBubbleId(null)
          setViewMode('bubble')
          setNavigateBubbleId({ id: null, nonce: Date.now() })
        }}
        atProjectRoot={viewMode === 'bubble' && currentBubbleId === null}
        controlsSlotRef={setHeaderControlsEl}
        isDesktop={isDesktop}
        syncStatus={syncStatus}
        onSignOut={handleSignOut}
      />

      {/* Transparent (was var(--bg)): the app root behind paints the same ground,
          and an opaque box here would cover the shell-level vignette band. */}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          open={sidebarOpen}
          isDesktop={isDesktop}
          project={activeProject}
          selectedBubbleId={selectedBubbleId}
          activeBubbleId={currentBubbleId}
          onSelectBubble={(id) => {
            setSelectedBubbleId(id)
            setViewMode('bubble')
            // Command OBJECT, not the bare id: a fresh object every click, so
            // re-selecting the same bubble still fires. With the bare id,
            // React's same-value bailout silently dropped the command after
            // the canvas had navigated away internally (back swipe/button,
            // Escape, tapping into a bubble) — the sidebar dead-click bug.
            setNavigateBubbleId({ id, nonce: Date.now() })
            if (!isDesktop) setSidebarOpen(false)
          }}
          onAddBubble={addBubble}
          onSetBubbleLocked={setBubbleLocked}
          onRenameBubble={renameBubble}
          onDeleteBubble={deleteBubble}
          onMoveBubble={moveBubble}
          onChangeBubbleColor={changeBubbleColor}
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
            onDeleteItems={deleteItems}
            onSetNoteLocked={setNoteLocked}
            onSetBubbleLocked={setBubbleLocked}
            onCurrentBubbleChange={setCurrentBubbleId}
            onAddNotesToBubble={addNotesToBubble}
            onRemoveItemsFromContainer={removeItemsFromContainer}
            headerControlsEl={headerControlsEl}
            navigateBubbleId={navigateBubbleId}
            placeBubbleId={placeBubbleId}
            onChangeBubbleColor={changeBubbleColor}
            onRenameBubble={renameBubble}
            searchFocusNonce={searchFocusNonce}
            pageStep={pageStep}
            onRefresh={handleRefresh}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen(o => !o)}
          />
        </div>
      </div>

      {/* Floating Create Button — tap expands into Note/Bubble tiles, hold for a bubble */}
      <CreateButton
        held={plusHeld}
        holdMs={LONG_PRESS_MS}
        onClick={handlePlusClick}
        onPointerDown={beginPlusHold}
        onPointerUp={endPlusHold}
        onPointerCancel={cancelPlusHold}
        expanded={plusExpanded}
        onCreateNote={() => { setPlusExpanded(false); handleCreateNote() }}
        onCreateBubble={() => { setPlusExpanded(false); setCreateBubbleOpen(true) }}
        onCollapse={() => setPlusExpanded(false)}
      />

      <CreateBubbleSheet
        open={createBubbleOpen}
        parentName={activeProject.bubbles.find(b => b.id === currentBubbleId)?.name ?? null}
        siblingNames={activeProject.bubbles
          .filter(b => (b.parent_id ?? null) === (currentBubbleId ?? null))
          .map(b => b.name)}
        defaultColor={leastUsedBubbleColor(
          activeProject.bubbles
            .filter(b => (b.parent_id ?? null) === (currentBubbleId ?? null))
            .map(b => b.color),
          activeProject.bubbles.map(b => b.color),
        )}
        focusNonce={sheetFocusNonce}
        onCreate={handleCreateBubble}
        onCancel={() => setCreateBubbleOpen(false)}
      />

      {/* Settings panel */}
      <AnimatePresence>
        {settingsOpen && (
          <Settings key="settings" onClose={() => { setSettingsOpen(false); setShareImport(null) }} zIndex={45} project={activeProject} onImportNotes={importNotes} onSignOut={handleSignOut} onDeleteAccount={() => setDeleteAccountPrompt(true)} shareImport={shareImport} onShareImportDone={() => setShareImport(null)} />
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
          // The label names the ACTUAL return destination. closeTopNote only
          // pops this stack — it never moves the canvas or flips the view —
          // so for the base note the destination is whatever viewMode /
          // currentBubbleId say right now (both are live state; the canvas
          // reports level changes via onCurrentBubbleChange). For stacked
          // notes, back pops to the note beneath, so its title is the label.
          const backLabel = prevNote
            ? (noteTitle(prevNote) || 'Untitled')
            : viewMode === 'chronological'
              ? 'All Notes'
              : currentBubbleId
                ? (activeProject.bubbles.find(b => b.id === currentBubbleId)?.name ?? activeProject.name)
                : activeProject.name
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

      {/* Guest ⇄ cloud conflict — blocking; see the initial-sync effect */}
      {signOutWarning && (
        <SignOutWarningDialog pending={signOutWarning.pending} onChoose={resolveSignOutWarning} />
      )}

      {deleteAccountPrompt && (
        <DeleteAccountDialog
          busy={deleteAccountBusy}
          onChoose={confirmed => {
            if (confirmed) confirmDeleteAccount()
            else setDeleteAccountPrompt(false)
          }}
        />
      )}

      {mergePrompt && (
        <GuestMergeDialog
          localCount={mergePrompt.local}
          localBubbleCount={mergePrompt.bubbles}
          cloudCount={mergePrompt.cloud}
          onChoose={resolveMergeChoice}
        />
      )}
    </div>
    </LockProvider>
    </ToastProvider>
    </PreferencesProvider>
    </ThemeProvider>
  )
}
