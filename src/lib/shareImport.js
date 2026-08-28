import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'

// iOS Share Extension → Import screen hand-off.
//
// The extension (ios/share-extension-src) writes the shared text into App
// Group UserDefaults, then tries to foreground the app on SHARE_IMPORT_URL so
// Import opens immediately. That launch uses an UNSUPPORTED workaround (the
// LocalSend-style responder-chain call to UIApplication's modern open method);
// Apple has broken this pattern once already (iOS 18 kill-switched the old
// openURL: selector) and may break it again. So the launch is additive, never
// load-bearing: when it fails, the extension shows a "Saved — open Nubble to
// import" card and the app collects the payload on its next foreground, by
// any route. That fallback is why the mailbox is checked from every trigger
// below — URL open, launch URL, foregrounding, cold start — not just the URL.
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

  // Launch-succeeded path, app already running: the extension's open call
  // arrives here as a URL open.
  App.addListener('appUrlOpen', ({ url }) => {
    if (typeof url === 'string' && url.startsWith(SHARE_IMPORT_URL)) consume()
  })

  // Launch-succeeded path, cold start: iOS may deliver the URL only as the
  // launch URL, not as an appUrlOpen event (same caveat as initNativeAuth).
  // Redundant with the unconditional consume() above, and safely so — take()
  // is read-and-clear, so a second check finds an empty mailbox.
  App.getLaunchUrl()
    .then(result => {
      if (result?.url?.startsWith(SHARE_IMPORT_URL)) consume()
    })
    .catch(() => {})
}
