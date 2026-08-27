import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'

// iOS Share Extension → Import screen hand-off.
//
// The extension (ios/App/ShareExtension) writes the shared text into App Group
// UserDefaults and opens the app with this trigger URL. The text itself never
// rides in the URL — multi-thousand-word notes would risk truncation — so the
// URL is only a "go look in the mailbox" signal. SharedImportPlugin (native,
// registered in MainViewController) is the mailbox: its take() reads the
// payload AND clears it in the same call, so a payload can never be read twice.
export const SHARE_IMPORT_URL = 'com.adamlai.flownotes://share-import'

// A payload older than this is abandoned: the share happened but the app was
// never opened by it (openURL from an extension can fail silently on some
// hosts). Stale text must not leak into a later, unrelated import.
const MAX_PAYLOAD_AGE_MS = 5 * 60 * 1000

const SharedImport = registerPlugin('SharedImport')

// The share can arrive before App.jsx has mounted (cold start), so deliveries
// are buffered until a listener subscribes.
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
// initNativeAuth) so the listener exists no matter when iOS delivers the URL.
export function initShareImport() {
  if (!Capacitor.isNativePlatform()) return

  // Warm path: app already running (foreground or background) when the share
  // fires — iOS delivers the trigger URL as an event.
  App.addListener('appUrlOpen', ({ url }) => {
    if (typeof url === 'string' && url.startsWith(SHARE_IMPORT_URL)) consume()
  })

  // Cold path: launched by the trigger URL → consume the payload. Launched any
  // other way (icon tap, notification, auth callback…) → any payload sitting
  // in the App Group is an orphan from a share that never opened the app;
  // take() it and drop the result so it's cleared rather than left to leak
  // into a future import.
  App.getLaunchUrl()
    .then(result => {
      if (result?.url && result.url.startsWith(SHARE_IMPORT_URL)) return consume()
      return SharedImport.take().then(() => {}, () => {})
    })
    .catch(() => {})
}
