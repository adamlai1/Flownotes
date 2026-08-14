import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { useAuth } from './AuthContext'
import { loadPreferencesFromCloud, savePreferencesToCloud } from '../lib/syncService'

// Display preferences that aren't the theme (kept separate from ThemeContext so each
// context stays single-concern). Currently just the bubble-view note card size.
//
// localStorage is the always-available copy (instant load, guest mode, offline). When
// the user is signed in, the cloud row (user_preferences) is the source of truth: it's
// pulled on sign-in and written on every change, mirroring how notes sync.
//
// The size is kept PER DEVICE CLASS (desktop / mobile), classified by the same
// 768px breakpoint the responsive layout uses, so a laptop and a phone each keep
// their own size and the preference follows the user across devices of the same
// class. Both values live together: as JSON under the existing localStorage key,
// and as JSON in the existing note_size column.

const NOTE_SIZES = ['small', 'medium', 'large']
const STORAGE_KEY = 'mindmap-note-size'

// Same breakpoint the layout uses everywhere (isDesktop in App, NoteEditor…).
const DEVICE_CLASS_QUERY = '(min-width: 768px)'

function currentDeviceClass() {
  return window.matchMedia(DEVICE_CLASS_QUERY).matches ? 'desktop' : 'mobile'
}

// Parse a stored preference: either the {desktop, mobile} shape or a legacy
// single value, which is credited to `legacyClass` — the class of the device
// it's being read on, since that's where it was chosen. A class with no stored
// value stays absent here; readers fall back to the default, never to the
// other class's value.
function parseSizes(raw, legacyClass) {
  if (!raw) return {}
  if (NOTE_SIZES.includes(raw)) return { [legacyClass]: raw }
  try {
    const obj = JSON.parse(raw)
    const out = {}
    if (NOTE_SIZES.includes(obj?.desktop)) out.desktop = obj.desktop
    if (NOTE_SIZES.includes(obj?.mobile)) out.mobile = obj.mobile
    return out
  } catch {
    return {}
  }
}

// Multiplier applied to a note card's base radius in the bubble view. 'small' is the
// original size; the layout's spacing/packing all key off each item's radius, so these
// scale the whole card (and its text) proportionally.
export const NOTE_SIZE_SCALE = { small: 1, medium: 1.3, large: 1.6 }

const PreferencesContext = createContext({ noteSize: 'small', setNoteSize: () => {} })

export function PreferencesProvider({ children }) {
  const { user } = useAuth()
  const [deviceClass, setDeviceClass] = useState(currentDeviceClass)
  const [sizes, setSizes] = useState(() =>
    parseSizes(localStorage.getItem(STORAGE_KEY), currentDeviceClass())
  )
  // Always-current copy for callbacks that shouldn't capture stale state.
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes
  // Avoid re-pulling for a user we've already synced this session.
  const syncedUserRef = useRef(null)

  // A window resized across the breakpoint switches to the size of the class
  // it is now in.
  useEffect(() => {
    const mq = window.matchMedia(DEVICE_CLASS_QUERY)
    const handler = e => setDeviceClass(e.matches ? 'desktop' : 'mobile')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // On sign-in, adopt the cloud values (source of truth), per class: a class the
  // cloud row doesn't cover keeps the local value rather than being reset. The
  // merged pair is pushed back up so the row always carries both classes. If the
  // user has no row yet, seed it with the current local values. Failures (table
  // missing, offline) are ignored — the local copy keeps working.
  useEffect(() => {
    if (!user) { syncedUserRef.current = null; return }
    if (syncedUserRef.current === user.id) return
    syncedUserRef.current = user.id
    let cancelled = false
    ;(async () => {
      try {
        const remote = await loadPreferencesFromCloud(user.id)
        if (cancelled) return
        const remoteSizes = parseSizes(remote?.note_size, currentDeviceClass())
        const merged = { ...sizesRef.current, ...remoteSizes }
        setSizes(merged)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
        await savePreferencesToCloud(user.id, { note_size: JSON.stringify(merged) })
      } catch {
        // Keep the local value; a later change will retry the write.
      }
    })()
    return () => { cancelled = true }
  }, [user])

  function setNoteSize(size) {
    if (!NOTE_SIZES.includes(size)) return
    // Live read, not the deviceClass state — a resize this instant still lands
    // the choice on the class the window is actually in.
    const merged = { ...sizesRef.current, [currentDeviceClass()]: size }
    setSizes(merged)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    if (user) {
      savePreferencesToCloud(user.id, { note_size: JSON.stringify(merged) }).catch(() => {})
    }
  }

  const noteSize = sizes[deviceClass] ?? 'small'

  return (
    <PreferencesContext.Provider value={{ noteSize, setNoteSize }}>
      {children}
    </PreferencesContext.Provider>
  )
}

export const usePreferences = () => useContext(PreferencesContext)
