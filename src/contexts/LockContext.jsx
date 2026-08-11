import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useAuth } from './AuthContext'
import { hashPassword, generateSalt } from '../utils/locks'
import { loadPreferencesFromCloud, savePreferencesToCloud } from '../lib/syncService'
import PasswordModal from '../components/PasswordModal'

// Owns the lock password and the set of items unlocked in THIS session, and renders
// every password prompt itself — so any component can ask for an unlock without
// plumbing modal state through the tree.
//
// The password is stored as a salted hash (see utils/locks.js), in localStorage
// always and in the user_preferences cloud row when signed in, mirroring how the
// note-size preference syncs. `unlockedIds` is plain React state and is therefore
// gone on reload: unlocked items relock when the app is closed and reopened.

const STORAGE_KEY = 'mindmap-lock'

const LockContext = createContext(null)

function loadLockRecord() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return raw?.hash && raw?.salt ? { hash: raw.hash, salt: raw.salt } : null
  } catch {
    return null
  }
}

function saveLockRecord(record) {
  try {
    if (record) localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

export function LockProvider({ children, onRemoveAllLocks }) {
  const { user } = useAuth()
  const [lockRecord, setLockRecord] = useState(loadLockRecord)
  const [unlockedIds, setUnlockedIds] = useState(() => new Set())
  // prompt: null | { mode, title, message, confirmLabel, destructive, validate, submit }
  const [prompt, setPrompt] = useState(null)
  const syncedUserRef = useRef(null)
  const lockRecordRef = useRef(lockRecord)
  lockRecordRef.current = lockRecord

  const hasPassword = !!lockRecord

  // On sign-in the cloud row is the source of truth (same rule as preferences), so
  // a password set on one device applies on the others. Failures are ignored — the
  // local copy keeps working offline / when the columns aren't migrated yet.
  useEffect(() => {
    if (!user) { syncedUserRef.current = null; return }
    if (syncedUserRef.current === user.id) return
    syncedUserRef.current = user.id
    let cancelled = false
    ;(async () => {
      try {
        const remote = await loadPreferencesFromCloud(user.id)
        if (cancelled) return
        if (remote?.lock_hash && remote?.lock_salt) {
          const record = { hash: remote.lock_hash, salt: remote.lock_salt }
          setLockRecord(record)
          saveLockRecord(record)
        } else if (lockRecordRef.current) {
          // No cloud password yet — seed it from this device's.
          await savePreferencesToCloud(user.id, {
            lock_hash: lockRecordRef.current.hash,
            lock_salt: lockRecordRef.current.salt,
          })
        }
      } catch {
        // Keep the local record.
      }
    })()
    return () => { cancelled = true }
  }, [user])

  const persistRecord = useCallback((record) => {
    setLockRecord(record)
    saveLockRecord(record)
    if (user) {
      savePreferencesToCloud(user.id, {
        lock_hash: record?.hash ?? null,
        lock_salt: record?.salt ?? null,
      }).catch(() => {})
    }
  }, [user])

  const verifyPassword = useCallback((password) => {
    const record = lockRecordRef.current
    return !!record && hashPassword(password, record.salt) === record.hash
  }, [])

  const unlockIds = useCallback((ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    if (!list.length) return
    setUnlockedIds(prev => {
      const next = new Set(prev)
      list.forEach(id => next.add(id))
      return next
    })
  }, [])

  // Drop session unlocks for ids that are being locked again — otherwise re-locking
  // an item you unlocked earlier this session would leave it sitting there in plain
  // view, looking like the lock didn't take.
  const relockIds = useCallback((ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    if (!list.length) return
    setUnlockedIds(prev => {
      if (!list.some(id => prev.has(id))) return prev
      const next = new Set(prev)
      list.forEach(id => next.delete(id))
      return next
    })
  }, [])

  const closePrompt = useCallback(() => setPrompt(null), [])

  // ── Prompt flows ────────────────────────────────────────────────────────────

  // Create the first password (two steps: enter, then confirm).
  const requestCreatePassword = useCallback((onDone) => {
    setPrompt({
      mode: 'create',
      title: 'Set Lock Password',
      message: 'You will need this password to open locked bubbles and notes.',
      confirmLabel: 'Set Password',
      validate: (key, value, values) =>
        key === 'confirm' && value !== values.next ? 'Passwords do not match' : null,
      submit: (values) => {
        const salt = generateSalt()
        persistRecord({ hash: hashPassword(values.next, salt), salt })
        setPrompt(null)
        onDone?.()
      },
    })
  }, [persistRecord])

  // Run `action` once a password exists — creating one first if there isn't one yet.
  const ensurePassword = useCallback((action) => {
    if (lockRecordRef.current) action?.()
    else requestCreatePassword(action)
  }, [requestCreatePassword])

  const requestChangePassword = useCallback((onDone) => {
    setPrompt({
      mode: 'change',
      title: 'Change Lock Password',
      message: 'Enter your current password, then choose a new one.',
      confirmLabel: 'Change Password',
      validate: (key, value, values) => {
        if (key === 'current' && !verifyPassword(value)) return 'Incorrect password'
        if (key === 'confirm' && value !== values.next) return 'Passwords do not match'
        return null
      },
      submit: (values) => {
        const salt = generateSalt()
        persistRecord({ hash: hashPassword(values.next, salt), salt })
        setPrompt(null)
        onDone?.()
      },
    })
  }, [persistRecord, verifyPassword])

  // Removing the password also clears every `locked` flag — otherwise items would
  // stay hidden with no password left to reveal them.
  const requestRemovePassword = useCallback((onDone) => {
    setPrompt({
      mode: 'verify',
      title: 'Remove Lock Password',
      message: 'This unlocks everything and removes the password.',
      confirmLabel: 'Remove',
      destructive: true,
      validate: (_key, value) => (verifyPassword(value) ? null : 'Incorrect password'),
      submit: () => {
        persistRecord(null)
        setUnlockedIds(new Set())
        onRemoveAllLocks?.()
        setPrompt(null)
        onDone?.()
      },
    })
  }, [persistRecord, verifyPassword, onRemoveAllLocks])

  // Unlock specific items for this session. `ids` is the item plus any locked
  // ancestor bubbles gating it (see buildLockIndex().gatingIdsFor).
  const requestUnlock = useCallback((ids, onDone) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    if (!list.length) { onDone?.(); return }
    setPrompt({
      mode: 'verify',
      title: 'Locked',
      message: 'Enter your password to unlock this for now.',
      confirmLabel: 'Unlock',
      validate: (_key, value) => (verifyPassword(value) ? null : 'Incorrect password'),
      submit: () => {
        unlockIds(list)
        setPrompt(null)
        onDone?.()
      },
    })
  }, [verifyPassword, unlockIds])

  // "Unlock All" — one password entry reveals everything for the session. The
  // sentinel id makes buildLockIndex treat every locked item as unlocked.
  const requestUnlockAll = useCallback((onDone) => {
    setPrompt({
      mode: 'verify',
      title: 'Unlock All',
      message: 'Unlocks every locked bubble and note for this session.',
      confirmLabel: 'Unlock All',
      validate: (_key, value) => (verifyPassword(value) ? null : 'Incorrect password'),
      submit: () => {
        setUnlockedIds(new Set(['*']))
        setPrompt(null)
        onDone?.()
      },
    })
  }, [verifyPassword])

  const value = {
    hasPassword,
    unlockedIds,
    verifyPassword,
    relockIds,
    ensurePassword,
    requestCreatePassword,
    requestChangePassword,
    requestRemovePassword,
    requestUnlock,
    requestUnlockAll,
  }

  return (
    <LockContext.Provider value={value}>
      {children}
      <AnimatePresence>
        {prompt && (
          <PasswordModal
            key="lock-prompt"
            mode={prompt.mode}
            title={prompt.title}
            message={prompt.message}
            confirmLabel={prompt.confirmLabel}
            destructive={prompt.destructive}
            onValidate={prompt.validate}
            onSubmit={prompt.submit}
            onClose={closePrompt}
          />
        )}
      </AnimatePresence>
    </LockContext.Provider>
  )
}

export const useLock = () => useContext(LockContext)
