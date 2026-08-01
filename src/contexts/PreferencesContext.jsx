import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { useAuth } from './AuthContext'
import { loadPreferencesFromCloud, savePreferencesToCloud } from '../lib/syncService'

// Display preferences that aren't the theme (kept separate from ThemeContext so each
// context stays single-concern). Currently just the bubble-view note card size.
//
// localStorage is the always-available copy (instant load, guest mode, offline). When
// the user is signed in, the cloud row (user_preferences) is the source of truth: it's
// pulled on sign-in and written on every change, mirroring how notes sync.

const NOTE_SIZES = ['small', 'medium', 'large']
const STORAGE_KEY = 'mindmap-note-size'

// Multiplier applied to a note card's base radius in the bubble view. 'small' is the
// original size; the layout's spacing/packing all key off each item's radius, so these
// scale the whole card (and its text) proportionally.
export const NOTE_SIZE_SCALE = { small: 1, medium: 1.3, large: 1.6 }

const PreferencesContext = createContext({ noteSize: 'small', setNoteSize: () => {} })

export function PreferencesProvider({ children }) {
  const { user } = useAuth()
  const [noteSize, setNoteSizeState] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return NOTE_SIZES.includes(saved) ? saved : 'small'
  })
  // Avoid re-pulling for a user we've already synced this session.
  const syncedUserRef = useRef(null)

  // On sign-in, adopt the cloud value (source of truth). If the user has no row yet,
  // seed it with the current local value. Failures (table missing, offline) are
  // ignored — the local copy keeps working.
  useEffect(() => {
    if (!user) { syncedUserRef.current = null; return }
    if (syncedUserRef.current === user.id) return
    syncedUserRef.current = user.id
    let cancelled = false
    ;(async () => {
      try {
        const remote = await loadPreferencesFromCloud(user.id)
        if (cancelled) return
        if (remote && NOTE_SIZES.includes(remote.note_size)) {
          setNoteSizeState(remote.note_size)
          localStorage.setItem(STORAGE_KEY, remote.note_size)
        } else {
          // No saved preference yet — push the current local one up.
          await savePreferencesToCloud(user.id, { note_size: localStorage.getItem(STORAGE_KEY) || 'small' })
        }
      } catch {
        // Keep the local value; a later change will retry the write.
      }
    })()
    return () => { cancelled = true }
  }, [user])

  function setNoteSize(size) {
    if (!NOTE_SIZES.includes(size)) return
    setNoteSizeState(size)
    localStorage.setItem(STORAGE_KEY, size)
    if (user) {
      savePreferencesToCloud(user.id, { note_size: size }).catch(() => {})
    }
  }

  return (
    <PreferencesContext.Provider value={{ noteSize, setNoteSize }}>
      {children}
    </PreferencesContext.Provider>
  )
}

export const usePreferences = () => useContext(PreferencesContext)
