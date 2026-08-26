import { isPristineSeedProject } from '../data/defaultData'

const PROJECTS_KEY = 'mindmap-projects'
// Which project the user last had open, restored at launch. Per-device on
// purpose — never synced to the cloud; two devices can be in two projects.
const LAST_PROJECT_KEY = 'mindmap-last-project'

// Splash gate stamp — the key index.html's head gate checks to decide whether
// a visit skips the public splash. Present iff this device holds real user
// work: a note or bubble created, edited, or deleted, or a canvas layout
// moved. Untouched seed content never sets it, so a guest who only looked
// around sees the splash again on every visit; the stamp is read only by the
// gate, at load, so becoming a "changed" guest takes effect on the NEXT visit.
const USER_CONTENT_KEY = 'mindmap-user-content'

export function markUserContent() {
  try {
    if (!localStorage.getItem(USER_CONTENT_KEY)) localStorage.setItem(USER_CONTENT_KEY, '1')
  } catch {
    // Storage full/unavailable: the visitor just sees the splash again.
  }
}

function projectKey(id) {
  return `mindmap-project-${id}`
}

export function loadProjectList() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveProjectList(projects) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
}

export function loadProject(id) {
  try {
    const raw = localStorage.getItem(projectKey(id))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveProject(project) {
  localStorage.setItem(projectKey(project.id), JSON.stringify(project))
  // Every data write funnels through here, so this one check is the whole
  // "has the guest made a change" bookkeeping: any persisted shape beyond
  // pristine seed content — a created/edited note or bubble, a deleted seed
  // item (the id-set mismatch), a user-created project (non-seed id) — stamps
  // the device. Timestamp-only rewrites are still pristine, so merely opening
  // and closing the teaching note does not.
  if (!isPristineSeedProject(project)) markUserContent()
}

export function deleteProject(id) {
  localStorage.removeItem(projectKey(id))
}

export function loadAllProjects(projectList) {
  return projectList.map(meta => loadProject(meta.id)).filter(Boolean)
}

export function loadLastProjectId() {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY)
  } catch {
    return null
  }
}

export function saveLastProjectId(id) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id)
  } catch {
    // Storage full/unavailable: losing the launch preference is harmless.
  }
}

// Per-project layout caches other modules key by project id (bubble positions,
// page assignments, pinned notes). Swept together with the project blobs.
const POSITIONS_PREFIX = 'mindmap-pos-'
const PAGES_PREFIX = 'mindmap-pages-'
const PER_PROJECT_PREFIXES = ['mindmap-project-', POSITIONS_PREFIX, PAGES_PREFIX, 'mindmap-pins-', 'mindmap-sortmode-']

// Devices whose changes predate the stamp (it shipped after their work did)
// would otherwise see the splash once more per visit until their next write.
// Derive the stamp once per launch from what's already stored: any non-pristine
// project, or any saved canvas layout (positions/pages are only ever written
// by user drags). Cheap — skipped entirely once the stamp exists.
export function backfillUserContentStamp() {
  try {
    if (localStorage.getItem(USER_CONTENT_KEY)) return
    const list = loadProjectList()
    if (list && loadAllProjects(list).some(p => !isPristineSeedProject(p))) {
      markUserContent()
      return
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || (!key.startsWith(POSITIONS_PREFIX) && !key.startsWith(PAGES_PREFIX))) continue
      const raw = localStorage.getItem(key)
      if (raw && raw !== '{}') { markUserContent(); return }
    }
  } catch {
    // Unreadable storage: leave the stamp unset; the gate then shows the splash.
  }
}

// Remove the project list, every stored project (including orphaned blobs no
// longer in the list), and all per-project layout caches. Used by sign-out to
// return the device to a fresh-install state; device-level preferences that
// aren't user content (theme, note size, sort, onboarding/migration flags) are
// deliberately untouched.
export function clearAllProjectData() {
  localStorage.removeItem(PROJECTS_KEY)
  // Last-opened project is user context, not a device preference — it names a
  // project this sweep is about to delete, so it goes with the data.
  localStorage.removeItem(LAST_PROJECT_KEY)
  // The splash-gate stamp describes the data this sweep deletes, so it goes
  // too: a signed-out device is back to fresh-install state and the next
  // visit sees the public splash again.
  localStorage.removeItem(USER_CONTENT_KEY)
  const doomed = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && PER_PROJECT_PREFIXES.some(p => key.startsWith(p))) doomed.push(key)
  }
  for (const key of doomed) localStorage.removeItem(key)
}
