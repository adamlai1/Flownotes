import { Fragment, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { useTheme } from '../contexts/ThemeContext'
import { usePreferences } from '../contexts/PreferencesContext'
import { useAuth } from '../contexts/AuthContext'
import { useLock } from '../contexts/LockContext'
import { useEscapeLayer, ESC_LEVEL, KEYBOARD_MEDIA_QUERY } from '../lib/escapeStack'
import { submitFeedback } from '../lib/syncService'
import ImportNotes from './ImportNotes'

function Toast({ message }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.2 }}
          className="fixed bottom-10 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-full text-sm font-medium text-white pointer-events-none"
          style={{ background: 'rgba(30,30,32,0.95)', border: '1px solid rgba(255,255,255,0.12)', zIndex: 999, whiteSpace: 'nowrap' }}
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function DisabledToggle() {
  return (
    <div
      className="relative flex-shrink-0"
      style={{ width: 50, height: 30, borderRadius: 15, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.08)', opacity: 0.45 }}
    >
      <span style={{ position: 'absolute', top: 3, left: 3, width: 24, height: 24, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.25)' }} />
    </div>
  )
}

const SectionHeader = ({ label }) => (
  <p className="text-[11px] font-semibold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--text-muted)' }}>
    {label}
  </p>
)

const Card = ({ children }) => (
  <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
    {children}
  </div>
)

const Divider = () => (
  <div style={{ height: 1, background: 'var(--border)', marginLeft: 16 }} />
)

// Matches the server-side clamp in submitFeedback so the counter can't promise room the
// insert would truncate.
const FEEDBACK_MAX = 5000

const NOTE_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

// The AI features, none of them built yet. Kept as data because the four rows were four
// copies of the same eleven lines, which is how the fourth would have ended up subtly
// unlike the other three.
const AI_FEATURES = [
  { label: 'AI Auto-Tag', hint: 'Automatically suggest tags for your notes' },
  { label: 'AI Connections', hint: 'Suggest related notes' },
  { label: 'AI Bubble Suggestions', hint: 'Suggest which bubble to place your notes in' },
  { label: 'AI Chat', hint: 'Ask questions across your notes' },
]

// The gestures that have no affordance on screen. Every one of them is a press-and-hold
// or a drag past an edge — discoverable by accident at best — so this is the only place
// they are written down. Shown on every device: unlike the key shortcuts below, these are
// how the app is driven by touch.
const TIPS = [
  'Hold a bubble or note to drag it, or release without moving to open its menu.',
  'Hold the + button to create a bubble instead of a note.',
  'Drag an item to the edge of the screen to move it to another page.',
]

// Siri works out of the box on the iOS app — App Shortcuts register when the
// app is installed — so this states what works rather than telling anyone to
// set something up. Shown only in the native shell, where it's true.
const SIRI_TIP = '“Hey Siri, add a note to Nubble” saves what you say as a note; “add a note to Ideas in Nubble” files it in that bubble.'

// The bare-key shortcuts, in the order they're worth learning. Kept in step with
// SHORTCUT_KEYS in lib/escapeStack.js by hand — there is no way to derive a readable
// label from a keymap, and a list that lies is worse than no list.
const KEY_SHORTCUTS = [
  { keys: ['N'], label: 'New note', hint: 'In the current bubble' },
  { keys: ['B'], label: 'New bubble', hint: 'At the current level' },
  { keys: ['K'], label: 'Search notes', hint: 'Switches to All Notes' },
  { keys: ['←', '→'], label: 'Previous / next page', hint: 'Bubble view only' },
  { keys: ['Esc'], label: 'Go back', hint: 'Closes whatever is open' },
]

const KeyCap = ({ children }) => (
  <kbd
    className="text-[11px] font-semibold leading-none flex items-center justify-center"
    style={{
      minWidth: 24, height: 24, padding: '0 6px', borderRadius: 6,
      background: 'var(--surface)', border: '1px solid var(--border)',
      color: 'var(--text)', fontFamily: 'inherit',
    }}
  >
    {children}
  </kbd>
)

// System pages open in the in-app browser on native (@capacitor/browser —
// kicking the user out to Safari would drop them out of the app) and in a
// new tab on web.
function openExternal(url) {
  if (Capacitor.isNativePlatform()) Browser.open({ url })
  else window.open(url, '_blank', 'noopener')
}

export default function Settings({ onClose, zIndex = 50, project, onImportNotes, onSignOut, onDeleteAccount, shareImport, onShareImportDone }) {
  const { theme, toggleTheme } = useTheme()
  const { noteSize, setNoteSize, bouncy, setBouncy, quickCreate, setQuickCreate } = usePreferences()
  const { user, guestMode, signInWithGoogle, signInWithApple } = useAuth()
  const {
    hasPassword,
    requestCreatePassword,
    requestChangePassword,
    requestRemovePassword,
    requestUnlockAll,
  } = useLock()
  const isLight = theme === 'light'
  const [toast, setToast] = useState('')
  const [importOpen, setImportOpen] = useState(() => Boolean(shareImport))
  // A share arriving while Settings is already mounted still opens the importer.
  useEffect(() => {
    if (shareImport) setImportOpen(true)
  }, [shareImport])
  const [feedback, setFeedback] = useState('')
  const [sendingFeedback, setSendingFeedback] = useState(false)
  const toastTimer = useState(null)

  // Settings only mounts while it's open, so this is unconditional.
  useEscapeLayer(true, onClose, ESC_LEVEL.settings)

  // The shortcuts section is shown on exactly the devices the keys are bound on — same
  // media query, watched rather than sampled, so plugging in a mouse reveals it.
  const [hasKeyboard, setHasKeyboard] = useState(
    () => window.matchMedia(KEYBOARD_MEDIA_QUERY).matches
  )
  useEffect(() => {
    const mq = window.matchMedia(KEYBOARD_MEDIA_QUERY)
    const sync = () => setHasKeyboard(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  function showToast(msg) {
    setToast(msg)
    if (toastTimer[0]) clearTimeout(toastTimer[0])
    toastTimer[0] = setTimeout(() => setToast(''), 2000)
  }

  // The box is only cleared once the insert has actually succeeded — a failed send
  // keeps what was typed, so a flaky connection never eats someone's report.
  async function sendFeedback() {
    if (!feedback.trim() || sendingFeedback) return
    setSendingFeedback(true)
    try {
      await submitFeedback(user?.id ?? null, feedback)
      setFeedback('')
      showToast('Thanks for the feedback!')
    } catch {
      showToast("Couldn't send — try again")
    } finally {
      setSendingFeedback(false)
    }
  }

  return (
    <motion.div
      data-modal
      className="fixed inset-0 flex flex-col"
      style={{ zIndex, background: 'var(--surface)', color: 'var(--text)' }}
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'tween', duration: 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      {/* Header */}
      <div
        className="flex-shrink-0 relative flex items-center px-3"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))', paddingBottom: 10, borderBottom: '1px solid var(--border)' }}
      >
        <button
          onClick={onClose}
          className="flex items-center gap-0.5 font-medium text-[15px] py-1 -ml-1 flex-shrink-0 z-10 text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          <span>Back</span>
        </button>
        <span className="absolute inset-x-0 text-center text-[15px] font-semibold pointer-events-none" style={{ color: 'var(--text)' }}>
          Settings
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-4 pt-8 space-y-8" style={{ paddingBottom: 'calc(3rem + env(safe-area-inset-bottom))' }}>

          {/* ACCOUNT */}
          <div>
            <SectionHeader label="Account" />
            <Card>
              {user ? (
                <>
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <span className="flex-shrink-0 w-9 h-9 rounded-full overflow-hidden flex items-center justify-center">
                      {user.user_metadata?.avatar_url ? (
                        <img src={user.user_metadata.avatar_url} alt="avatar" className="w-full h-full object-cover" />
                      ) : (
                        <span className="w-full h-full bg-indigo-700 flex items-center justify-center text-white text-sm font-bold">
                          {(user.user_metadata?.full_name || user.email || '?')[0].toUpperCase()}
                        </span>
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
                        {user.user_metadata?.full_name || 'Signed in'}
                      </p>
                      <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{user.email}</p>
                    </div>
                  </div>
                  <Divider />
                  <button
                    onClick={() => onSignOut?.()}
                    className="w-full flex items-center px-4 py-3.5 active:opacity-70 transition-opacity"
                  >
                    <span className="text-sm font-medium text-red-400">Sign out</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={signInWithGoogle}
                    className="w-full flex items-center gap-3 px-4 py-3.5 active:opacity-70 transition-opacity"
                  >
                    <span className="flex-shrink-0 w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-sm">
                      <svg className="w-4 h-4" viewBox="0 0 24 24">
                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                      </svg>
                    </span>
                    <div className="text-left">
                      <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Sign in with Google</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Sync your notes across devices</p>
                    </div>
                  </button>
                  <Divider />
                  <button
                    onClick={signInWithApple}
                    className="w-full flex items-center gap-3 px-4 py-3.5 active:opacity-70 transition-opacity"
                  >
                    {/* Black variant of the Apple mark — reads correctly on both themes */}
                    <span className="flex-shrink-0 w-8 h-8 rounded-full bg-black flex items-center justify-center shadow-sm">
                      <svg className="w-4 h-4" viewBox="0 0 384 512" fill="#fff" aria-hidden="true">
                        <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
                      </svg>
                    </span>
                    <div className="text-left">
                      <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Sign in with Apple</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Sync your notes across devices</p>
                    </div>
                  </button>
                </>
              )}
            </Card>
          </div>

          {/* APPEARANCE */}
          <div>
            <SectionHeader label="Appearance" />
            <Card>
              <div className="flex items-center justify-between px-4 py-3.5">
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Light Mode</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{isLight ? 'Light' : 'Dark'} appearance</p>
                </div>
                <button
                  onClick={toggleTheme}
                  className="relative flex-shrink-0 focus:outline-none"
                  style={{
                    width: 50, height: 30, borderRadius: 15,
                    background: isLight ? '#34C759' : 'rgba(255,255,255,0.18)',
                    border: isLight ? 'none' : '1px solid rgba(255,255,255,0.12)',
                    transition: 'background 0.2s ease',
                  }}
                  aria-label="Toggle light mode"
                >
                  <span style={{
                    position: 'absolute', top: 3, left: isLight ? 23 : 3,
                    width: 24, height: 24, borderRadius: '50%',
                    background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
                    transition: 'left 0.2s ease',
                  }} />
                </button>
              </div>
              <Divider />
              <div className="flex items-center justify-between px-4 py-3.5">
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Bouncy Animations</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {bouncy ? 'Springy movement with a little bounce' : 'Smooth movement, no bounce'}
                  </p>
                </div>
                <button
                  onClick={() => setBouncy(!bouncy)}
                  className="relative flex-shrink-0 focus:outline-none"
                  style={{
                    width: 50, height: 30, borderRadius: 15,
                    background: bouncy ? '#34C759' : 'rgba(255,255,255,0.18)',
                    border: bouncy ? 'none' : '1px solid rgba(255,255,255,0.12)',
                    transition: 'background 0.2s ease',
                  }}
                  aria-label="Toggle bouncy animations"
                >
                  <span style={{
                    position: 'absolute', top: 3, left: bouncy ? 23 : 3,
                    width: 24, height: 24, borderRadius: '50%',
                    background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
                    transition: 'left 0.2s ease',
                  }} />
                </button>
              </div>
              <Divider />
              <div className="flex items-center justify-between px-4 py-3.5">
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Quick Create</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {quickCreate ? 'Tap + for a note, hold for a bubble' : 'Tap + to choose a note or a bubble'}
                  </p>
                </div>
                <button
                  onClick={() => setQuickCreate(!quickCreate)}
                  className="relative flex-shrink-0 focus:outline-none"
                  style={{
                    width: 50, height: 30, borderRadius: 15,
                    background: quickCreate ? '#34C759' : 'rgba(255,255,255,0.18)',
                    border: quickCreate ? 'none' : '1px solid rgba(255,255,255,0.12)',
                    transition: 'background 0.2s ease',
                  }}
                  aria-label="Toggle quick create"
                >
                  <span style={{
                    position: 'absolute', top: 3, left: quickCreate ? 23 : 3,
                    width: 24, height: 24, borderRadius: '50%',
                    background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
                    transition: 'left 0.2s ease',
                  }} />
                </button>
              </div>
              <Divider />
              <div className="px-4 py-3.5">
                <div className="mb-3">
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Note Size</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Size of note cards in bubble view</p>
                </div>
                <div
                  className="flex p-0.5 rounded-xl"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                >
                  {NOTE_SIZE_OPTIONS.map(opt => {
                    const active = noteSize === opt.value
                    return (
                      <button
                        key={opt.value}
                        onClick={() => setNoteSize(opt.value)}
                        className="flex-1 text-[13px] font-medium py-1.5 rounded-[10px] transition-colors"
                        style={{
                          background: active ? '#6366f1' : 'transparent',
                          color: active ? '#fff' : 'var(--text-muted)',
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </Card>
          </div>

          {/* DATA */}
          <div>
            <SectionHeader label="Data" />
            <Card>
              <button
                onClick={() => showToast('Coming soon!')}
                className="w-full flex items-center justify-between px-4 py-3.5 active:opacity-70 transition-opacity"
              >
                <div className="text-left">
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Export Notes</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Download all your notes</p>
                </div>
                <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <Divider />
              <button
                onClick={() => setImportOpen(true)}
                className="w-full flex items-center justify-between px-4 py-3.5 active:opacity-70 transition-opacity"
              >
                <div className="text-left">
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Import Notes</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Import from Apple Notes, Google Docs, or file</p>
                </div>
                <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </Card>
          </div>

          {/* PRIVACY */}
          <div>
            <SectionHeader label="Privacy" />
            <Card>
              <button
                onClick={() => hasPassword
                  ? requestChangePassword(() => showToast('Password changed'))
                  : requestCreatePassword(() => showToast('Lock password set'))}
                className="w-full flex items-center justify-between px-4 py-3.5 active:opacity-70 transition-opacity"
              >
                <div className="text-left">
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                    {hasPassword ? 'Change Lock Password' : 'Set Lock Password'}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {hasPassword
                      ? 'Requires your current password'
                      : 'Hide bubbles and notes behind a password'}
                  </p>
                </div>
                <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>

              {hasPassword && (
                <>
                  <Divider />
                  <button
                    onClick={() => requestUnlockAll(() => showToast('Everything unlocked for this session'))}
                    className="w-full flex items-center justify-between px-4 py-3.5 active:opacity-70 transition-opacity"
                  >
                    <div className="text-left">
                      <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Unlock All</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        Reveal everything until the app is closed
                      </p>
                    </div>
                    <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  <Divider />
                  <button
                    onClick={() => requestRemovePassword(() => showToast('Lock password removed'))}
                    className="w-full flex items-center px-4 py-3.5 active:opacity-70 transition-opacity"
                  >
                    <div className="text-left">
                      <p className="text-sm font-medium text-red-400">Remove Lock Password</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        Unlocks every locked bubble and note
                      </p>
                    </div>
                  </button>
                </>
              )}
            </Card>
            <p className="text-[11px] mt-2 px-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Locking hides items in the app. It isn't encryption — locked notes are
              still stored normally on this device and in your account.
            </p>
          </div>

          {/* FEEDBACK */}
          <div>
            <SectionHeader label="Feedback" />
            <Card>
              <div className="px-4 py-3.5">
                <div className="mb-3">
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Send Feedback</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Bugs, ideas, anything that felt wrong
                  </p>
                </div>
                <textarea
                  value={feedback}
                  onChange={e => setFeedback(e.target.value.slice(0, FEEDBACK_MAX))}
                  placeholder="What's on your mind?"
                  rows={4}
                  disabled={sendingFeedback}
                  className="w-full text-sm rounded-xl px-3 py-2.5 resize-none focus:outline-none"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                />
                <div className="flex items-center justify-between mt-2.5">
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {feedback.length}/{FEEDBACK_MAX}
                  </span>
                  <button
                    onClick={sendFeedback}
                    disabled={!feedback.trim() || sendingFeedback}
                    className="text-[13px] font-medium px-4 py-1.5 rounded-[10px] transition-opacity"
                    style={{
                      background: '#6366f1',
                      color: '#fff',
                      opacity: (!feedback.trim() || sendingFeedback) ? 0.45 : 1,
                    }}
                  >
                    {sendingFeedback ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
            </Card>
          </div>

          {/* AI FEATURES — every row unbuilt, so every row is the same row */}
          <div>
            <SectionHeader label="AI Features" />
            <Card>
              {AI_FEATURES.map((f, i) => (
                <Fragment key={f.label}>
                  {i > 0 && <Divider />}
                  <div className="flex items-center justify-between px-4 py-3.5 opacity-60">
                    <div className="flex-1 min-w-0 mr-4">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{f.label}</p>
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ background: 'rgba(99,102,241,0.18)', color: '#818cf8' }}
                        >
                          Coming soon
                        </span>
                      </div>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{f.hint}</p>
                    </div>
                    <DisabledToggle />
                  </div>
                </Fragment>
              ))}
            </Card>
          </div>

          {/* TIPS — informational rows, not controls: nothing here is tappable */}
          <div>
            <SectionHeader label="Tips" />
            <Card>
              {(Capacitor.isNativePlatform() ? [...TIPS, SIRI_TIP] : TIPS).map((tip, i) => (
                <Fragment key={tip}>
                  {i > 0 && <Divider />}
                  <p className="text-sm px-4 py-3.5" style={{ color: 'var(--text)', lineHeight: 1.45 }}>
                    {tip}
                  </p>
                </Fragment>
              ))}
            </Card>
          </div>

          {/* KEYBOARD SHORTCUTS — desktop only, where the keys are actually bound */}
          {hasKeyboard && (
            <div>
              <SectionHeader label="Keyboard Shortcuts" />
              <Card>
                {KEY_SHORTCUTS.map((s, i) => (
                  <Fragment key={s.label}>
                    {i > 0 && <Divider />}
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{s.label}</p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{s.hint}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {s.keys.map(k => <KeyCap key={k}>{k}</KeyCap>)}
                      </div>
                    </div>
                  </Fragment>
                ))}
              </Card>
            </div>
          )}

          {/* LINKS — the site's policy and help pages. The .html extensions are
              deliberate: the host serves no clean URLs (bare /privacy and
              /support 404). */}
          <div>
            <Card>
              {/* Official Apple badge asset, used verbatim. Hidden inside the
                  Capacitor shell — same reason as the login-screen badge: Apple
                  rejects apps that link out to the App Store from within
                  themselves (and the row would be pointless there anyway). */}
              {!Capacitor.isNativePlatform() && (
                <>
                  <button
                    onClick={() => openExternal('https://nubblenotes.com/ios')}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3.5 active:opacity-70 transition-opacity"
                  >
                    <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>Get the iOS app</span>
                    <img src="/app-store-badge.svg" alt="Download on the App Store" style={{ height: 36 }} />
                  </button>
                  <Divider />
                </>
              )}
              <button
                onClick={() => openExternal('https://nubblenotes.com/privacy.html')}
                className="w-full flex items-center px-4 py-3.5 active:opacity-70 transition-opacity"
              >
                <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>Privacy Policy</span>
              </button>
              <Divider />
              <button
                onClick={() => openExternal('https://nubblenotes.com/support.html')}
                className="w-full flex items-center px-4 py-3.5 active:opacity-70 transition-opacity"
              >
                <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>Support</span>
              </button>
              <Divider />
              {/* Which web bundle this is: commit + build date, substituted at build
                  time (vite.config.js). On the native shell this is the only way to
                  tell from inside the app whether `npx cap sync ios` ran after the
                  last pull — compare it with `git log` on the Mac. */}
              <div className="flex items-center justify-between px-4 py-3.5">
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Build</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                  {typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev'}
                </span>
              </div>
            </Card>
          </div>

          {/* DELETE ACCOUNT — the most destructive action in the app, kept at
              the very bottom on its own, away from routine controls */}
          {user && (
            <div>
              <Card>
                <button
                  onClick={() => onDeleteAccount?.()}
                  className="w-full flex items-center justify-center px-4 py-3.5 active:opacity-70 transition-opacity"
                >
                  <span className="text-sm font-medium text-red-400">Delete account</span>
                </button>
              </Card>
            </div>
          )}

        </div>
      </div>

      <AnimatePresence>
        {importOpen && project && (
          <ImportNotes
            key="import"
            project={project}
            onImportNotes={onImportNotes}
            onClose={() => { setImportOpen(false); onShareImportDone?.() }}
            showToast={showToast}
            initialText={shareImport?.text}
            initialTextKey={shareImport?.id}
          />
        )}
      </AnimatePresence>

      <Toast message={toast} />
    </motion.div>
  )
}
