import { useEffect, useRef } from 'react'
import { useEscapeLayer, ESC_LEVEL } from './escapeStack'

// Outside-press dismissal for every transient overlay, resolved by ONE
// document listener — the pointer twin of escapeStack.
//
// A press OUTSIDE the overlay dismisses it on POINTERDOWN (immediate, and —
// unlike click — reliably delivered by iOS Safari, whose click synthesis on
// non-interactive elements is what let the old backdrop-onClick pattern
// silently fail on the phone). A press INSIDE does nothing, including on
// interactive children and on content that unmounts because of the press:
// containment is tested at pointerdown time, while the target is still
// attached.
//
// Overlays stack in registration (= opening) order and a press dismisses only
// the TOPMOST one, so closing an overlay opened from another never collapses
// the whole stack.
//
// The click that follows a dismissing press is swallowed (one-shot capture
// listener, disarmed by that click or by the next press — no timers), so the
// tap that closes a menu can never also activate whatever it lands on. The
// existing invisible/dimmed backdrop elements stay where components render
// them: they are what shields the canvas's position-based pointer handlers
// from presses meant for the overlay. Only the dismissal itself moved here.
//
// The opening click can't self-dismiss without any timeout: the listener is
// attached in an effect, which runs after the click that opened the overlay
// has finished dispatching.

const stack = [] // topmost overlay last: { isInside, dismiss }

function armClickSuppressor() {
  // The dismissing press must not become an activation elsewhere. Its
  // POINTERDOWN is stopped at document capture (onDocPointerDown below), so no
  // press-driven handler — the canvas's press arbitration above all — ever
  // arms from it; the browser still synthesizes a CLICK from the raw press,
  // and that click is swallowed here so click-driven controls stay untouched
  // too. One-shot: disarmed by that click or by the next press (a scroll or
  // drag may never produce a click, and a stale suppressor must not eat some
  // future unrelated tap). No timers anywhere. Deliberately NOT touching
  // pointerup: a press machine that legitimately armed elsewhere must always
  // see its up, or its long-press timers fire into a phantom gesture.
  function suppressClick(ev) {
    ev.preventDefault()
    ev.stopPropagation()
    disarm()
  }
  function disarm() {
    document.removeEventListener('click', suppressClick, true)
    document.removeEventListener('pointerdown', disarm, true)
  }
  document.addEventListener('click', suppressClick, true)
  // (Listeners added while the current pointerdown is dispatching don't run
  // for it — the disarm only sees the NEXT press.)
  document.addEventListener('pointerdown', disarm, true)
}

function onDocPointerDown(e) {
  const top = stack[stack.length - 1]
  if (!top || top.isInside(e.target)) return
  // Stop the press itself from reaching anything below the overlay, then
  // swallow the click it will synthesize.
  e.stopPropagation()
  armClickSuppressor()
  top.dismiss()
}

let bound = 0
function bind() {
  if (bound++ === 0) document.addEventListener('pointerdown', onDocPointerDown, true)
}
function unbind() {
  if (--bound === 0) document.removeEventListener('pointerdown', onDocPointerDown, true)
}

// Dismiss `onDismiss` when a press lands outside every ref in `insideRefs`
// (the overlay's panel; add the trigger's ref when the trigger should toggle
// rather than dismiss-and-reopen). Escape dismisses too, through the shared
// escape stack at `escLevel` — pass escLevel: false when the caller already
// registers its own escape layer.
export function useDismissOnOutside(active, onDismiss, insideRefs, { escLevel = ESC_LEVEL.popup } = {}) {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const refsRef = useRef(insideRefs)
  refsRef.current = insideRefs

  useEscapeLayer(
    active && escLevel !== false,
    () => dismissRef.current?.(),
    escLevel === false ? ESC_LEVEL.popup : escLevel,
  )

  useEffect(() => {
    if (!active) return undefined
    bind()
    const entry = {
      isInside: (target) =>
        refsRef.current.some(r => r?.current && (r.current === target || r.current.contains(target))),
      dismiss: () => dismissRef.current?.(),
    }
    stack.push(entry)
    return () => {
      const i = stack.indexOf(entry)
      if (i !== -1) stack.splice(i, 1)
      unbind()
    }
  }, [active])
}
