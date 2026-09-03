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

const VoiceCapture = registerPlugin('VoiceCapture')

// (captures) => Promise<string[]> — persists the captures it can and resolves
// with the ids that are now safe to delete from the queue.
let consumer = null
let inFlight = false
let runAgain = false

async function drain() {
  if (!Capacitor.isNativePlatform()) return
  if (!consumer) return // not ready to own captures — they stay queued
  if (inFlight) { runAgain = true; return }
  inFlight = true
  try {
    const { captures } = await VoiceCapture.list()
    const valid = (Array.isArray(captures) ? captures : []).filter(c =>
      c && typeof c.id === 'string' && c.id && typeof c.text === 'string' && c.text.trim()
    )
    if (valid.length && consumer) {
      const acked = await consumer(valid)
      const ids = (Array.isArray(acked) ? acked : []).filter(id => typeof id === 'string' && id)
      if (ids.length) await VoiceCapture.ack({ ids })
    }
  } catch (e) {
    // Leave everything queued; the next trigger retries.
    console.warn('[voice] drain failed — captures stay queued:', e)
  } finally {
    inFlight = false
    if (runAgain) { runAgain = false; drain() }
  }
}

// Subscribe the consumer. Drains immediately (anything queued while we were
// not ready) and on every later trigger until unsubscribed.
export function onVoiceCaptures(cb) {
  consumer = cb
  drain()
  return () => { if (consumer === cb) consumer = null }
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
