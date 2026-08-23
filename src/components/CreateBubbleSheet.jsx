import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useEscapeLayer, ESC_LEVEL, KEYBOARD_MEDIA_QUERY } from '../lib/escapeStack'
import { useBodyScrollLock } from '../lib/bodyScrollLock'
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
  // Desktop (fine pointer, hardware keyboard) vs touch — the same distinction the
  // rest of the app draws with this query. Sampled per render; the sheet remounts
  // its overlay on every open, which is when the answer matters.
  const hasHardwareKeyboard = window.matchMedia(KEYBOARD_MEDIA_QUERY).matches
  const [name, setName] = useState('')
  const [color, setColor] = useState(defaultColor ?? BUBBLE_COLORS[0])
  const inputRef = useRef(null)

  useEscapeLayer(open, onCancel, ESC_LEVEL.modal)
  // The top-anchoring below stops iOS from auto-panning at focus time; this
  // stops the user from dragging the whole shell around once the keyboard has
  // shrunk the visual viewport. Keyed on `open`, so cancel and create both
  // release it; a dismissed keyboard with the sheet still up keeps the lock,
  // which is correct — the sheet is still the only interactive surface.
  useBodyScrollLock(open)

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
          // The DIM is sized to the layout viewport (fixed inset-0), which iOS does
          // NOT shrink for the keyboard — when it was sized to the visual viewport,
          // the bottom of the screen lost its dim the moment the keyboard opened.
          // Only the POSITIONING LAYER inside tracks the visual viewport, keeping
          // the card in the visible area above the keyboard.
          className="fixed inset-0"
          style={{ zIndex: 70, background: 'rgba(0,0,0,0.6)' }}
          onClick={onCancel}
        >
        <div
          className={`absolute left-0 w-full flex justify-center ${hasHardwareKeyboard ? 'items-center' : 'items-start'}`}
          style={{
            top: viewport.height == null ? 0 : viewport.top,
            height: viewport.height ?? '100%',
            // Touch devices: anchored near the top rather than centred. iOS (webview
            // and mobile Safari alike) decides whether to pan the page AT FOCUS TIME,
            // from where the input sits in the full-height layout — a centred sheet
            // puts it mid-screen, under the incoming software keyboard, and the whole
            // canvas gets scrolled up to reveal it. This high the input is always
            // clear of the keyboard, so no pan ever happens. Desktop has no software
            // keyboard, and a sheet pinned to the top of a large window looks wrong,
            // so it stays centred there. Not gated on isNativePlatform — mobile
            // Safari at nubblenotes.com needs the fix as much as the app does.
            ...(hasHardwareKeyboard ? {} : { paddingTop: 'calc(env(safe-area-inset-top, 0px) + 56px)' }),
          }}
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
        </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
