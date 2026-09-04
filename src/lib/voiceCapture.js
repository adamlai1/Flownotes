import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'

// iOS Siri / Shortcuts voice capture → root-level notes.
//
// AddNoteIntent (ios/voice-capture-src) runs in the background — Nubble is
// launched without a scene if it isn't running, so there is no web layer to
// talk to — and writes each spoken note as its own file in the App Group
// queue (VoiceCaptureStore in ios/App/App/SceneDelegate.swift). This module
// drains that queue into the active project.
//
// Two rules, both about not losing what someone said:
//
// 1. Two-phase, never read-and-clear. list() is read-only; ack(ids) deletes.
//    The consumer persists the notes to localStorage FIRST and returns the ids
//    it persisted; only those are acked. A crash in between just means the
//    same captures are listed again — and since the capture id is the note
//    id, re-delivery is idempotent (the consumer skips ids it already has).
//
// 2. The queue is the buffer. Captures are consumed only while a consumer is
//    subscribed, and App.jsx subscribes only once the app is actually ready
//    to own them: past the login gate, and — for a signed-in user — after the
//    initial cloud sync has settled. A capture that landed in the local
//    default project while the user was still on the login screen would be
//    local-only work from the merge dialog's point of view, and "use cloud"
//    would discard it. Holding it in the App Group until the merge question
//    has been answered is what makes that impossible. Nothing here expires:
//    a capture waits as long as it has to.
//
// Web/PWA builds have no native queue; every entry point is a no-op there.
//
// Diagnostics: everything this module does is mirrored into a status object
// that Settings renders as the "Siri capture" panel, so the gate's state, the
// queue depth and the last drain's outcome can be read off the screen
// instead of out of Console.app.

const VoiceCapture = registerPlugin('VoiceCapture')

// (captures) => Promise<string[]> — persists the captures it can and resolves
// with the ids that are now safe to delete from the queue.
let consumer = null
let inFlight = false
let runAgain = false

// ── Status mirror ────────────────────────────────────────────────────────────

const status = {
  native: Capacitor.isNativePlatform(),
  // Set by App.jsx: { ready, reason } — reason is null when ready, otherwise
  // the specific condition holding the gate shut.
  gate: { ready: false, reason: 'app not mounted yet' },
  consumer: false,
  // Last observed queue depth (from a drain or a peek); null = never read.
  queue: null,
  drains: 0,
  lastDrainAt: null,
  lastListed: 0,
  lastAcked: 0,
  lastError: null,
  // Set when list() itself rejects — e.g. the native plugin isn't registered.
  pluginError: null,
}
const watchers = new Set()
function emit() {
  const snap = { ...status, gate: { ...status.gate } }
  for (const w of watchers) w(snap)
}

export function getVoiceCaptureStatus() {
  return { ...status, gate: { ...status.gate } }
}

export function subscribeVoiceCaptureStatus(cb) {
  watchers.add(cb)
  cb(getVoiceCaptureStatus())
  return () => { watchers.delete(cb) }
}

// App.jsx reports the readiness gate here so the panel can show WHY the queue
// isn't being drained, not just that it isn't.
export function setVoiceGate(gate) {
  status.gate = { ready: Boolean(gate?.ready), reason: gate?.reason ?? null }
  emit()
}

// Read-only look at the queue (list() never deletes). Safe to call from the
// panel at any time, gate open or shut.
export async function peekVoiceQueue() {
  if (!status.native) return null
  try {
    const { captures } = await VoiceCapture.list()
    status.queue = Array.isArray(captures) ? captures.length : 0
    status.pluginError = null
  } catch (e) {
    status.pluginError = String(e?.message ?? e)
  }
  emit()
  return status.queue
}

// ── Draining ─────────────────────────────────────────────────────────────────

async function drain() {
  if (!Capacitor.isNativePlatform()) return
  if (!consumer) return // not ready to own captures — they stay queued
  if (inFlight) { runAgain = true; return }
  inFlight = true
  status.drains += 1
  status.lastDrainAt = Date.now()
  status.lastError = null
  try {
    const { captures } = await VoiceCapture.list()
    status.pluginError = null
    const all = Array.isArray(captures) ? captures : []
    status.queue = all.length
    const valid = all.filter(c =>
      c && typeof c.id === 'string' && c.id && typeof c.text === 'string' && c.text.trim()
    )
    status.lastListed = valid.length
    status.lastAcked = 0
    if (valid.length && consumer) {
      const acked = await consumer(valid)
      const ids = (Array.isArray(acked) ? acked : []).filter(id => typeof id === 'string' && id)
      if (ids.length) {
        await VoiceCapture.ack({ ids })
        status.lastAcked = ids.length
        status.queue = Math.max(0, all.length - ids.length)
      }
    }
  } catch (e) {
    // Leave everything queued; the next trigger retries.
    console.warn('[voice] drain failed — captures stay queued:', e)
    status.lastError = String(e?.message ?? e)
    if (status.lastListed === 0) status.pluginError = status.lastError
  } finally {
    inFlight = false
    emit()
    if (runAgain) { runAgain = false; drain() }
  }
}

// Manual trigger for the Settings panel. Same gate as every other trigger:
// with no consumer subscribed this is a no-op and the panel says so.
export function drainVoiceCaptures() {
  return drain()
}

// Subscribe the consumer. Drains immediately (anything queued while we were
// not ready) and on every later trigger until unsubscribed.
export function onVoiceCaptures(cb) {
  consumer = cb
  status.consumer = true
  emit()
  drain()
  return () => {
    if (consumer === cb) {
      consumer = null
      status.consumer = false
      emit()
    }
  }
}

// Called once at module-load time from main.jsx, alongside initShareImport,
// so no trigger can fire before the listeners exist.
export function initVoiceCapture() {
  if (!Capacitor.isNativePlatform()) return

  // Cold start: the consumer isn't subscribed yet, so this is a no-op today —
  // it's the onVoiceCaptures() subscription that drains. Kept so the trigger
  // set mirrors shareImport.js and stays obviously complete.
  drain()

  // Warm path: notes were spoken while Nubble was in the background; the
  // user coming back is the signal.
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) drain()
  })

  // Same-process path: the intent ran inside an already-running Nubble and
  // the plugin relayed VoiceCaptureStore's notification. Lands the note
  // without waiting for a foreground transition.
  VoiceCapture.addListener('captured', () => { drain() })
}
