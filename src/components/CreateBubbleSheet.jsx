import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useEscapeLayer, ESC_LEVEL } from '../lib/escapeStack'
import { BUBBLE_COLORS } from '../data/defaultData'

// Name + colour for a new bubble, opened by holding the floating + button.
//
// `focusNonce` exists for the phone keyboard: the sheet opens on a timer, and a focus
// call that isn't inside a user gesture doesn't raise the keyboard on iOS. The opener
// bumps this on the pointerup that ends the hold — a real gesture — and the field is
// focused again from there. The focus on open covers Android and desktop.
export default function CreateBubbleSheet({ open, parentName, focusNonce, onCreate, onCancel }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(BUBBLE_COLORS[0])
  const inputRef = useRef(null)

  useEscapeLayer(open, onCancel, ESC_LEVEL.modal)

  // Fresh every time it opens — a half-typed name from last time is never what's wanted.
  useEffect(() => {
    if (!open) return
    setName('')
    setColor(BUBBLE_COLORS[0])
  }, [open])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open, focusNonce])

  const trimmed = name.trim()
  const canCreate = trimmed.length > 0

  function submit() {
    if (!canCreate) return
    onCreate(trimmed, color)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-modal
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 70, background: 'rgba(0,0,0,0.6)' }}
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.15 }}
            className="mx-6 w-full max-w-xs rounded-2xl p-6"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-semibold text-lg text-center" style={{ color: 'var(--text)' }}>
              New bubble
            </h2>
            <p className="text-sm text-center mb-4" style={{ color: 'var(--text-muted)' }}>
              {parentName ? `inside ${parentName}` : 'at the top level'}
            </p>

            <input
              ref={inputRef}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submit()
                // Escape is the sheet's, not the field's — let it reach the escape layer.
              }}
              placeholder="Bubble name…"
              className="w-full px-3 py-2 text-sm rounded-lg outline-none focus:border-indigo-500"
              style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border)',
                color: 'var(--text)',
              }}
            />

            <div className="flex gap-1.5 flex-wrap justify-center mt-4">
              {BUBBLE_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Colour ${c}`}
                  aria-pressed={color === c}
                  className={`w-6 h-6 rounded-full transition-transform ${
                    color === c ? 'ring-2 ring-offset-2 ring-white scale-110' : ''
                  }`}
                  style={{ backgroundColor: c, '--tw-ring-offset-color': 'var(--surface-2)' }}
                />
              ))}
            </div>

            <div className="flex gap-3 mt-5">
              <button
                onClick={onCancel}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
                style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!canCreate}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white transition-colors bg-indigo-600 enabled:hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Create
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
