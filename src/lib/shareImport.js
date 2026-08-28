import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'

// iOS Share Extension → Import screen hand-off.
//
// The extension (ios/share-extension-src) writes the shared text into App
// Group UserDefaults and shows a brief "Saved — open Nubble to import" card;
// the user then foregrounds the app themselves. Share extensions cannot open
// their containing app on modern iOS — since iOS 18 UIKit force-fails the old
// responder-chain openURL: hack, and Apple provides no supported alternative —
// so the mailbox is checked on every cold start and every return to the
// foreground rather than on a trigger URL.
//
// SharedImportPlugin (native, registered in SceneDelegate.swift) is the
// mailbox: its take() reads the payload AND clears it in the same call, so a
// payload can never be read twice, and checking from several triggers is safe.
export const SHARE_IMPORT_URL = 'com.adamlai.flownotes://share-import'

// Staleness is purely time-based: a payload this old is an abandoned share
// (the user never came back to the app), and is cleared unused rather than
// surfacing days later in an unrelated session. Ten minutes comfortably covers
// "share, get briefly distracted, switch to Nubble".
const MAX_PAYLOAD_AGE_MS = 10 * 60 * 1000

const SharedImport = registerPlugin('SharedImport')

// The payload can arrive before App.jsx has mounted (cold start), so
// deliveries are buffered until a listener subscribes.
let listener = null
let pending = null

function deliver(text) {
  if (listener) listener(text)
  else pending = text
}

export function onShareImport(cb) {
  listener = cb
  if (pending !== null) {
    const text = pending
    pending = null
    cb(text)
  }
  return () => { if (listener === cb) listener = null }
}

// Read-and-clear. Returns the text only when the payload is fresh; either way
// the native side has already wiped it.
async function takePayload() {
  try {
    const { text, ts } = await SharedImport.take()
    if (!text) return null
    if (ts && Date.now() - ts > MAX_PAYLOAD_AGE_MS) return null
    return text
  } catch {
    return null
  }
}

async function consume() {
  const text = await takePayload()
  if (text) deliver(text)
}

// Called once at module-load time from main.jsx (same pattern as
// initNativeAuth) so no delivery route can fire before we're listening.
export function initShareImport() {
  if (!Capacitor.isNativePlatform()) return

  // Cold start, by any route — a fresh payload means "the user just shared
  // and is coming back for it"; a stale one is cleared by the same take().
  consume()

  // Warm path: app was backgrounded when the share happened; the user
  // switching back is the signal.
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) consume()
  })

  // Future-proofing only: no code sends this URL today, but if Apple ever
  // ships a sanctioned way for extensions to open their app, this is the
  // contract the extension would use.
  App.addListener('appUrlOpen', ({ url }) => {
    if (typeof url === 'string' && url.startsWith(SHARE_IMPORT_URL)) consume()
  })
}
