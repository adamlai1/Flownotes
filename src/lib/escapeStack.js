import { useEffect, useRef } from 'react'

// Escape-to-go-back, resolved by ONE window listener.
//
// Every dismissable thing — a panel, a modal, a popup menu, a nested bubble level —
// registers a handler while it's open. A press runs exactly one of them, so layers
// peel off one at a time instead of every open thing reacting at once (which is what
// happens with a listener per component).
//
// Which one wins:
//   1. `level` — mirrors the visual stacking (the same numbers as each layer's
//      z-index), so a modal always beats the panel it's drawn over even if the panel
//      registered later.
//   2. Registration order breaks ties — a layer is pushed when it OPENS, so among
//      equals the most recently opened is on top. That's what makes "sidebar opened
//      while inside a nested bubble" close the sidebar first.
//
// Desktop only: bound while the device reports hover + a fine pointer (a real
// mouse), never on touch.

// Levels — keep these in step with the z-index each layer actually renders at.
export const ESC_LEVEL = {
  base: 0,        // sidebar, bubble-view level navigation
  popup: 20,      // in-canvas popup menus
  settings: 45,
  note: 50,       // note editor (+ its depth in the stack)
  panel: 60,      // full-screen panel over settings (import)
  modal: 70,      // confirm dialogs
  password: 200,  // password prompts
}

// ── Registry (pure — no DOM, no React) ────────────────────────────────────────

const layers = []              // [{ level, seq, run }]
const inputCancels = new Map() // focused element → its own Escape behaviour
let seq = 0

export function pushLayer(level, run) {
  const entry = { level, seq: seq++, run }
  layers.push(entry)
  return () => {
    const i = layers.indexOf(entry)
    if (i !== -1) layers.splice(i, 1)
  }
}

export function registerInputCancel(el, cancel) {
  inputCancels.set(el, cancel)
  return () => { inputCancels.delete(el) }
}

export function topLayer() {
  let best = null
  for (const entry of layers) {
    if (!best || entry.level > best.level || (entry.level === best.level && entry.seq > best.seq)) {
      best = entry
    }
  }
  return best
}

function isTextEntry(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

// Decide and perform the single action for one Escape press, given what's focused.
// Returns what it did so the caller knows whether to preventDefault (and so this is
// testable without a DOM event).
export function handleEscape(activeElement) {
  // Typing wins over navigation: Escape leaves the field first, and only a second
  // press — with nothing focused — reaches the layer underneath. Fields that have
  // something of their own to undo (clearing a search) register that instead.
  if (isTextEntry(activeElement)) {
    const cancel = inputCancels.get(activeElement)
    if (cancel) { cancel(); return 'input-cancel' }
    activeElement.blur?.()
    return 'blur'
  }
  const top = topLayer()
  if (!top) return 'none' // root bubble view with nothing open — Escape does nothing
  top.run()
  return 'layer'
}

// ── DOM listener + React bindings ─────────────────────────────────────────────

function onKeyDown(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (handleEscape(document.activeElement) !== 'none') e.preventDefault()
}

// Register `handler` as the Escape action for this layer while `active` is true.
// The handler is read through a ref at call time, so re-renders never reshuffle the
// stack — only opening and closing move a layer.
export function useEscapeLayer(active, handler, level = ESC_LEVEL.base) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    if (!active) return undefined
    return pushLayer(level, () => handlerRef.current?.())
  }, [active, level])
}

// Give a focused field its own Escape behaviour (e.g. clear the search box) instead
// of the default blur.
export function useEscapeInput(ref, onCancel, active = true) {
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return undefined
    return registerInputCancel(el, () => cancelRef.current?.())
  }, [ref, active])
}

// Installed once, at the app root.
export function useEscapeShortcut() {
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    let bound = false
    const sync = () => {
      if (mq.matches === bound) return
      if (mq.matches) window.addEventListener('keydown', onKeyDown)
      else window.removeEventListener('keydown', onKeyDown)
      bound = mq.matches
    }
    sync()
    mq.addEventListener('change', sync)
    return () => {
      mq.removeEventListener('change', sync)
      if (bound) window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
