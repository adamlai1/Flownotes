const PROJECTS_KEY = 'mindmap-projects'
// Which project the user last had open, restored at launch. Per-device on
// purpose — never synced to the cloud; two devices can be in two projects.
const LAST_PROJECT_KEY = 'mindmap-last-project'

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
const PER_PROJECT_PREFIXES = ['mindmap-project-', 'mindmap-pos-', 'mindmap-pages-', 'mindmap-pins-', 'mindmap-sortmode-']

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
  const doomed = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && PER_PROJECT_PREFIXES.some(p => key.startsWith(p))) doomed.push(key)
  }
  for (const key of doomed) localStorage.removeItem(key)
}
