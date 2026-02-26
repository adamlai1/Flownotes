const PROJECTS_KEY = 'mindmap-projects'

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
