import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useEscapeLayer, ESC_LEVEL } from '../lib/escapeStack'
import { BUBBLE_COLORS } from '../data/defaultData'
import BubbleNameInput from './BubbleNameInput'
import BubbleColorPicker from './BubbleColorPicker'

// The on-screen box, which is not the same as the window once a keyboard is up: iOS
// shrinks only the visual viewport, leaving the layout viewport — and so `inset-0` and
// every vh unit — at full height. A sheet centred in that sits half under the keyboard.
// Laying the overlay out in these numbers instead keeps the whole sheet in sight, and
// gives the suggestion list a real ceiling to shrink against.
function useVisualViewport() {
  const [box, setBox] = useState({ top: 0, height: null })
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return undefined
    const sync = () => setBox({ top: vv.offsetTop, height: vv.height })
    sync()
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
    return () => {
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
    }
  }, [])
  return box
}

// Name + colour for a new bubble, opened by holding the floating + button.
//
// `focusNonce` exists for the phone keyboard: the sheet opens on a timer, and a focus
// call that isn't inside a user gesture doesn't raise the keyboard on iOS. The opener
// bumps this on the pointerup that ends the hold — a real gesture — and the field is
// focused again from there. The focus on open covers Android and desktop.
export default function CreateBubbleSheet({
  open, parentName, siblingNames = [], defaultColor, focusNonce, onCreate, onCancel,
}) {
  const viewport = useVisualViewport()
  const [name, setName] = useState('')
  const [color, setColor] = useState(defaultColor ?? BUBBLE_COLORS[0])
  const inputRef = useRef(null)

  useEscapeLayer(open, onCancel, ESC_LEVEL.modal)

  // Fresh every time it opens — a half-typed name from last time is never what's wanted,
  // and the least-used colour is worked out against how things stand now. Deliberately
  // keyed on `open` alone: once the sheet is up, the colour is the user's to change, and
  // reacting to a new default would take a deliberate pick back off them.
  useEffect(() => {
    if (!open) return
    setName('')
    setColor(defaultColor ?? BUBBLE_COLORS[0])
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

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
          className="fixed left-0 w-full flex items-center justify-center"
          style={{
            zIndex: 70,
            background: 'rgba(0,0,0,0.6)',
            top: viewport.height == null ? 0 : viewport.top,
            height: viewport.height ?? '100%',
          }}
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.15 }}
            className="mx-6 w-full max-w-xs rounded-2xl p-6 flex flex-col"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              // Bounded by what's actually visible, and only the suggestion list inside
              // gives — so the colour picker and Create never leave the screen.
              maxHeight: 'calc(100% - 32px)',
              overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-semibold text-lg text-center shrink-0" style={{ color: 'var(--text)' }}>
              New bubble
            </h2>
            <p className="text-sm text-center mb-4 shrink-0" style={{ color: 'var(--text-muted)' }}>
              {parentName ? `inside ${parentName}` : 'at the top level'}
            </p>

            <BubbleNameInput
              inputRef={inputRef}
              value={name}
              onChange={setName}
              onSubmit={submit}
              onCancel={onCancel}
              exclude={siblingNames}
              listPosition="inline"
              className="w-full px-3 py-2 text-sm rounded-lg outline-none focus:border-indigo-500"
              style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border)',
                color: 'var(--text)',
              }}
            />

            <div className="mt-4 shrink-0">
              <BubbleColorPicker value={color} onChange={setColor} />
            </div>

            <div className="flex gap-3 mt-5 shrink-0">
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
