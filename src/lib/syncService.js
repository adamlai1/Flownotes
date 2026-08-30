import { supabase } from './supabase'
import { generateId, connectionType, getNoteTitle } from '../utils/helpers'

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

// ── Tombstones ─────────────────────────────────────────────────────────────────
// The durable record that a note was deleted (supabase/tombstones.sql). The
// outbox op is only a device-local delivery queue; once the cloud DELETE lands
// it's discarded, and no other device can tell "deleted elsewhere" from "I made
// this offline" — which is how deleted notes resurrected via the whole-project
// upsert. Tombstones are written BEFORE the hard delete, so a crash in between
// leaves a tombstoned-but-live row that every reader treats as deleted (never
// the reverse).
//
// Conflict rule: a tombstone wins only when deleted_at is STRICTLY newer than
// the row's updated_at. A note edited after the deletion survives — with its
// edits — and its now-inert tombstone ages out. Ties favor the data.
//
// Until the migration is run the table doesn't exist; every helper degrades to
// today's behavior (no tombstones) rather than breaking sync, mirroring the
// missing-column handling above.

function isMissingTombstoneTable(error) {
  const text = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`
  return !!error && (
    error.code === '42P01' || error.code === 'PGRST205' ||
    (/tombstones/i.test(text) && /exist|find|schema/i.test(text))
  )
}

export const parseTs = iso => Date.parse(iso ?? '') || 0

// deletedAtMs is the moment the user actually deleted (the outbox op's `at`),
// not the replay time — an offline delete flushed hours later must not outrank
// edits made on another device in between.
export async function writeNoteTombstones(userId, noteIds, deletedAtMs) {
  if (!noteIds.length) return
  const deleted_at = new Date(deletedAtMs || Date.now()).toISOString()
  const rows = noteIds.map(id => ({ user_id: userId, kind: 'note', item_id: id, deleted_at }))
  const { error } = await supabase.from('tombstones').upsert(rows, { onConflict: 'user_id,kind,item_id' })
  if (error) {
    if (isMissingTombstoneTable(error)) {
      console.warn('[sync] tombstones table missing — run supabase/tombstones.sql. Deletes still work but cannot be protected from resurrection.')
      return
    }
    throw error
  }
}

// Map of note id → deleted_at (ms). Pass noteIds to scope the query to a push;
// omit for all of the user's note tombstones (the sign-in paths).
export async function loadNoteTombstones(userId, noteIds = null) {
  let query = supabase.from('tombstones')
    .select('item_id, deleted_at')
    .eq('user_id', userId)
    .eq('kind', 'note')
  if (noteIds) {
    if (!noteIds.length) return new Map()
    query = query.in('item_id', noteIds)
  }
  const { data, error } = await query
  if (error) {
    if (isMissingTombstoneTable(error)) return new Map()
    throw error
  }
  return new Map((data ?? []).map(t => [t.item_id, parseTs(t.deleted_at)]))
}

// The conflict rule, in one place. Strictly-newer: a tie keeps the note.
export function isNoteTombstoned(tombstones, note) {
  const deletedAt = tombstones.get(note.id)
  if (deletedAt == null) return false
  return deletedAt > parseTs(note.updated_at ?? note.created_at)
}

// Tombstones only need to outlive every device's next sync; 90 days is ample.
// Fire-and-forget housekeeping — a failure just leaves rows for next time.
export function pruneOldTombstones(userId) {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  supabase.from('tombstones')
    .delete().eq('user_id', userId).lt('deleted_at', cutoff)
    .then(({ error }) => {
      if (error && !isMissingTombstoneTable(error)) {
        console.warn('[sync] tombstone pruning failed (harmless):', error)
      }
    })
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
//
// Returns the notes actually pushed: local copies whose tombstone is newer
// than their updated_at are SUPPRESSED — this is the fix for resurrection via
// the whole-project upsert (a device that missed a deletion re-uploading its
// stale copy). A note edited after its deletion is pushed normally, per the
// conflict rule. Callers that push connections must use the returned list, or
// a connection row referencing a suppressed note would hit the notes FK.
export async function saveNotesToCloud(userId, projectId, notes) {
  if (!notes.length) return notes
  const tombstones = await loadNoteTombstones(userId, notes.map(n => n.id))
  const alive = tombstones.size
    ? notes.filter(n => !isNoteTombstoned(tombstones, n))
    : notes
  if (alive.length < notes.length) {
    console.log(`[sync] suppressed ${notes.length - alive.length} tombstoned note(s) from push`,
      notes.filter(n => !alive.includes(n)).map(n => n.id))
  }
  if (!alive.length) return alive
  const rows = alive.map(n => ({
    id: n.id, user_id: userId,
    project_id: projectId,
    // NULL means "derive from the first line" (see noteTitle in helpers);
    // only a manually-set title is stored. The column used to hold a derived
    // copy of the first line, which nothing ever read back.
    title: n.title ?? null,
    content: n.content ?? '',
    created_at: n.created_at, updated_at: n.updated_at,
    bubble_ids: n.bubble_ids ?? [], tags: n.tags ?? [],
    pinned: n.pinned ?? false,
    locked: n.locked ?? false,
  }))
  await upsertNotesGuarded(rows)
  return alive
}

// ── Guarded note upsert ─────────────────────────────────────────────────────────
// The push side of the stale-overwrite fix (supabase/notes_guarded_upsert.sql).
// A plain upsert is last-writer-wins: any device pushing its whole project can
// revert a note another device edited more recently. The RPC applies each row
// only where the stored updated_at is not newer than the incoming one, so the
// decision is atomic in Postgres — no read-then-write race, and no extra
// round-trip over the upsert it replaces.
//
// Ties (equal updated_at) DO write: locked/pinned/project_id changes
// deliberately don't bump updated_at (see setNoteLocked), and blocking ties
// would strand them — e.g. the adoption path persists project_id on otherwise
// untouched notes. An older copy still can never clobber a newer one, which is
// the destroyer this guards against.
//
// Until the migration is run the function doesn't exist; degrade to the
// unguarded upsert (today's behavior), mirroring the tombstone handling.

function isMissingGuardedUpsertFn(error) {
  const text = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`
  return !!error && (
    error.code === 'PGRST202' || error.code === '42883' ||
    (/upsert_notes_if_newer/i.test(text) && /exist|find|schema/i.test(text))
  )
}

async function upsertNotesGuarded(rows) {
  const { data: written, error } = await supabase.rpc('upsert_notes_if_newer', { rows })
  if (error) {
    if (!isMissingGuardedUpsertFn(error)) throw error
    console.warn('[sync] upsert_notes_if_newer missing — run supabase/notes_guarded_upsert.sql. Falling back to unguarded upsert (stale copies can overwrite newer ones).')
    return upsertRows('notes', rows, 'user_id,id', ['locked', 'project_id'])
  }
  if (typeof written === 'number' && written < rows.length) {
    console.log(`[sync] push guard: ${rows.length - written} stale note(s) not pushed — cloud copy is newer`)
  }
}

export async function saveConnectionsToCloud(userId, notes) {
  const rows = []
  const seen = new Set()
  for (const note of notes) {
    for (const conn of note.connections ?? []) {
      const key = `${note.id}:${conn.note_id}`
      if (!seen.has(key)) {
        seen.add(key)
        rows.push({
          // connections.id is text NOT NULL with NO default, so the client
          // must supply it — an omitted id 23502s every insert (the bug that
          // kept this table empty). New connections carry a generateId()
          // from the editor; a legacy object without one gets a stable id
          // derived from the pair it represents, so every re-sync upserts
          // the same row instead of multiplying.
          id: conn.id || key,
          user_id: userId,
          from_note_id: note.id,
          to_note_id: conn.note_id,
          // connectionType, not conn.type: editor-created connections carried
          // the label under relationship_type.
          relationship_type: connectionType(conn),
        })
      }
    }
  }
  const noteIds = notes.map(n => n.id)
  if (rows.length) {
    const { error } = await supabase.from('connections').upsert(rows, { onConflict: 'user_id,id' })
    if (error) throw error
  }
  if (noteIds.length) {
    // Upsert can't remove: clear rows for these source notes that no longer
    // exist locally, or a removed connection resurrects on the next load.
    // Runs AFTER the upsert so a failure here never leaves connections
    // missing — stale rows just survive until the next sync.
    let query = supabase.from('connections').delete().eq('user_id', userId).in('from_note_id', noteIds)
    if (rows.length) {
      query = query.not('id', 'in', `(${rows.map(r => `"${r.id}"`).join(',')})`)
    }
    const { error: staleError } = await query
    if (staleError) throw staleError
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
    { data: rawNotes, error: e3 },
    { data: connections, error: e4 },
    { data: customTags, error: e5 },
    tombstones,
  ] = await Promise.all([
    supabase.from('projects').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('bubbles').select('*').eq('user_id', userId),
    supabase.from('notes').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    supabase.from('connections').select('*').eq('user_id', userId),
    supabase.from('custom_tags').select('*').eq('user_id', userId),
    loadNoteTombstones(userId),
  ])

  if (e1 || e2 || e3 || e4 || e5) throw (e1 || e2 || e3 || e4 || e5)
  if (!projects?.length) return null

  // A tombstoned-but-live row is a deletion whose hard delete didn't land
  // (crash between tombstone write and DELETE) — treat it as deleted. A row
  // edited after its tombstone survives, per the conflict rule.
  const notes = tombstones.size
    ? (rawNotes ?? []).filter(n => !isNoteTombstoned(tombstones, n))
    : rawNotes

  // Opportunistic housekeeping, deliberately not awaited.
  pruneOldTombstones(userId)

  // Connection map: from_note_id → [{ note_id, type }]
  const connMap = {}
  for (const c of connections ?? []) {
    if (!connMap[c.from_note_id]) connMap[c.from_note_id] = []
    connMap[c.from_note_id].push({ id: c.id, note_id: c.to_note_id, type: c.relationship_type })
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
    // Legacy-title normalization: before titles became user-settable, every
    // sync stored a machine-derived copy of the first line in this column.
    // Deliberately handled HERE instead of a blanket UPDATE against every
    // user's rows: a stored title that matches what would be derived anyway
    // (under either the old first-line-verbatim formula or getNoteTitle's
    // first-non-empty-line) is a derived copy, not a choice — treat it as
    // NULL so the title keeps following the body. Self-cleaning: this
    // client re-uploads derived notes with title null, so the old copies
    // disappear from the cloud one sync at a time. Known ambiguity, accepted:
    // a custom title set to exactly the current first line reads as derived —
    // display-identical, diverging only if the first line later changes.
    const storedTitle = (n.title ?? '').trim()
    const oldDerived = (n.content?.split('\n')[0] ?? '').trim()
    const isCustomTitle = storedTitle &&
      storedTitle !== oldDerived &&
      storedTitle !== getNoteTitle(n.content ?? '')
    const note = {
      id: n.id, content: n.content ?? '',
      title: isCustomTitle ? storedTitle : null,
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
  // The project row is the root every other row FK-references — without it
  // nothing can land, so its failure is everyone's failure (fail fast).
  await saveProjectsToCloud(userId, [project])

  // The remaining entities are independent of each other (connections need
  // notes, so those two share a slot). One failing entity must not block the
  // rest — a connections error used to silently take custom tags down with
  // it. Every slot runs; every failure is logged; the first error is
  // re-thrown at the end so the dirty flag stays set and the project
  // retries, but everything independent has already had its chance.
  const errors = []
  const attempt = async (label, fn) => {
    try { await fn() } catch (e) {
      console.error(`[sync] ${label} failed for project ${project.id}:`, e)
      errors.push(e)
    }
  }
  await attempt('bubbles', () => saveBubblesToCloud(userId, project.id, project.bubbles ?? []))
  await attempt('notes+connections', async () => {
    const notes = project.notes ?? []
    // Connections push only what the notes push kept: a suppressed
    // (tombstoned) note must not appear as a connection source, and — the
    // connections FKs are real (composite_ids.sql) — no surviving note may
    // push a connection *pointing at* a suppressed note either, or the whole
    // connections upsert 23503s and the project retries forever.
    const alive = await saveNotesToCloud(userId, project.id, notes)
    const suppressed = new Set(notes.filter(n => !alive.includes(n)).map(n => n.id))
    const connSafe = suppressed.size
      ? alive.map(n => {
          const conns = (n.connections ?? []).filter(c => !suppressed.has(c.note_id))
          return conns.length === (n.connections?.length ?? 0) ? n : { ...n, connections: conns }
        })
      : alive
    await saveConnectionsToCloud(userId, connSafe)
  })
  await attempt('custom tags', () => saveCustomTagsToCloud(userId, project.customTagColors ?? {}, project.customTagIds ?? {}))
  if (errors.length) throw errors[0]
}

export async function syncAllToCloud(userId, projects) {
  for (const project of projects) {
    await syncProjectToCloud(userId, project)
  }
}

export async function deleteProjectFromCloud(userId, projectId, noteIds = [], deletedAtMs) {
  // Notes (and their connections) go FIRST. notes.project_id is ON DELETE SET
  // NULL, so deleting the project row before its notes would null their
  // project_id — and a failure in between would leave them as unassigned
  // notes that the adoption path later re-homes into another project, the
  // opposite of what deleting a project means.
  //
  // The notes get tombstones like any other note deletion (the legacy
  // seed-remap purge passes no noteIds, so remapped content is never
  // tombstoned). Project rows themselves are not tombstoned in this phase —
  // a stale device can re-upsert the project shell, but its deleted notes
  // stay dead.
  if (noteIds.length) {
    await writeNoteTombstones(userId, noteIds, deletedAtMs)
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

export async function deleteNotesFromCloud(userId, noteIds, deletedAtMs) {
  if (!noteIds.length) return
  // Tombstones FIRST: a failure after this point leaves tombstoned-but-live
  // rows, which every reader treats as deleted and the outbox retry finishes
  // off — never a deleted row with no record of the deletion.
  await writeNoteTombstones(userId, noteIds, deletedAtMs)
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
