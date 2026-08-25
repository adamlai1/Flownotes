import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

// A one-line transient message, raised from anywhere.
//
// It lives at the app root because the things that raise it don't: the note menus that
// report "Copied" are inside a card that unmounts, or inside a popup that closes on the
// very action being reported. A toast owned by the caller would go with it.
//
// Settings keeps its own local Toast for feedback submission. Left alone deliberately —
// it predates this and lives inside a full-screen panel that is its own world.

// The context value IS the showToast function (see the Provider below) — the
// default must be the same shape, or a consumer written against the default
// (`const { showToast } = useToast()`) breaks the moment the provider is
// present. That exact mismatch produced the list-view "showToast is not a
// function" bug.
const ToastContext = createContext(() => {})

const TOAST_MS = 1800

export function ToastProvider({ children }) {
  const [message, setMessage] = useState('')
  const timerRef = useRef(null)

  const showToast = useCallback((msg) => {
    if (!msg) return
    setMessage(msg)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setMessage(''), TOAST_MS)
  }, [])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-full text-sm font-medium text-white pointer-events-none"
            style={{
              // Clear of the floating + button, which owns the bottom-right corner.
              bottom: 'calc(6rem + env(safe-area-inset-bottom))',
              background: 'rgba(30,30,32,0.95)',
              border: '1px solid rgba(255,255,255,0.12)',
              zIndex: 999,
              whiteSpace: 'nowrap',
            }}
            role="status"
          >
            {message}
          </motion.div>
        )}
      </AnimatePresence>
    </ToastContext.Provider>
  )
}

// Returns showToast(message). A falsy message is ignored, so a caller can hand it the
// result of an action that sometimes has nothing to say.
export const useToast = () => useContext(ToastContext)
