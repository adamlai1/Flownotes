import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { useAuth } from './AuthContext'
import { loadPreferencesFromCloud, savePreferencesToCloud } from '../lib/syncService'

// Display and gesture preferences that aren't the theme (kept separate from
// ThemeContext so each context stays single-concern): bubble-view note card
// size, bouncy animations, and quick create.
//
// All three follow one storage story. localStorage is the always-available copy
// (instant load, guest mode, offline). When the user is signed in, the cloud row
// (user_preferences) is the source of truth: it's pulled on sign-in and written
// on every change, mirroring how notes sync. Per field, the merge on sign-in is:
// a cloud value wins and is written locally; a cloud NULL ("no choice on this
// account yet") is seeded from the device's local explicit choice, if any.
//
// Sign-out deliberately does NOT sweep any of these (clearAllProjectData leaves
// them alone): they're device habits as much as account settings, and a
// signed-out device keeps behaving the way it last did. The one guard that
// makes that safe is the OWNER STAMP (PREFS_OWNER_KEY): the id of the account
// the local values were last synced with. When a DIFFERENT account signs in on
// the device, that residue is not seeded into the new account's row and is
// replaced by the new account's values (or reset to the default where the new
// account has no choice yet). Without it, one account's habits would leak into
// the next account's cloud row through the seed-on-NULL rule.
//
// Note size is kept PER DEVICE CLASS (desktop / mobile), classified by the same
// 768px breakpoint the responsive layout uses, so a laptop and a phone each keep
// their own size and the preference follows the user across devices of the same
// class. Both values live together: as JSON under the localStorage key, and as
// JSON in the note_size column.

const NOTE_SIZES = ['small', 'medium', 'large']
const STORAGE_KEY = 'mindmap-note-size'

// Bouncy animations: '1' / '0' once the user has touched the toggle; absent =
// untouched, and the default then follows the system reduced-motion setting
// live. Cloud column `bouncy` (supabase/preferences_sync.sql): true / false /
// NULL with the same three meanings.
const BOUNCY_KEY = 'mindmap-bouncy'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

// Quick create: '1' = the + button's tap creates a note directly and only the
// hold creates a bubble (the original gesture model); '0' / absent = the tap
// expands into Note and Bubble tiles, hold still creates a bubble. Cloud column
// `quick_create`: true / false / NULL. Default off.
const QUICK_CREATE_KEY = 'mindmap-quick-create'

// The account the local values were last synced with (see header).
const PREFS_OWNER_KEY = 'mindmap-prefs-owner'

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

// A local tri-state flag: '1' / '0' / null (untouched).
function readFlag(key) {
  const v = localStorage.getItem(key)
  return v === '1' || v === '0' ? v : null
}
function writeFlag(key, v) {
  if (v === null) localStorage.removeItem(key)
  else localStorage.setItem(key, v)
}
// Cloud boolean → local flag. Anything but a real boolean is "no choice".
function flagFromCloud(v) {
  return v === true ? '1' : v === false ? '0' : null
}

// Multiplier applied to a note card's base radius in the bubble view. 'small' is the
// original size; the layout's spacing/packing all key off each item's radius, so these
// scale the whole card (and its text) proportionally.
export const NOTE_SIZE_SCALE = { small: 1, medium: 1.3, large: 1.6 }

const PreferencesContext = createContext({
  noteSize: 'medium', setNoteSize: () => {},
  bouncy: true, setBouncy: () => {},
  quickCreate: false, setQuickCreate: () => {},
})

export function PreferencesProvider({ children }) {
  const { user } = useAuth()
  const [deviceClass, setDeviceClass] = useState(currentDeviceClass)
  const [sizes, setSizes] = useState(() =>
    parseSizes(localStorage.getItem(STORAGE_KEY), currentDeviceClass())
  )
  // 'null' = untouched (follow the system), '1' / '0' = explicit choice.
  const [bouncyPref, setBouncyPref] = useState(() => readFlag(BOUNCY_KEY))
  const [quickCreatePref, setQuickCreatePref] = useState(() => readFlag(QUICK_CREATE_KEY))
  // Always-current copies for the sign-in merge, which must not capture stale state.
  const localRef = useRef(null)
  localRef.current = { sizes, bouncyPref, quickCreatePref }
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

  // Keyed on the user ID, not the user object. On web the auth provider sets
  // the user twice at page load (getSession, then supabase-js's INITIAL_SESSION
  // event) — same account, two object identities. Keyed on the object, the
  // second update cancelled the first run's in-flight load and the guard then
  // blocked the re-run, so the cloud row was never applied on web. The same
  // race hit StrictMode's double-invoke on the dev server. Two changes: the
  // ID dependency means a same-account identity change is not a re-run at
  // all, and a cancelled run hands the guard back so a genuine re-run reloads
  // instead of being blocked.
  const userId = user?.id ?? null

  // On sign-in, adopt the cloud values (source of truth), per field: a cloud
  // value is taken; a cloud NULL keeps the local choice and pushes it up, so the
  // row ends up carrying everything the device knew — UNLESS the local values
  // belong to a different account (owner stamp), in which case they're dropped
  // rather than seeded, and the new account's NULLs reset the device to the
  // default. Failures (table or column missing, offline) are ignored — the
  // local copy keeps working, and a later change retries the write. The load
  // itself degrades per column (see syncService), so an un-migrated account
  // still syncs note_size while the two flags stay device-local.
  useEffect(() => {
    if (!userId) { syncedUserRef.current = null; return }
    if (syncedUserRef.current === userId) return
    syncedUserRef.current = userId
    let cancelled = false
    ;(async () => {
      try {
        const remote = await loadPreferencesFromCloud(userId)
        if (cancelled) return
        const owner = localStorage.getItem(PREFS_OWNER_KEY)
        const foreign = !!owner && owner !== userId
        const local = foreign
          ? { sizes: {}, bouncyPref: null, quickCreatePref: null }
          : localRef.current
        const push = {}

        // Note size — per class.
        const remoteSizes = parseSizes(remote?.note_size, currentDeviceClass())
        const mergedSizes = { ...local.sizes, ...remoteSizes }
        setSizes(mergedSizes)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedSizes))
        push.note_size = JSON.stringify(mergedSizes)

        // Bouncy / quick create — tri-state flags. Only the columns the row
        // actually carried are considered synced; an un-migrated row simply
        // has no such key (see selectPreferences), and the local flag stands.
        const flags = [
          ['bouncy', BOUNCY_KEY, local.bouncyPref, setBouncyPref],
          ['quick_create', QUICK_CREATE_KEY, local.quickCreatePref, setQuickCreatePref],
        ]
        for (const [col, key, localFlag, set] of flags) {
          const cloud = flagFromCloud(remote?.[col])
          if (cloud !== null) {
            set(cloud)
            writeFlag(key, cloud)
          } else {
            set(localFlag)
            writeFlag(key, localFlag)
            if (localFlag !== null) push[col] = localFlag === '1'
          }
        }

        localStorage.setItem(PREFS_OWNER_KEY, userId)
        await savePreferencesToCloud(userId, push)
      } catch {
        // Keep the local values; a later change will retry the write.
      }
    })()
    return () => {
      cancelled = true
      // A cancelled run never applied anything: give the guard back so the
      // next run for this user loads instead of assuming it was done.
      if (syncedUserRef.current === userId) syncedUserRef.current = null
    }
  }, [userId])

  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches
  )
  // Follow the OS setting live, but only the DEFAULT tracks it — an explicit
  // toggle choice overrides in either direction and stops listening mattering.
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION_QUERY)
    const handler = e => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Write a flag locally and, signed in, to the cloud (stamping the owner so a
  // later sign-in by someone else knows whose choice this was).
  function setFlag(key, col, set, value) {
    const v = value ? '1' : '0'
    set(v)
    writeFlag(key, v)
    if (user) {
      localStorage.setItem(PREFS_OWNER_KEY, user.id)
      savePreferencesToCloud(user.id, { [col]: !!value }).catch(() => {})
    }
  }
  function setBouncy(value) { setFlag(BOUNCY_KEY, 'bouncy', setBouncyPref, value) }
  function setQuickCreate(value) { setFlag(QUICK_CREATE_KEY, 'quick_create', setQuickCreatePref, value) }

  const bouncy = bouncyPref === null ? !reducedMotion : bouncyPref === '1'
  const quickCreate = quickCreatePref === '1'

  function setNoteSize(size) {
    if (!NOTE_SIZES.includes(size)) return
    // Live read, not the deviceClass state — a resize this instant still lands
    // the choice on the class the window is actually in.
    const merged = { ...localRef.current.sizes, [currentDeviceClass()]: size }
    setSizes(merged)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    if (user) {
      localStorage.setItem(PREFS_OWNER_KEY, user.id)
      savePreferencesToCloud(user.id, { note_size: JSON.stringify(merged) }).catch(() => {})
    }
  }

  // The default for a class with no stored value. Never written anywhere —
  // storage only ever holds explicit choices, so this is a default, not a
  // migration: a user who deliberately picked 'small' has it stored and keeps it.
  const noteSize = sizes[deviceClass] ?? 'medium'

  return (
    <PreferencesContext.Provider value={{ noteSize, setNoteSize, bouncy, setBouncy, quickCreate, setQuickCreate }}>
      {children}
    </PreferencesContext.Provider>
  )
}

export const usePreferences = () => useContext(PreferencesContext)
