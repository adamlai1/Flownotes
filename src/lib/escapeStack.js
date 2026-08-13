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
//
// The same listener also carries the app's bare-key shortcuts (N / B / K / arrows) —
// see the shortcuts section below.

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
  // A custom editor can be a plain div that only announces itself through the role.
  // Cheap to honour, and the cost of missing one is a bare-key shortcut firing into
  // somebody's half-typed sentence.
  if (el.getAttribute?.('role') === 'textbox') return true
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

// ── Bare-key shortcuts ────────────────────────────────────────────────────────
//
// N, B, K and the arrows, with no modifier. Bare keys are the right shape for an app
// you drive one-handed, but they are also the dangerous shape: every one of them is a
// letter somebody might be typing. So the guards below are the feature, and the
// dispatch is the easy part.
//
// They ride the SAME window listener as Escape rather than adding a second one. That is
// not only tidiness — it is what lets Escape keep first refusal on a press, and it means
// the desktop-only binding in useEscapeShortcut covers these too, for free.

// key (lowercased) → action name. Lowercased so Shift+N still reads as N; a shift-only
// press is not a modifier we care to block, unlike the three that own browser commands.
const SHORTCUT_KEYS = {
  n: 'note',
  b: 'bubble',
  k: 'search',
  arrowleft: 'prev-page',
  arrowright: 'next-page',
}

// Actions that additionally need the bubble view to be the one on screen.
const ARROW_ACTIONS = new Set(['prev-page', 'next-page'])

// At most one registration — the app root's. Held as the React ref itself so the
// current state is read at press time and re-renders never need to re-register.
let shortcutStateRef = null

export function registerShortcuts(stateRef) {
  shortcutStateRef = stateRef
  return () => { if (shortcutStateRef === stateRef) shortcutStateRef = null }
}

// The action one press should run, or null to leave it alone. Both the event target and
// the focused element are offered because they are not always the same thing, and either
// one being a text field is reason enough to stay out of the way.
export function resolveShortcut(e, target, activeElement) {
  const state = shortcutStateRef?.current
  if (!state?.enabled) return null
  // Any modifier means the press belongs to the browser or the OS, not to us.
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  if (isTextEntry(target) || isTextEntry(activeElement)) return null

  const action = SHORTCUT_KEYS[String(e.key ?? '').toLowerCase()]
  if (!action) return null

  // Anything dismissable stacked above the base layer has the keyboard: the note editor,
  // settings, the create-bubble sheet, a confirm dialog, a password prompt. Reading it
  // off the layer stack rather than a list of booleans means a dismissable thing added
  // later blocks these shortcuts the moment it registers, without anyone remembering to
  // come back here. The base layer itself — the sidebar, and being inside a nested
  // bubble — is not a blocker: those are places you work from, not things over the top.
  const top = topLayer()
  if (top && top.level > ESC_LEVEL.base) return null

  if (ARROW_ACTIONS.has(action) && !state.arrows) return null
  return action
}

// ── DOM listener + React bindings ─────────────────────────────────────────────

function onKeyDown(e) {
  if (e.defaultPrevented) return
  if (e.key === 'Escape') {
    if (handleEscape(document.activeElement) !== 'none') e.preventDefault()
    return
  }
  const action = resolveShortcut(e, e.target, document.activeElement)
  if (!action) return
  e.preventDefault()
  shortcutStateRef?.current?.onAction?.(action)
}

// Install the app's bare-key shortcuts. `enabled` gates the lot, `arrows` gates just the
// page-turning pair, and `onAction` receives one of the action names above. Bound by
// useEscapeShortcut, so like Escape these exist on non-touch devices only.
export function useKeyShortcuts(state) {
  const stateRef = useRef(state)
  stateRef.current = state
  useEffect(() => registerShortcuts(stateRef), [])
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

// What "desktop" means for every key binding here: a real mouse and hover, never touch.
// Exported so anything that DESCRIBES the shortcuts (the Settings list) is shown under
// exactly the condition that makes them work.
export const KEYBOARD_MEDIA_QUERY = '(hover: hover) and (pointer: fine)'

// Installed once, at the app root.
export function useEscapeShortcut() {
  useEffect(() => {
    const mq = window.matchMedia(KEYBOARD_MEDIA_QUERY)
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
