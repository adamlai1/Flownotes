import { useEffect } from 'react'

// ── Body scroll lock ──────────────────────────────────────────────────────────
//
// iOS makes the whole PAGE scrollable the moment the software keyboard shrinks
// the visual viewport: the layout viewport (100dvh) is taller than what is
// visible, so a drag anywhere pans the entire app shell inside it. This is the
// sibling of the focus-time auto-pan that the create-bubble sheet's
// top-anchoring already avoids — anchoring stops the browser from panning on
// its own, this stops the USER from panning by touch. `overflow: hidden` does
// not prevent it in Safari/WKWebView; `position: fixed` on <body> does,
// because it takes the body out of flow and leaves the document with nothing
// to scroll. Scrollers INSIDE the app (suggestion list, sidebar tree, note
// body) are their own overflow boxes and keep working.
//
// Refcounted: overlays can nest (a dialog over the note editor), and the body
// must stay locked until the LAST one releases. The pre-lock inline styles are
// captured and restored verbatim, so a lock can never leave residue — the
// classic stuck-scroll failure mode — as long as every acquire is paired with
// a release, which the hook's effect cleanup guarantees.

let locks = 0
let restore = null

function acquire() {
  if (locks++ > 0) return
  const b = document.body.style
  const prev = { position: b.position, top: b.top, left: b.left, right: b.right, width: b.width }
  // If iOS already panned the page (keyboard raised before the lock), pin the
  // body at that offset so nothing visibly jumps, and put the scroll back on
  // release.
  const scrollY = window.scrollY
  b.position = 'fixed'
  b.top = `${-scrollY}px`
  b.left = '0'
  b.right = '0'
  b.width = '100%'
  restore = () => {
    b.position = prev.position
    b.top = prev.top
    b.left = prev.left
    b.right = prev.right
    b.width = prev.width
    window.scrollTo(0, scrollY)
  }
}

function release() {
  if (locks > 0 && --locks > 0) return
  locks = 0
  restore?.()
  restore = null
}

// Lock the app shell against page scrolling while `active` is true. Keyed on
// the overlay's own open state, so cancel, create/save, unmount and
// StrictMode's double-invoke all release through the same cleanup path.
export function useBodyScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined
    acquire()
    return release
  }, [active])
}
