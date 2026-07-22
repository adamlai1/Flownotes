// Durable offline queue.
//
// The cloud sync is an upsert of the WHOLE project, so it can express "these things
// exist" but never "this thing was removed" — a delete only reaches Supabase via an
// immediate delete call. If that call is lost (offline, tab closed), the row survives
// in the cloud and reappears on the next load. So deletes are recorded here as
// tombstones and replayed until they succeed.
//
// Edits need no tombstone: we just remember WHICH projects are dirty and re-push their
// current local state at flush time. That makes a flush idempotent and always carries
// the newest data, however many edits piled up while offline.
import { generateId } from '../utils/helpers'
import { loadProject } from '../utils/storage'
import {
  syncProjectToCloud,
  deleteNotesFromCloud,
  deleteBubblesFromCloud,
  deleteCustomTagFromCloud,
  deleteProjectFromCloud,
} from './syncService'

const KEY = 'mindmap-outbox'

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY))
    if (!raw || typeof raw !== 'object') return { ops: [], dirty: [] }
    return { ops: Array.isArray(raw.ops) ? raw.ops : [], dirty: Array.isArray(raw.dirty) ? raw.dirty : [] }
  } catch {
    return { ops: [], dirty: [] }
  }
}

function write(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch {}
}

// Ops carry the userId they were created under, so signing in as someone else can
// never replay the previous account's deletions.
export function enqueueDelete(userId, op) {
  if (!userId || !op) return
  const state = read()
  state.ops.push({ ...op, id: generateId(), userId, at: Date.now() })
  write(state)
}

export function markProjectDirty(userId, projectId) {
  if (!userId || !projectId) return
  const state = read()
  if (!state.dirty.some(d => d.userId === userId && d.projectId === projectId)) {
    state.dirty.push({ userId, projectId })
    write(state)
  }
}

// Dropping a deleted project's dirty flag stops the flush from re-uploading it.
export function clearProjectDirty(userId, projectId) {
  const state = read()
  const next = state.dirty.filter(d => !(d.userId === userId && d.projectId === projectId))
  if (next.length !== state.dirty.length) write({ ...state, dirty: next })
}

export function hasPending(userId) {
  if (!userId) return false
  const state = read()
  return state.ops.some(o => o.userId === userId) || state.dirty.some(d => d.userId === userId)
}

export function pendingCount(userId) {
  if (!userId) return 0
  const state = read()
  return state.ops.filter(o => o.userId === userId).length
    + state.dirty.filter(d => d.userId === userId).length
}

async function applyOp(userId, op) {
  switch (op.kind) {
    case 'notes':   return deleteNotesFromCloud(userId, op.noteIds ?? [])
    case 'bubbles': return deleteBubblesFromCloud(userId, op.bubbleIds ?? [])
    case 'tag':     return deleteCustomTagFromCloud(userId, op.tagName)
    case 'project': return deleteProjectFromCloud(userId, op.projectId, op.noteIds ?? [])
    default:        return undefined // unknown kind (older build) — drop it
  }
}

// Replay everything queued for this user: tombstones first (matching the original
// "delete from the cloud, then push what's left" ordering), then a full push of each
// dirty project from its CURRENT local state.
//
// Each item is removed from the queue only after its call succeeds, and the queue is
// re-read each round so work enqueued mid-flush isn't lost. Throws on the first
// failure, leaving everything still-pending in place for the next attempt.
export async function flushOutbox(userId) {
  if (!userId) return 0
  let done = 0

  for (;;) {
    const op = read().ops.find(o => o.userId === userId)
    if (!op) break
    await applyOp(userId, op)
    const state = read()
    write({ ...state, ops: state.ops.filter(o => o.id !== op.id) })
    done++
  }

  for (;;) {
    const entry = read().dirty.find(d => d.userId === userId)
    if (!entry) break
    const project = loadProject(entry.projectId)
    // A project deleted locally has nothing left to push — just clear the flag.
    if (project) await syncProjectToCloud(userId, project)
    const state = read()
    write({
      ...state,
      dirty: state.dirty.filter(d => !(d.userId === userId && d.projectId === entry.projectId)),
    })
    done++
  }

  return done
}
