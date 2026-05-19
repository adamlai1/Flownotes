import { supabase } from './supabase'

// ── Save functions ─────────────────────────────────────────────────────────────

export async function saveProjectsToCloud(userId, projects) {
  const rows = projects.map(p => ({
    id: p.id, user_id: userId, name: p.name, created_at: p.created_at,
  }))
  const { error } = await supabase.from('projects').upsert(rows, { onConflict: 'id' })
  if (error) throw error
}

export async function saveBubblesToCloud(userId, projectId, bubbles) {
  if (!bubbles.length) return
  const rows = bubbles.map(b => ({
    id: b.id, project_id: projectId, user_id: userId,
    name: b.name, parent_id: b.parent_id ?? null, color: b.color ?? null,
    position_x: b.position_x ?? null, position_y: b.position_y ?? null,
  }))
  const { error } = await supabase.from('bubbles').upsert(rows, { onConflict: 'id' })
  if (error) throw error
}

export async function saveNotesToCloud(userId, notes) {
  if (!notes.length) return
  const rows = notes.map(n => ({
    id: n.id, user_id: userId,
    title: n.content?.split('\n')[0]?.trim() ?? '',
    content: n.content ?? '',
    created_at: n.created_at, updated_at: n.updated_at,
    bubble_ids: n.bubble_ids ?? [], tags: n.tags ?? [],
    pinned: n.pinned ?? false,
  }))
  const { error } = await supabase.from('notes').upsert(rows, { onConflict: 'id' })
  if (error) throw error
}

export async function saveConnectionsToCloud(userId, notes) {
  const rows = []
  const seen = new Set()
  for (const note of notes) {
    for (const conn of note.connections ?? []) {
      const key = `${note.id}:${conn.note_id}`
      if (!seen.has(key)) {
        seen.add(key)
        rows.push({ user_id: userId, from_note_id: note.id, to_note_id: conn.note_id, relationship_type: conn.type })
      }
    }
  }
  const noteIds = notes.map(n => n.id)
  if (noteIds.length) {
    await supabase.from('connections').delete().eq('user_id', userId).in('from_note_id', noteIds)
  }
  if (rows.length) {
    const { error } = await supabase.from('connections').insert(rows)
    if (error) throw error
  }
}

export async function saveCustomTagsToCloud(userId, customTagColors) {
  const entries = Object.entries(customTagColors ?? {})
  if (!entries.length) return
  const rows = entries.map(([name, color]) => ({ user_id: userId, name, color }))
  const { error } = await supabase.from('custom_tags').upsert(rows, { onConflict: 'user_id,name' })
  if (error) throw error
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadAllFromCloud(userId) {
  const [
    { data: projects, error: e1 },
    { data: bubbles, error: e2 },
    { data: notes, error: e3 },
    { data: connections, error: e4 },
    { data: customTags, error: e5 },
  ] = await Promise.all([
    supabase.from('projects').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('bubbles').select('*').eq('user_id', userId),
    supabase.from('notes').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    supabase.from('connections').select('*').eq('user_id', userId),
    supabase.from('custom_tags').select('*').eq('user_id', userId),
  ])

  if (e1 || e2 || e3 || e4 || e5) throw (e1 || e2 || e3 || e4 || e5)
  if (!projects?.length) return null

  // Connection map: from_note_id → [{ note_id, type }]
  const connMap = {}
  for (const c of connections ?? []) {
    if (!connMap[c.from_note_id]) connMap[c.from_note_id] = []
    connMap[c.from_note_id].push({ note_id: c.to_note_id, type: c.relationship_type })
  }

  // Bubble lookup by project
  const bubblesByProject = {}
  const bubbleToProject = {}
  for (const b of bubbles ?? []) {
    if (!bubblesByProject[b.project_id]) bubblesByProject[b.project_id] = []
    bubblesByProject[b.project_id].push({ id: b.id, name: b.name, parent_id: b.parent_id, color: b.color })
    bubbleToProject[b.id] = b.project_id
  }

  // Assign notes to projects via bubble_ids; orphans go to first project
  const notesByProject = {}
  const firstProjectId = projects[0].id
  for (const n of notes ?? []) {
    let projectId = firstProjectId
    for (const bid of n.bubble_ids ?? []) {
      if (bubbleToProject[bid]) { projectId = bubbleToProject[bid]; break }
    }
    if (!notesByProject[projectId]) notesByProject[projectId] = []
    notesByProject[projectId].push({
      id: n.id, content: n.content ?? '',
      created_at: n.created_at, updated_at: n.updated_at,
      bubble_ids: n.bubble_ids ?? [], tags: n.tags ?? [],
      connections: connMap[n.id] ?? [],
    })
  }

  const customTagColors = {}
  for (const t of customTags ?? []) customTagColors[t.name] = t.color

  const fullProjects = projects.map(p => ({
    id: p.id, name: p.name, created_at: p.created_at,
    bubbles: bubblesByProject[p.id] ?? [],
    notes: notesByProject[p.id] ?? [],
    customTagColors: Object.keys(customTagColors).length ? customTagColors : undefined,
  }))

  return {
    projectList: projects.map(p => ({ id: p.id, name: p.name, created_at: p.created_at })),
    projects: fullProjects,
  }
}

// ── Full sync helpers ──────────────────────────────────────────────────────────

export async function syncProjectToCloud(userId, project) {
  await saveProjectsToCloud(userId, [project])
  await saveBubblesToCloud(userId, project.id, project.bubbles ?? [])
  await saveNotesToCloud(userId, project.notes ?? [])
  await saveConnectionsToCloud(userId, project.notes ?? [])
  await saveCustomTagsToCloud(userId, project.customTagColors ?? {})
}

export async function syncAllToCloud(userId, projects) {
  for (const project of projects) {
    await syncProjectToCloud(userId, project)
  }
}

export async function deleteProjectFromCloud(userId, projectId) {
  await Promise.all([
    supabase.from('bubbles').delete().eq('project_id', projectId).eq('user_id', userId),
    supabase.from('projects').delete().eq('id', projectId).eq('user_id', userId),
  ])
}
