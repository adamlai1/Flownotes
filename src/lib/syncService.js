import { supabase } from './supabase'
import { generateId, connectionType } from '../utils/helpers'

// The `locked` column on notes/bubbles (supabase/locks.sql) may not exist yet on an
// account that hasn't run the migration. Rather than break ALL syncing there, detect
// that specific error and retry once without the column — locks then stay device-local
// until the migration is run.
function isMissingColumnError(error, column) {
  const text = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`
  return !!error && text.includes(column) &&
    (error.code === 'PGRST204' || error.code === '42703' || /column/i.test(text))
}

// optionalColumn may be a single column name or an array of them (each one an
// optional column whose migration may not have been run yet). On a
// missing-column error the offending column is stripped and the upsert retried
// recursively, so any combination of missing optional columns still syncs.
async function upsertRows(table, rows, onConflict, optionalColumn) {
  const optional = Array.isArray(optionalColumn) ? optionalColumn : optionalColumn ? [optionalColumn] : []
  const { error } = await supabase.from(table).upsert(rows, { onConflict })
  if (!error) return
  const missing = optional.find(col => isMissingColumnError(error, col))
  if (missing) {
    console.warn(`[sync] ${table}.${missing} missing — run its migration in supabase/. Retrying without it.`)
    const stripped = rows.map(({ [missing]: _drop, ...rest }) => rest)
    return upsertRows(table, stripped, onConflict, optional.filter(col => col !== missing))
  }
  throw error
}

// ── Save functions ─────────────────────────────────────────────────────────────

export async function saveProjectsToCloud(userId, projects) {
  const rows = projects.map(p => ({
    id: p.id, user_id: userId, name: p.name, created_at: p.created_at,
  }))
  const { error } = await supabase.from('projects').upsert(rows, { onConflict: 'user_id,id' })
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
  await upsertRows('bubbles', rows, 'user_id,id', 'locked')
}

// projectId is the note's containing project — the caller's project object is
// the single source of truth for membership, so every note write stamps
// project_id from it. That stored assignment is what keeps a note in its
// project after its last bubble is removed (no inference, no fallback).
export async function saveNotesToCloud(userId, projectId, notes) {
  if (!notes.length) return
  const rows = notes.map(n => ({
    id: n.id, user_id: userId,
    project_id: projectId,
    title: n.content?.split('\n')[0]?.trim() ?? '',
    content: n.content ?? '',
    created_at: n.created_at, updated_at: n.updated_at,
    bubble_ids: n.bubble_ids ?? [], tags: n.tags ?? [],
    pinned: n.pinned ?? false,
    locked: n.locked ?? false,
  }))
  await upsertRows('notes', rows, 'user_id,id', ['locked', 'project_id'])
}

export async function saveConnectionsToCloud(userId, notes) {
  const rows = []
  const seen = new Set()
  for (const note of notes) {
    for (const conn of note.connections ?? []) {
      const key = `${note.id}:${conn.note_id}`
      if (!seen.has(key)) {
        seen.add(key)
        // connectionType, not conn.type: editor-created connections carried
        // the label under relationship_type, so reading .type sent every row
        // without a label — the insert failed and no connection ever reached
        // the cloud.
        rows.push({
          user_id: userId,
          from_note_id: note.id,
          to_note_id: conn.note_id,
          relationship_type: connectionType(conn),
        })
      }
    }
  }
  const noteIds = notes.map(n => n.id)
  if (noteIds.length) {
    // The delete's failure was silently ignored — the one genuinely
    // swallowed error in this path. Surface it like everything else.
    const { error: deleteError } = await supabase
      .from('connections').delete().eq('user_id', userId).in('from_note_id', noteIds)
    if (deleteError) throw deleteError
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

// ── Feedback ──────────────────────────────────────────────────────────────────
//
// __APP_VERSION__ is package.json's version, substituted as a literal by Vite at build
// time (see vite.config.js). The fallback covers anything that evaluates this module
// outside a Vite build — the test harnesses bundle straight through esbuild, where the
// define doesn't exist and a bare reference would throw a ReferenceError on import.
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null

// One insert into the feedback table (see supabase/feedback.sql). Unlike the sync
// helpers this one does NOT swallow its error: the user pressed Send and is waiting to
// be told whether it arrived, so a failure has to reach them rather than vanish.
// userId is null in guest mode — the table accepts anonymous reports.

export async function submitFeedback(userId, message) {
  const text = (message || '').trim()
  if (!text) throw new Error('Feedback is empty')
  const { error } = await supabase.from('feedback').insert({
    user_id: userId ?? null,
    message: text.slice(0, 5000),
    user_agent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    app_version: APP_VERSION,
  })
  if (error) throw error
}

// ── Account deletion ──────────────────────────────────────────────────────────
// Calls the delete-account edge function (supabase/functions/delete-account),
// which verifies the caller's JWT server-side and deletes the auth user with
// the service role key; FK cascades remove the user's rows. The session token
// is attached automatically by functions.invoke, so this works identically on
// web and native. Throws on any failure — the caller must not clear local
// data unless this resolves.

export async function deleteAccountOnServer() {
  const { error } = await supabase.functions.invoke('delete-account')
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

  // Assign notes to projects: the stored project_id is authoritative. Rows
  // predating the project_id migration (supabase/note_project_id.sql) fall
  // back to bubble membership — first bubble in bubble_ids order, the same
  // rule that migration's backfill uses. A note with neither goes into
  // unassignedNotes for the caller to adopt EXPLICITLY and persist; the old
  // silent first-project fallback is gone.
  const projectIds = new Set(projects.map(p => p.id))
  const notesByProject = {}
  const unassignedNotes = []
  for (const n of notes ?? []) {
    let projectId = projectIds.has(n.project_id) ? n.project_id : null
    if (!projectId) {
      for (const bid of n.bubble_ids ?? []) {
        if (bubbleToProject[bid]) { projectId = bubbleToProject[bid]; break }
      }
    }
    const note = {
      id: n.id, content: n.content ?? '',
      created_at: n.created_at, updated_at: n.updated_at,
      bubble_ids: n.bubble_ids ?? [], tags: n.tags ?? [],
      locked: n.locked ?? false,
      connections: connMap[n.id] ?? [],
    }
    if (!projectId) { unassignedNotes.push(note); continue }
    if (!notesByProject[projectId]) notesByProject[projectId] = []
    notesByProject[projectId].push(note)
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
    unassignedNotes,
  }
}

// ── Full sync helpers ──────────────────────────────────────────────────────────

export async function syncProjectToCloud(userId, project) {
  await saveProjectsToCloud(userId, [project])
  await saveBubblesToCloud(userId, project.id, project.bubbles ?? [])
  await saveNotesToCloud(userId, project.id, project.notes ?? [])
  await saveConnectionsToCloud(userId, project.notes ?? [])
  await saveCustomTagsToCloud(userId, project.customTagColors ?? {}, project.customTagIds ?? {})
}

export async function syncAllToCloud(userId, projects) {
  for (const project of projects) {
    await syncProjectToCloud(userId, project)
  }
}

export async function deleteProjectFromCloud(userId, projectId, noteIds = []) {
  // Notes (and their connections) go FIRST. notes.project_id is ON DELETE SET
  // NULL, so deleting the project row before its notes would null their
  // project_id — and a failure in between would leave them as unassigned
  // notes that the adoption path later re-homes into another project, the
  // opposite of what deleting a project means.
  if (noteIds.length) {
    const connResults = await Promise.all([
      supabase.from('connections').delete().eq('user_id', userId).in('from_note_id', noteIds),
      supabase.from('connections').delete().eq('user_id', userId).in('to_note_id', noteIds),
    ])
    const connFailed = connResults.find(r => r.error)
    if (connFailed) throw connFailed.error
    const { error: notesError } = await supabase.from('notes').delete().eq('user_id', userId).in('id', noteIds)
    if (notesError) throw notesError
  }
  const results = await Promise.all([
    supabase.from('bubbles').delete().eq('project_id', projectId).eq('user_id', userId),
    supabase.from('projects').delete().eq('id', projectId).eq('user_id', userId),
  ])
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
