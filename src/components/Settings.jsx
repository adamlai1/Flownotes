import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTheme } from '../contexts/ThemeContext'

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

export default function Settings({ onClose, zIndex = 50 }) {
  const { theme, toggleTheme } = useTheme()
  const isLight = theme === 'light'
  const [toast, setToast] = useState('')
  const toastTimer = useState(null)

  function showToast(msg) {
    setToast(msg)
    if (toastTimer[0]) clearTimeout(toastTimer[0])
    toastTimer[0] = setTimeout(() => setToast(''), 2000)
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
            </Card>
          </div>

          {/* ACCOUNT */}
          <div>
            <SectionHeader label="Account" />
            <Card>
              <button
                onClick={() => showToast('Coming soon!')}
                className="w-full flex items-center gap-3 px-4 py-3.5 active:opacity-70 transition-opacity"
              >
                {/* Google G logo */}
                <span className="flex-shrink-0 w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-sm">
                  <svg className="w-4 h-4" viewBox="0 0 24 24">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  </svg>
                </span>
                <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>Sign in with Google</span>
              </button>
            </Card>
          </div>

          {/* AI FEATURES */}
          <div>
            <SectionHeader label="AI Features" />
            <Card>
              <div className="flex items-center justify-between px-4 py-3.5 opacity-60">
                <div className="flex-1 min-w-0 mr-4">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>AI Auto-Tag</p>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(99,102,241,0.18)', color: '#818cf8' }}>Coming soon</span>
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Automatically suggest tags for your notes</p>
                </div>
                <DisabledToggle />
              </div>
              <Divider />
              <div className="flex items-center justify-between px-4 py-3.5 opacity-60">
                <div className="flex-1 min-w-0 mr-4">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>AI Connections</p>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(99,102,241,0.18)', color: '#818cf8' }}>Coming soon</span>
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Suggest related notes</p>
                </div>
                <DisabledToggle />
              </div>
              <Divider />
              <div className="flex items-center justify-between px-4 py-3.5 opacity-60">
                <div className="flex-1 min-w-0 mr-4">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>AI Bubble Suggestions</p>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(99,102,241,0.18)', color: '#818cf8' }}>Coming soon</span>
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Suggest which bubble to place your notes in</p>
                </div>
                <DisabledToggle />
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
                onClick={() => showToast('Coming soon!')}
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

        </div>
      </div>

      <Toast message={toast} />
    </motion.div>
  )
}
