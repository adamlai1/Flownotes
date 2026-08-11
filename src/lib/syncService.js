import { supabase } from './supabase'
import { generateId } from '../utils/helpers'

// The `locked` column on notes/bubbles (supabase/locks.sql) may not exist yet on an
// account that hasn't run the migration. Rather than break ALL syncing there, detect
// that specific error and retry once without the column — locks then stay device-local
// until the migration is run.
function isMissingColumnError(error, column) {
  const text = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`
  return !!error && text.includes(column) &&
    (error.code === 'PGRST204' || error.code === '42703' || /column/i.test(text))
}

async function upsertRows(table, rows, onConflict, optionalColumn) {
  const { error } = await supabase.from(table).upsert(rows, { onConflict })
  if (!error) return
  if (optionalColumn && isMissingColumnError(error, optionalColumn)) {
    console.warn(`[sync] ${table}.${optionalColumn} missing — run supabase/locks.sql. Retrying without it.`)
    const stripped = rows.map(({ [optionalColumn]: _drop, ...rest }) => rest)
    const retry = await supabase.from(table).upsert(stripped, { onConflict })
    if (retry.error) throw retry.error
    return
  }
  throw error
}

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
    locked: b.locked ?? false,
  }))
  await upsertRows('bubbles', rows, 'id', 'locked')
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
    locked: n.locked ?? false,
  }))
  await upsertRows('notes', rows, 'id', 'locked')
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

export async function saveCustomTagsToCloud(userId, customTagColors, customTagIds = {}) {
  const entries = Object.entries(customTagColors ?? {})
  if (!entries.length) return
  const rows = entries.map(([name, color]) => {
    // Every row needs a non-null id (the column is NOT NULL). Prefer the stable
    // id we already have for this tag; generate one if it's missing/null/empty.
    // Use || (not ??) so an empty string is also treated as "no id".
    const id = customTagIds?.[name] || generateId()
    return { id, user_id: userId, name, color }
  })

  // Log every row being sent to Supabase so a bad id is visible in the console.
  console.log('[custom_tags] rows to upsert:', JSON.stringify(rows, null, 2))

  // Guaranteed fix: never send a row with a null/undefined/empty id.
  const validRows = rows.filter(row => row.id && row.id !== null && row.id !== undefined)
  if (validRows.length !== rows.length) {
    console.error('FILTERED OUT TAGS WITH NULL IDS:', rows.filter(r => !r.id))
  }
  if (!validRows.length) return

  const { error } = await supabase.from('custom_tags').upsert(validRows, { onConflict: 'user_id,name' })
  if (error) throw error
}

// ── Preferences (per-account display settings) ──────────────────────────────────
// Stored in the user_preferences table (see supabase/user_preferences.sql). Both
// helpers stay quiet if the table doesn't exist yet or the network is down — the
// caller falls back to the localStorage copy.

export async function loadPreferencesFromCloud(userId) {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('note_size, lock_hash, lock_salt')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data // null when the user has no saved row yet
}

// Only the keys present in `prefs` are written, so the lock columns and note_size
// can be updated independently without clobbering each other.
export async function savePreferencesToCloud(userId, prefs) {
  const row = { user_id: userId, updated_at: new Date().toISOString() }
  if (prefs.note_size !== undefined) row.note_size = prefs.note_size
  if (prefs.lock_hash !== undefined) row.lock_hash = prefs.lock_hash
  if (prefs.lock_salt !== undefined) row.lock_salt = prefs.lock_salt
  const { error } = await supabase
    .from('user_preferences')
    .upsert(row, { onConflict: 'user_id' })
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
    bubblesByProject[b.project_id].push({
      id: b.id, name: b.name, parent_id: b.parent_id, color: b.color,
      locked: b.locked ?? false,
    })
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
      locked: n.locked ?? false,
      connections: connMap[n.id] ?? [],
    })
  }

  const customTagColors = {}
  const customTagIds = {}
  for (const t of customTags ?? []) {
    customTagColors[t.name] = t.color
    customTagIds[t.name] = t.id
  }

  const fullProjects = projects.map(p => ({
    id: p.id, name: p.name, created_at: p.created_at,
    bubbles: bubblesByProject[p.id] ?? [],
    notes: notesByProject[p.id] ?? [],
    customTagColors: Object.keys(customTagColors).length ? customTagColors : undefined,
    customTagIds: Object.keys(customTagIds).length ? customTagIds : undefined,
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
  await saveCustomTagsToCloud(userId, project.customTagColors ?? {}, project.customTagIds ?? {})
}

export async function syncAllToCloud(userId, projects) {
  for (const project of projects) {
    await syncProjectToCloud(userId, project)
  }
}

export async function deleteProjectFromCloud(userId, projectId, noteIds = []) {
  const ops = [
    supabase.from('bubbles').delete().eq('project_id', projectId).eq('user_id', userId),
    supabase.from('projects').delete().eq('id', projectId).eq('user_id', userId),
  ]
  if (noteIds.length) {
    ops.push(supabase.from('connections').delete().eq('user_id', userId).in('from_note_id', noteIds))
    ops.push(supabase.from('connections').delete().eq('user_id', userId).in('to_note_id', noteIds))
    ops.push(supabase.from('notes').delete().eq('user_id', userId).in('id', noteIds))
  }
  const results = await Promise.all(ops)
  const failed = results.find(r => r.error)
  if (failed) throw failed.error
}

// ── Immediate deletes ───────────────────────────────────────────────────────────
// Deletes must hit the cloud right away (not via the debounced upsert sync), since
// the upsert-based sync only ever writes rows that still exist locally and can never
// remove ones that were deleted — so a deleted item would reappear on the next load.

export async function deleteNotesFromCloud(userId, noteIds) {
  if (!noteIds.length) return
  // Remove connections referencing these notes in either direction first.
  const connResults = await Promise.all([
    supabase.from('connections').delete().eq('user_id', userId).in('from_note_id', noteIds),
    supabase.from('connections').delete().eq('user_id', userId).in('to_note_id', noteIds),
  ])
  const connFailed = connResults.find(r => r.error)
  if (connFailed) throw connFailed.error
  // .select() returns the rows actually deleted. If this comes back empty while
  // the note exists in the table, either user_id didn't match or RLS blocked it.
  const { data, error } = await supabase
    .from('notes').delete().eq('user_id', userId).in('id', noteIds).select('id')
  if (error) throw error
  console.log(`[delete] notes deleted from cloud: ${data?.length ?? 0}/${noteIds.length}`, { userId, noteIds })
}

export async function deleteBubblesFromCloud(userId, bubbleIds) {
  if (!bubbleIds.length) return
  const { error } = await supabase.from('bubbles').delete().eq('user_id', userId).in('id', bubbleIds)
  if (error) throw error
}

export async function deleteCustomTagFromCloud(userId, tagName) {
  const { error } = await supabase.from('custom_tags').delete().eq('user_id', userId).eq('name', tagName)
  if (error) throw error
}
