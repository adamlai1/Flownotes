import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'framer-motion'
import { CONNECTION_TYPES, CUSTOM_TAG_PALETTE, ROOT_BUBBLE_ID } from '../data/defaultData'
import { getNoteTitle, noteTitle, realBubbleIds, connectionType, generateId } from '../utils/helpers'
import { buildLockIndex } from '../utils/locks'
import { useLock } from '../contexts/LockContext'
import { useToast } from '../contexts/ToastContext'
import { copyNoteText, shareNoteText } from '../utils/noteShare'
import { useDismissOnOutside } from '../lib/dismiss'
import { Capacitor } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { useEscapeLayer, ESC_LEVEL, KEYBOARD_MEDIA_QUERY } from '../lib/escapeStack'
import { useBodyScrollLock } from '../lib/bodyScrollLock'
import { linkSegments } from '../lib/linkify'
import { inlineSegments, toggleInline, toggleLinePrefix, insertLink } from '../lib/mdFormat'
import BubblePickerTree from './BubblePickerTree'

// ONE metric definition for the note-body boxes in UNBOUNDED mode (the read
// div always; the edit textarea on desktop and during the keyboard rise).
// Those two must stay metric-identical — the caret mapping and the scroll
// position surviving the mode swap both depend on it — and a shared object
// is what keeps them from drifting if either gets restyled later. The
// flex-grow stretches the box to fill the full-height page column, so a
// short note's blank space stays part of the box (tap-below-text appends at
// the end) and the stats row beneath is pushed to the screen bottom; long
// notes grow past the fill into one continuous page.
// DELIBERATE exception: while the keyboard is up the textarea leaves this
// style for a fixed-height internally-scrolling box (see boundBoxH) — the
// swap seams there are handled by explicit one-shot scroll conversions, not
// by metric parity.
const BODY_BOX_STYLE = { flex: '1 0 auto', userSelect: 'text', WebkitUserSelect: 'text' }

// Docked details sheet (desktop). The sheet is a permanent column beside
// the note — no chevron, no swipe, no open/close state — when BOTH hold:
//   fine pointer: touch devices keep the slide-in overlay exactly as is
//                 (this alone would dock an iPad with a trackpad in
//                 portrait, where two columns can't fit);
//   ≥ 1100px:     the note column reads comfortably down to ~760px and the
//                 docked sheet needs 340px; 760 + 340 = 1100. Below 1100 a
//                 fine-pointer device gets the overlay.
//
// Placement: the NOTE stays exactly where it is without a sheet — centered,
// 820 wide — and the sheet hangs off its right edge. The pair is therefore
// off-center, weighted right; that is intended. When the sheet would run
// off the right edge of the window (below 820 + 2×340 = 1500px), the pair
// slides left just enough to keep the sheet fully on screen — the note
// gives up centering only by the amount the sheet needs — and below 1160
// the note itself narrows (its max width becomes the window minus the
// sheet). See PANEL_DOCKED_MARGIN_LEFT.
const DOCK_MEDIA_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 1100px)'
const SHEET_DOCK_W = 340
const NOTE_PANEL_W = 820
// Left offset of the note panel when docked, as a CSS clamp against the
// backdrop's width: centered (50% − half the note) while that leaves room
// for the sheet, else pushed left to (width − note − sheet), floored at 0.
// clamp() with max < min yields min, which is the < 1160 case: flush left
// with the note narrowed by maxWidth.
const PANEL_DOCKED_MARGIN_LEFT =
  `clamp(0px, calc(50% - ${NOTE_PANEL_W / 2}px), calc(100% - ${NOTE_PANEL_W + SHEET_DOCK_W}px))`

// Details-sheet bubble tree: how far past the visible tree height the
// expanded tree may reach before the deepest levels fold (depth-limited fit,
// see useFitCollapse). 2 = the tree scrolls up to twice its visible height.
// ONE knob — tune this on device.
const SHEET_TREE_OVERFLOW_RATIO = 2

// Details-sheet chevron prominence. A secondary affordance: dark enough not
// to compete with content, visible enough to be found. ONE knob — tune this
// on device rather than hunting through styles.
const SHEET_CHEVRON_OPACITY = 0.5
// Scroll-linked chevron fade (touch only). The chevron fades on GESTURE
// scrolling only — a finger down, or momentum that followed one; the page's
// own programmatic scroll writes (parking the metadata row on open, the
// return trip after edit, snaps) never fade it, so every non-scroll
// transition shows it at once. It returns CHEVRON_RESTORE_DELAY_MS after the
// last gesture scroll event — the moment the scroll stopped, however it
// stopped — a conservative value that outlasts the native indicator's
// longest fade, so after a scroll the two are never up together. A tap in
// the right-edge region restores it at once (a restore, never an open); if
// momentum is still running then, the two overlap briefly — accepted, rather
// than inferring the indicator's fade from anything. One delay, everywhere.
const CHEVRON_FADE_MS = 180
const CHEVRON_RESTORE_DELAY_MS = 1000
// The chevron's inset from the panel's right edge at its closed rest. 0:
// flush to the edge, in the scroll indicator's lane. The indicator is an iOS
// overlay that reserves no layout space, and the scroll-linked fade keeps
// the two from being up at the same time (the chevron hides while the
// indicator shows and returns after it has gone). chevronX compensates for
// whatever this is, so the OPEN position (the grip straddling the sheet's
// left border) never moves with it.
const CHEVRON_EDGE_INSET = 0

// Height of the formatting pill floating above the software keyboard, and
// the visible gap between the pill and the keyboard's top edge.
const FORMAT_BAR_H = 48
const FORMAT_BAR_GAP = 8

// Body line height: 16px × leading-relaxed (1.625). A fallback bound only —
// anything that can measure reads the live value via lineHeightOf.
const LINE_H = 26
// The textarea's computed line height, which is the height of one caret line
// and therefore the largest scroll an edge-aligned reveal can produce.
function lineHeightOf(el) {
  const v = parseFloat(getComputedStyle(el).lineHeight)
  return Number.isFinite(v) && v > 0 ? v : LINE_H
}
// The bounded box's bottom sits this far above the format bar's top edge.
const BOX_BAR_MARGIN = 8
// Tap clearance has two different edges on purpose. The NO-OP test is the
// bounded box's own bottom edge: a line whose bottom is inside the box is
// visible above the keyboard and bar, and must not move at all. Only a
// line that is NOT inside the box scrolls — and then it lands with a full
// line of margin above the bar, not merely at the edge.
const TAP_LINE_MARGIN = LINE_H
// Duration of the tap-clearance scroll. Smooth for the tap; a keystroke
// during it cancels and snaps (the user is ahead of the animation).
const TAP_SCROLL_MS = 260
// The format bar's top edge in layout-viewport coordinates.
const barTopOf = g => g.bottom - FORMAT_BAR_GAP - FORMAT_BAR_H


// Map a screen point to a character offset in the raw note text. Read mode
// renders one block element per raw line (see renderReadBody), each stamped
// with data-line-start — its line's offset in the raw string — and, when the
// line hides a marker behind a widget (checklists), data-prefix-len. Within a
// line the rendered text is character-identical to the raw text after the
// hidden prefix (linkify only wraps ranges — see linkify.js), so the offset
// is lineStart + prefix + the text-node sum inside that line. Exact on every
// line, checklist lines included. Returns null when the point can't be
// resolved; the caller treats that as "append at the end", which is exactly
// what a tap into the empty space below the last line should do.
function caretOffsetFromPoint(x, y, container) {
  if (!container) return null
  let node, nodeOffset
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y)
    if (!r) return null
    node = r.startContainer
    nodeOffset = r.startOffset
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y)
    if (!p) return null
    node = p.offsetNode
    nodeOffset = p.offset
  } else {
    return null
  }
  if (!container.contains(node)) return null
  // Hit on the container itself. WebKit reports a point in a line's right
  // padding as (container, index AFTER that line) — taking that index's
  // child would land the caret at the START of the NEXT line, attributing
  // the newline to the wrong side. Resolve by geometry instead: the child
  // whose vertical band contains the point owns the tap, and a tap past its
  // text maps to that line's END. No band (below the last line) → null →
  // append.
  if (node === container) {
    const hit = [...node.children].find(k => {
      const r = k.getBoundingClientRect()
      return y >= r.top && y < r.bottom
    })
    if (!hit) return null
    const lineStart = +hit.dataset.lineStart
    const linePrefix = +(hit.dataset.prefixLen || 0)
    let lastText = null
    const w = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) lastText = n
    if (!lastText) return lineStart + linePrefix // empty line (renders a <br>)
    return rawTextOffset(hit, lineStart, linePrefix, lastText, lastText.nodeValue.length)
  }
  return rawOffsetFromDomPosition(node, nodeOffset, container)
}

// Raw offset of a line's END (its last rendered character), or its content
// start when it renders no text (an empty line's <br>).
function lineEndOffset(lineEl) {
  const lineStart = +lineEl.dataset.lineStart
  const prefix = +(lineEl.dataset.prefixLen || 0)
  let lastText = null
  const w = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) lastText = n
  if (!lastText) return lineStart + prefix
  return rawTextOffset(lineEl, lineStart, prefix, lastText, lastText.nodeValue.length)
}

// Map a DOM position (node, offset) inside the read box to a raw text offset —
// the same walk a tap point resolves through, also used for the two endpoints
// of a DOM selection (desktop drag-select → edit with the selection). A
// position ON the container (child index — what a selection that spans whole
// lines reports) resolves to the boundary between lines: index 0 is the first
// line's start, otherwise the END of the line before the index.
function rawOffsetFromDomPosition(node, nodeOffset, container) {
  if (!container || !node || !container.contains(node)) return null
  if (node === container) {
    const kids = [...container.children]
    if (!kids.length) return null
    if (nodeOffset <= 0) return +kids[0].dataset.lineStart + +(kids[0].dataset.prefixLen || 0)
    return lineEndOffset(kids[Math.min(nodeOffset, kids.length) - 1])
  }
  const base = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
  const lineEl = base?.closest?.('[data-line-start]')
  if (!lineEl || !container.contains(lineEl)) return null
  const lineStart = +lineEl.dataset.lineStart
  const prefix = +(lineEl.dataset.prefixLen || 0)
  if (node.nodeType === Node.TEXT_NODE) {
    return rawTextOffset(lineEl, lineStart, prefix, node, nodeOffset)
  }
  // Element hit inside a line (its <br>, a widget, or space past its text):
  // resolve to the end of the last rendered text before the hit point, else
  // the line's content start.
  let lastText = null
  const kids = node.childNodes
  for (let i = 0; i < Math.min(nodeOffset, kids.length); i++) {
    const k = kids[i]
    if (k.nodeType === Node.TEXT_NODE) {
      lastText = k
      continue
    }
    const w = document.createTreeWalker(k, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) lastText = n
  }
  if (!lastText) return lineStart + prefix
  return rawTextOffset(lineEl, lineStart, prefix, lastText, lastText.nodeValue.length)
}

// Raw offset of a (textNode, offsetInNode) position within a rendered line.
// A line with inline formatting stamps every rendered run with data-raw-start
// (the absolute raw offset of the run's first rendered character — hidden
// **/* markers make one number per line insufficient); the walk then happens
// within that run. Unformatted lines map via line start + hidden prefix + the
// in-line text-node sum, exactly as before. Exact either way: the only raw
// positions no tap can produce are the hidden marker characters themselves,
// where the caret lands at the marker's boundary instead.
function rawTextOffset(lineEl, lineStart, prefix, textNode, offsetInNode) {
  const seg = textNode.parentElement?.closest?.('[data-raw-start]')
  const scoped = seg && lineEl.contains(seg)
  const scope = scoped ? seg : lineEl
  const baseOffset = scoped ? +seg.dataset.rawStart : lineStart + prefix
  let total = 0
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  let n
  while ((n = walker.nextNode())) {
    if (n === textNode) return baseOffset + total + offsetInNode
    total += n.nodeValue.length
  }
  return baseOffset
}

// A bullet line: "- text" (but never a checklist's "- ["). LookAHEAD only —
// iOS 15 Safari can't parse lookbehind.
const BULLET_RE = /^- (?!\[[ xX]\] )/
const BULLET_PREFIX_LEN = 2
const HEADER_RE = /^(#{1,3}) /
const HEADER_STYLES = {
  1: { fontSize: '1.5em', fontWeight: 700 },
  2: { fontSize: '1.25em', fontWeight: 700 },
  3: { fontSize: '1.1em', fontWeight: 600 },
}

// A checklist line: "- [ ] text" / "- [x] text" (GFM task syntax; capital X
// accepted). The marker is exactly 6 characters — what read mode hides behind
// the rendered checkbox and what the caret math re-adds via data-prefix-len.
const CHECKLIST_RE = /^- \[([ xX])\] /
const CHECKLIST_PREFIX_LEN = 6

// A numbered line: "1. text". Prefix length varies with the digit count, so
// it's read off the match, never a constant.
const NUMBERED_RE = /^(\d+)\. /

// Checklist editing sugar, applied in handleTextChange to the value the
// keyboard already produced — never via keydown/preventDefault, so it cannot
// fight iOS autocorrect or the software keyboard's own return handling. Only
// an exact single-character insertion is transformed:
//   - a space completing "[] " / "-[] " / "- [] " at a line start normalizes
//     the line into a real "- [ ] " marker;
//   - Enter after a non-empty checklist line continues the list with a fresh
//     unchecked marker;
//   - Enter on an EMPTY checklist item exits the list — the marker and the
//     just-typed newline are both removed, leaving a plain empty line, never
//     an endless run of empty boxes.
// Returns { text, caret } or null to accept the input untouched.
function checklistInputTransform(prevText, val, caret) {
  if (caret == null || caret < 1) return null
  if (val.length !== prevText.length + 1) return null
  const ch = val[caret - 1]
  if (ch === ' ') {
    const lineStart = val.lastIndexOf('\n', caret - 2) + 1
    const before = val.slice(lineStart, caret)
    if (before === '[] ' || before === '-[] ' || before === '- [] ') {
      return {
        text: val.slice(0, lineStart) + '- [ ] ' + val.slice(caret),
        caret: lineStart + CHECKLIST_PREFIX_LEN,
      }
    }
    return null
  }
  if (ch === '\n') {
    const prevLineStart = val.lastIndexOf('\n', caret - 2) + 1
    const prevLine = val.slice(prevLineStart, caret - 1)
    if (!CHECKLIST_RE.test(prevLine)) return null
    if (prevLine.length === CHECKLIST_PREFIX_LEN) {
      // Empty item + Enter = leave the list.
      return { text: val.slice(0, prevLineStart) + val.slice(caret), caret: prevLineStart }
    }
    return { text: val.slice(0, caret) + '- [ ] ' + val.slice(caret), caret: caret + CHECKLIST_PREFIX_LEN }
  }
  return null
}

function formatNoteDate(isoStr) {
  const d = new Date(isoStr)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}


export default function NoteEditor({ note, project, onClose, onUpdateNote, onDeleteNote, onUpdateCustomTagColors, onNavigateToNote, onSwipeProgress, onSetNoteLocked, pinned = false, onTogglePin, backLabel = 'Notes', zIndex = 50 }) {
  const { unlockedIds, requestUnlock, ensurePassword, relockIds } = useLock()
  const showToast = useToast()
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = e => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  // Docked sheet — see DOCK_MEDIA_QUERY. Live: resizing across the line
  // switches layouts in place.
  const [docked, setDocked] = useState(() => window.matchMedia(DOCK_MEDIA_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(DOCK_MEDIA_QUERY)
    const handler = e => setDocked(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  // Single source of truth: the full note text. The title shown in the header is
  // DERIVED from the first non-empty line, so the first line stays in the text and
  // is never pulled out / hidden.
  const [text, setText] = useState(note.content || '')
  // Two-stage body: existing notes open READING (rendered text, tappable
  // links, tappable checkboxes); a tap on the body drops into the textarea
  // with the cursor at the tapped character. Blur (keyboard dismissed, Esc,
  // tap outside) returns to read mode. Brand-new empty notes open straight
  // into edit — capture flow is unchanged. renderReadBody below is the only
  // place that decides how raw text becomes rendered nodes; checklists live
  // there now, further markdown slots in the same per-line seam.
  const [bodyMode, setBodyMode] = useState(() => (note.content ? 'read' : 'edit'))
  const readRef = useRef(null)
  // Caret position carried across the read → edit swap. (Scroll needs no
  // carrying: both modes render at natural height inside the SAME outer
  // scroll container, whose scrollTop survives the swap on its own.)
  const pendingCaretRef = useRef(null)
  // '' = no manual title: the header derives from the first body line and
  // follows it live. Non-empty = the user set it by hand; it stays fixed
  // until they clear it, which reverts to deriving (stored as null).
  const [customTitle, setCustomTitle] = useState((note.title ?? '').trim())
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleDraftInitialRef = useRef('')
  // A note always has at least one location: legacy notes saved with an empty
  // bubble_ids open as pinned to the project canvas, and the next save
  // persists that normalization.
  const [selectedBubbleIds, setSelectedBubbleIds] = useState(() =>
    (note.bubble_ids ?? []).length ? note.bubble_ids : [ROOT_BUBBLE_ID])
  const [tags, setTags] = useState(note.tags)
  const [tagInput, setTagInput] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [connections, setConnections] = useState(note.connections)
  const [addingConnection, setAddingConnection] = useState(false)
  const [connNoteId, setConnNoteId] = useState('')
  const [connType, setConnType] = useState(CONNECTION_TYPES[0])
  const [customConnType, setCustomConnType] = useState('')
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isClosing, setIsClosing] = useState(false)
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const bodyRef = useRef(null)
  const scrollAreaRef = useRef(null)
  // The note column inside the scroll area (metadata row excluded). Pinned
  // to its current height across any moment the textarea passes through
  // its auto height — see pinColumn / the auto-grow effect.
  const columnRef = useRef(null)
  // Pin the column at its current height. WHY: a textarea's auto height is
  // its `rows` height, not its text — so the instant the textarea is laid
  // out at auto (the read → edit swap, before auto-grow has set its px
  // height; and every auto-grow re-measure), the column shrinks to its
  // minHeight, the scroll area's content collapses to ~one screen, and the
  // scroll area's scrollTop CLAMPS to that. WebKit has no scroll anchoring
  // to undo it, so on a note scrolled past the top every tap-to-edit jumped
  // to the top of the note before the keyboard even rose (the clearance
  // scroll then dragged the tapped line back from off-screen — seen as
  // "lands too low" / "moves when it shouldn't"). With the column held at
  // its height, the content never shrinks and nothing clamps. Uses `height`
  // (not minHeight, which React owns) and is cleared by the auto-grow sync
  // once the textarea carries its own px height.
  const pinColumn = () => {
    const col = columnRef.current
    if (col && !col.style.height) col.style.height = `${col.getBoundingClientRect().height}px`
  }
  const unpinColumn = () => {
    const col = columnRef.current
    if (col) col.style.height = ''
  }

  // (The old desktop wheel-chaining for the body boxes is gone WITH the
  // boxes' inner scrollers: content scrolls only in the outer scroll area
  // now, natively — a forwarding handler here would scroll it twice.)
  const tagInputRef = useRef(null)
  const saveTimerRef = useRef(null)
  const swipeRef = useRef({ active: false, startX: 0, currentX: 0 })
  // ── Claiming a touch for the sheet ──────────────────────────────────────
  // React's touch listeners are PASSIVE, so nothing in the JSX handlers can
  // stop iOS from also scrolling the note under a sheet drag. The claim is
  // made in a native, non-passive touchmove listener on the panel (below):
  // it makes the direction decision for the two sheet gestures on the first
  // qualifying move — while the event is still cancelable, i.e. before the
  // scroll view has taken the touch — and once a gesture is recognized as
  // the sheet's, every subsequent touchmove of that touch is preventDefault-ed,
  // so the scroller never receives it. touchClaimRef names the owner for the
  // current touch: 'open' (edge drag opening the sheet), 'sheet' (drag on the
  // open sheet), 'strip' (any touch on the note strip while the sheet is
  // open — the note is not scrollable then at all). The JSX handlers only
  // TRACK (sheetX follows the finger); they no longer decide.
  const panelRef = useRef(null)
  const touchClaimRef = useRef(null)
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const onMove = (e) => {
      const t = e.touches[0]
      if (!t) return
      const os = sheetOpenSwipeRef.current
      if (os.active && !os.decided) {
        const odx = t.clientX - os.startX
        const ody = t.clientY - os.startY
        if (Math.abs(odx) >= 6 || Math.abs(ody) >= 6) {
          os.decided = true
          // Horizontal-and-leftward engages the sheet — only while the touch
          // can still be claimed; a vertical drag from the edge stays a scroll.
          os.engaged = e.cancelable && Math.abs(odx) > Math.abs(ody) && odx < 0
          if (os.engaged) touchClaimRef.current = 'open'
        }
      }
      const d = sheetDragRef.current
      if (d.active && !d.decided) {
        const dx = t.clientX - d.startX
        const dy = t.clientY - d.startY
        if (Math.abs(dx) >= 6 || Math.abs(dy) >= 6) {
          d.decided = true
          d.horizontal = e.cancelable && Math.abs(dx) > Math.abs(dy)
          if (d.horizontal) touchClaimRef.current = 'sheet'
        }
      }
      if (touchClaimRef.current && e.cancelable) e.preventDefault()
    }
    el.addEventListener('touchmove', onMove, { passive: false })
    return () => el.removeEventListener('touchmove', onMove)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleSave = useCallback((content, bubbleIds, tagsArr, connsArr) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      onUpdateNote(note.id, {
        content,
        bubble_ids: bubbleIds,
        tags: tagsArr,
        connections: connsArr,
      })
    }, 500)
  }, [note.id, onUpdateNote])

  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [])


  useEffect(() => {
    if (addingTag) tagInputRef.current?.focus({ preventScroll: true })
  }, [addingTag])

  // A brand-new (empty) note opens straight into typing mode — focused, cursor
  // ready, keyboard up — with no extra tap.
  useEffect(() => {
    if (note.content) return
    const el = bodyRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    try { el.setSelectionRange(end, end) } catch { /* not all inputs support it */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: register any custom tags on this note that aren't yet in the project color map.
  // This ensures toggling a custom tag off never removes the pill — it just deselects it.
  useEffect(() => {
    const existingColors = project.customTagColors || {}
    const unregistered = note.tags.filter(t => !existingColors[t])
    if (unregistered.length === 0) return
    const updated = { ...existingColors }
    unregistered.forEach(tag => {
      const usedColors = new Set(Object.values(updated))
      updated[tag] = CUSTOM_TAG_PALETTE.find(c => !usedColors.has(c)) ??
        CUSTOM_TAG_PALETTE[Object.keys(updated).length % CUSTOM_TAG_PALETTE.length]
    })
    onUpdateCustomTagColors?.(updated)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps


  function handleClose() {
    if (isClosing) return
    setIsClosing(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (!text.trim()) {
      onDeleteNote(note.id)
    } else {
      onUpdateNote(note.id, { content: text, bubble_ids: selectedBubbleIds, tags, connections })
    }
    onClose()
  }

  // Escape closes the note the same way the back arrow does — same save, same
  // slide-back. The body textarea isn't handled here: while it has focus the global
  // listener just blurs it, so it takes a second press to reach this.
  useEscapeLayer(true, handleClose, zIndex)
  // Its own delete confirm sits above it (matching the modal's zIndex + 10).
  useEscapeLayer(showDeleteConfirm, () => setShowDeleteConfirm(false), zIndex + 10)
  // The editor is mounted only while open, and its textarea raises the keyboard —
  // hold the app shell still for its whole lifetime (see bodyScrollLock). The
  // editor's own body row scrolls internally and is unaffected.
  useBodyScrollLock(true)

  function pushHistory(prevText) {
    setPast(p => [...p.slice(-49), prevText])
    setFuture([])
  }

  function undo() {
    if (past.length === 0) return
    const prev = past[past.length - 1]
    setPast(p => p.slice(0, -1))
    setFuture(f => [text, ...f])
    setText(prev)
    scheduleSave(prev, selectedBubbleIds, tags, connections)
  }

  function redo() {
    if (future.length === 0) return
    const next = future[0]
    setFuture(f => f.slice(1))
    setPast(p => [...p, text])
    setText(next)
    scheduleSave(next, selectedBubbleIds, tags, connections)
  }

  // Caret/selection restore after a programmatic transform (a bare number
  // for a caret, or { start, end } for a selection): the controlled textarea
  // re-renders with the transformed value, then this places the selection
  // where the transform said it belongs. Inert (ref stays null) on normal
  // typing. Today only the checklist typing sugar uses it.
  const transformCaretRef = useRef(null)
  useLayoutEffect(() => {
    if (transformCaretRef.current == null) return
    const sel = transformCaretRef.current
    transformCaretRef.current = null
    const el = bodyRef.current
    if (el) {
      const start = typeof sel === 'number' ? sel : sel.start
      const end = typeof sel === 'number' ? sel : sel.end
      try { el.setSelectionRange(start, end) } catch { /* not all inputs support it */ }
    }
  }, [text])

  function handleTextChange(e) {
    // Typing during the tap-clearance scroll: the user is ahead of the
    // animation — snap to its target and let iOS's native caret reveal
    // take over from here.
    cancelTapScroll(true)
    const val = e.target.value
    const t = checklistInputTransform(text, val, e.target.selectionStart)
    pushHistory(text)
    if (t) {
      transformCaretRef.current = t.caret
      setText(t.text)
      scheduleSave(t.text, selectedBubbleIds, tags, connections)
    } else {
      setText(val)
      scheduleSave(val, selectedBubbleIds, tags, connections)
    }
  }

  // Ticking a box is a text edit: same history push, same debounced save as
  // typing, so undo/redo, autosave, close-flush and sync need nothing new —
  // checked state lives in the note text ("- [ ]" ↔ "- [x]").
  function toggleChecklistAt(lineStart) {
    if (!CHECKLIST_RE.test(text.slice(lineStart, lineStart + CHECKLIST_PREFIX_LEN))) return
    const boxPos = lineStart + 3
    const next = text.slice(0, boxPos) + (text[boxPos] === ' ' ? 'x' : ' ') + text.slice(boxPos + 1)
    pushHistory(text)
    setText(next)
    scheduleSave(next, selectedBubbleIds, tags, connections)
  }

  // ── Read mode ──────────────────────────────────────────────────────────

  // Inline rendering within one line: linkify only — the segments' text
  // concatenates to the line text exactly (see linkify.js), which the caret
  // math relies on. Links open externally: on native iOS, Capacitor's
  // WKWebView delegation routes any external URL to UIApplication.open (the
  // system Safari, not the in-app sheet); on web this is a normal new tab.
  function renderInline(content) {
    return linkSegments(content).map((seg, i) =>
      seg.type === 'link' ? (
        <a
          key={i}
          href={seg.href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
          style={{ color: '#6366f1' }}
          // A link tap is a link tap — never an "edit here" tap.
          onClick={e => e.stopPropagation()}
        >
          {seg.text}
        </a>
      ) : (
        seg.text
      )
    )
  }

  // Inline rendering with bold/italic/strike/link support. Cheap path: a line
  // with no inline markers renders exactly as renderInline does, and the
  // caret math's line-walk stays valid. Formatted path: EVERY rendered run —
  // formatted or plain — is wrapped in a span stamped with data-raw-start
  // (the absolute raw offset of its first rendered character), because once
  // any marker in the line is hidden, a single per-line number can no longer
  // describe the mapping; the caret math then resolves within the run (see
  // rawTextOffset). A markdown link's label renders as the same kind of <a>
  // the linkifier makes (same open-externally route); its url is hidden, so
  // the linkifier — which only ever sees the OTHER segments' text — cannot
  // double-handle it, while bare URLs in those segments still linkify.
  function renderInlineFormatted(str, rawBase) {
    const segs = inlineSegments(str)
    if (!segs.some(s => s.bold || s.italic || s.strike || s.link)) return renderInline(str)
    return segs.map((seg, i) => (
      <span
        key={i}
        data-raw-start={rawBase + seg.rawStart}
        style={seg.bold || seg.italic || seg.strike ? {
          fontWeight: seg.bold ? 600 : undefined,
          fontStyle: seg.italic ? 'italic' : undefined,
          textDecoration: seg.strike ? 'line-through' : undefined,
        } : undefined}
      >
        {seg.link ? (
          <a
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
            style={{ color: '#6366f1' }}
            // A link tap is a link tap — never an "edit here" tap.
            onClick={e => e.stopPropagation()}
          >
            {seg.text}
          </a>
        ) : (
          renderInline(seg.text)
        )}
      </span>
    ))
  }

  // The render seam: raw text → rendered nodes, one block element per raw
  // line. Every line carries data-line-start (its offset in the raw string)
  // and, when it hides a marker behind a widget or styling, data-prefix-len —
  // what caretOffsetFromPoint needs to keep tap-to-edit exact. Line markers:
  // checklist ("- [ ] " → tappable checkbox), bullet ("- " → dot widget,
  // never substituted characters), headers ("#"–"###" → sized text). Inline:
  // bold/italic via renderInlineFormatted. The text after any hidden marker
  // stays character-identical to the raw line.
  function renderReadBody(content) {
    const lines = content.split('\n')
    let offset = 0
    return lines.map(line => {
      const start = offset
      offset += line.length + 1
      const m = line.match(CHECKLIST_RE)
      if (!m) {
        const bm = line.match(BULLET_RE)
        if (bm) {
          return (
            <div key={start} data-line-start={start} data-prefix-len={BULLET_PREFIX_LEN}>
              {/* Bullet widget: no text nodes (the caret math walks text
                  nodes; the marker's 2 chars live in data-prefix-len). */}
              <span
                aria-hidden="true"
                className="inline-flex items-center justify-center align-middle"
                style={{ width: 18, height: 18, marginRight: '0.35em' }}
              >
                <svg width="6" height="6" viewBox="0 0 6 6">
                  <circle cx="3" cy="3" r="3" fill="currentColor" />
                </svg>
              </span>
              {renderInlineFormatted(line.slice(BULLET_PREFIX_LEN), start + BULLET_PREFIX_LEN)}
            </div>
          )
        }
        const nm = line.match(NUMBERED_RE)
        if (nm) {
          const plen = nm[0].length
          return (
            <div key={start} data-line-start={start} data-prefix-len={plen}>
              {/* Number widget: the digits render via CSS content (see
                  .md-num in index.css) so the DOM holds NO text node — the
                  caret math walks text nodes, and the marker's characters
                  live in data-prefix-len, exactly like the checkbox. */}
              <span
                aria-hidden="true"
                className="md-num align-middle"
                data-num={`${nm[1]}.`}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end',
                  minWidth: 18, height: 18, marginRight: '0.35em',
                  fontVariantNumeric: 'tabular-nums',
                }}
              />
              {renderInlineFormatted(line.slice(plen), start + plen)}
            </div>
          )
        }
        const hm = line.match(HEADER_RE)
        if (hm) {
          const level = hm[1].length
          return (
            <div key={start} data-line-start={start} data-prefix-len={level + 1} style={HEADER_STYLES[level]}>
              {renderInlineFormatted(line.slice(level + 1), start + level + 1)}
            </div>
          )
        }
        return (
          <div key={start} data-line-start={start}>
            {line ? renderInlineFormatted(line, start) : <br />}
          </div>
        )
      }
      const checked = m[1] !== ' '
      const rest = line.slice(CHECKLIST_PREFIX_LEN)
      return (
        <div key={start} data-line-start={start} data-prefix-len={CHECKLIST_PREFIX_LEN}>
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={checked ? 'Uncheck item' : 'Check item'}
            // A checkbox tap is a toggle — never an "edit here" tap.
            onClick={e => { e.stopPropagation(); toggleChecklistAt(start) }}
            className="inline-flex items-center justify-center align-middle"
            // 34×30 touch target; the negative margins keep the layout box at
            // 18×18 so line height doesn't grow. No text content — the caret
            // math walks text nodes, and the marker's 6 chars are accounted
            // for by data-prefix-len, not the DOM.
            style={{ width: 34, height: 30, margin: '-6px -8px', marginRight: 'calc(0.45em - 8px)', touchAction: 'manipulation' }}
          >
            <span
              className="inline-flex items-center justify-center flex-shrink-0"
              style={{
                width: 18, height: 18, borderRadius: 5,
                border: checked ? 'none' : '1.5px solid #6b7280',
                background: checked ? '#6366f1' : 'transparent',
              }}
            >
              {checked && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
          </button>
          <span style={checked ? { color: '#6b7280' } : undefined}>
            {rest ? renderInlineFormatted(rest, start + CHECKLIST_PREFIX_LEN) : null}
          </span>
        </div>
      )
    })
  }

  function handleReadTap(e) {
    const container = readRef.current
    const sel = window.getSelection?.()
    if (sel && !sel.isCollapsed) {
      // A selection exists. Touch: it came from a long-press, and it stays a
      // read-mode selection (copy / look up / share) — entering edit would
      // put a keyboard between the user and the callout. Fine pointer: it
      // came from a drag, whose mouseup ends in this click; the drag means
      // "edit here", so enter edit with the same range selected. Endpoints
      // outside the read box (a drag that ran into the chrome) are left
      // alone rather than guessed.
      if (!hasFinePointer) return
      const r = sel.rangeCount ? sel.getRangeAt(0) : null
      if (!r) return
      const a = rawOffsetFromDomPosition(r.startContainer, r.startOffset, container)
      const b = rawOffsetFromDomPosition(r.endContainer, r.endOffset, container)
      if (a == null || b == null || a === b) return
      pendingCaretRef.current = { start: Math.min(a, b), end: Math.max(a, b) }
      pendingTapLineRef.current = null
      pinColumn()
      setBodyMode('edit')
      return
    }
    // Append is the default: a tap that resolves to nothing (the empty space
    // past the last line) edits at the END of the note, never nowhere.
    const resolved = caretOffsetFromPoint(e.clientX, e.clientY, container)
    pendingCaretRef.current = resolved != null ? resolved : text.length
    // An append (tap past the text — the read box's blank space or the tail
    // element) is about the LAST LINE, not the tap point: the clearance
    // check below should bring that line clear of the bar, not a point
    // half a screen under it.
    const lastLine = resolved == null ? container?.lastElementChild : null
    // Where the tapped LINE's bottom sits, as a coordinate inside the note
    // content (relative to the read box's top; the textarea replaces it
    // metric-identically, so the coordinate survives the swap and any
    // scrolling in between). The bounding conversion uses it to decide
    // whether the line is already clear of the keyboard + format bar and,
    // only if not, by exactly how much to scroll. The caret rect from the
    // hit test gives the visual line's bottom (right even inside a wrapped
    // paragraph); fall back to half a line below the touch point.
    const readTop = container ? container.getBoundingClientRect().top : null
    let lineBottom = e.clientY + LINE_H / 2
    if (lastLine) {
      lineBottom = lastLine.getBoundingClientRect().bottom
    } else {
      const hit = document.caretRangeFromPoint?.(e.clientX, e.clientY)
      const hitRect = hit?.getBoundingClientRect()
      if (hitRect && hitRect.height > 0) lineBottom = Math.max(hitRect.bottom, e.clientY)
    }
    pendingTapLineRef.current = readTop != null ? lineBottom - readTop : null
    // Before the swap, while the read box still holds the column's height:
    // the textarea that replaces it is laid out at its auto height first
    // (focus() forces that layout before auto-grow runs), and without the
    // pin the scroll area clamps to the top of the note right there.
    pinColumn()
    setBodyMode('edit')
  }

  // After the read → edit swap: focus and place the caret at the tapped
  // character. Scroll position needs nothing — both boxes render at natural,
  // metric-identical height in the same outer scroll container, so the swap
  // leaves the visible lines where they were.
  useLayoutEffect(() => {
    if (bodyMode !== 'edit') return
    const off = pendingCaretRef.current
    if (off == null) return
    pendingCaretRef.current = null
    const el = bodyRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    // A number places the caret; { start, end } carries a selection across
    // (desktop drag-select in read mode).
    const range = typeof off === 'number' ? { start: off, end: off } : off
    const clamp = v => Math.max(0, Math.min(v, el.value.length))
    try { el.setSelectionRange(clamp(range.start), clamp(range.end)) } catch { /* not all inputs support it */ }
  }, [bodyMode])

  // Membership invariants: a note always has at least one selection. The
  // project-canvas sentinel deselects itself when the FIRST real bubble is
  // picked (the note has moved into a bubble), re-selects itself when the
  // last real bubble is removed (a note is never left with no location), can
  // be re-added manually at any time without evicting real bubbles, and can
  // only be removed while a real bubble remains.
  function toggleBubble(id) {
    let updated
    if (selectedBubbleIds.includes(id)) {
      updated = selectedBubbleIds.filter(b => b !== id)
      if (id === ROOT_BUBBLE_ID) {
        if (realBubbleIds(updated).length === 0) return // sole location — keep it
      } else if (realBubbleIds(updated).length === 0 && !updated.includes(ROOT_BUBBLE_ID)) {
        updated = [...updated, ROOT_BUBBLE_ID]
      }
    } else {
      updated = [...selectedBubbleIds, id]
      // Only the 0 → first real bubble transition evicts the sentinel;
      // adding further bubbles never removes a manually re-selected pin.
      if (id !== ROOT_BUBBLE_ID && realBubbleIds(selectedBubbleIds).length === 0) {
        updated = updated.filter(b => b !== ROOT_BUBBLE_ID)
      }
    }
    setSelectedBubbleIds(updated)
    scheduleSave(text, updated, tags, connections)
  }

  function toggleTag(tag) {
    const updated = tags.includes(tag)
      ? tags.filter(t => t !== tag)
      : [...tags, tag]
    setTags(updated)
    scheduleSave(text, selectedBubbleIds, updated, connections)
  }

  function addCustomTag() {
    const tag = tagInput.trim().replace(/^#/, '')
    if (tag && !tags.includes(tag)) {
      const updated = [...tags, tag]
      setTags(updated)
      const existingColors = project.customTagColors || {}
      if (!existingColors[tag]) {
        const usedColors = new Set(Object.values(existingColors))
        const nextColor =
          CUSTOM_TAG_PALETTE.find(c => !usedColors.has(c)) ??
          CUSTOM_TAG_PALETTE[Object.keys(existingColors).length % CUSTOM_TAG_PALETTE.length]
        onUpdateCustomTagColors?.({ ...existingColors, [tag]: nextColor })
      }
      scheduleSave(text, selectedBubbleIds, updated, connections)
    }
    setTagInput('')
    setAddingTag(false)
  }

  function removeTag(tag) {
    const updated = tags.filter(t => t !== tag)
    setTags(updated)
    scheduleSave(text, selectedBubbleIds, updated, connections)
  }

  function addConnection() {
    if (!connNoteId) return
    const type = connType === '__custom__' ? customConnType.trim() : connType
    if (!type) return
    // `type` is the canonical field (what the cloud loader produces and the
    // uploader sends); reads go through connectionType so legacy local
    // objects that used relationship_type keep working. The id is client-made
    // like note/bubble ids — connections.id has no DB default, and a stable
    // id is what lets syncs upsert instead of multiplying rows.
    const updated = [...connections, { id: generateId(), note_id: connNoteId, type }]
    setConnections(updated)
    onUpdateNote(note.id, { connections: updated })
    setConnNoteId('')
    setConnType(CONNECTION_TYPES[0])
    setCustomConnType('')
    setAddingConnection(false)
  }

  function removeConnection(idx) {
    const updated = connections.filter((_, i) => i !== idx)
    setConnections(updated)
    onUpdateNote(note.id, { connections: updated })
  }

  function handleDelete() {
    setShowDeleteConfirm(true)
  }

  // ── Header "..." menu ────────────────────────────────────────────────────
  // Outside-press + Escape through the shared dismiss hook — no second
  // mechanism. The escape layer must sit ABOVE the editor's own close layer
  // (zIndex, ESC_LEVEL.note-based) or Escape-with-menu-open would close the
  // whole note; zIndex + 5 stays below the delete confirm at zIndex + 10.
  const [showHeaderMenu, setShowHeaderMenu] = useState(false)
  const headerMenuRef = useRef(null)
  const headerMenuBtnRef = useRef(null)
  useDismissOnOutside(
    showHeaderMenu,
    () => setShowHeaderMenu(false),
    [headerMenuRef, headerMenuBtnRef],
    { escLevel: zIndex + 5 },
  )

  // An OPEN note is by definition revealed, so this is only ever the simple
  // half of the card menus' toggle: remove an existing lock outright, or
  // create one (password required first). The hidden-note password-prompt
  // branch can't be reached from inside the editor.
  function handleToggleLock() {
    setShowHeaderMenu(false)
    if (note.locked) { onSetNoteLocked?.(note.id, false); return }
    ensurePassword(() => { relockIds(note.id); onSetNoteLocked?.(note.id, true) })
  }

  // ── Details sheet ────────────────────────────────────────────────────────
  // Tags, filing and connections — organization, not writing. Slides in from
  // the right over most of the width; the strip of note left visible closes
  // it (outside-press via the shared dismiss hook, which also swallows the
  // click so the tap can't edit the note), as do the chevrons, a rightward
  // drag, and Escape (registered above the editor's own close layer, below
  // the delete confirm).
  //
  // Motion: the sheet is ALWAYS mounted (as its content was when it lived in
  // the scrolling page) and driven by ONE motion value — sheetX, px from
  // fully open. Drags write the finger position into it 1:1; every release
  // hands it to a framer spring, which inherits the motion value's live
  // velocity: a fast flick completes fast, a slow drag settles slowly, a
  // short release snaps back. The closed rest position is the sheet's width
  // plus a margin, putting its border and shadow fully past the panel's
  // overflow clip so nothing bleeds while closed; `inert` keeps the hidden
  // content out of desktop's tab order.
  const [sheetOpen, setSheetOpen] = useState(false)
  const sheetOpenRef = useRef(false)
  const sheetRef = useRef(null)
  const sheetColRef = useRef(null)
  const sheetTreeBoxRef = useRef(null)
  const sheetConnRef = useRef(null)
  // The fit session starts only once the sheet is measurable. The picker's
  // fit decision runs in ITS layout effect, and React runs a child's layout
  // effects before it attaches refs on ancestor elements — so at the picker's
  // mount the column and tree-box refs above it are still null, the
  // measurement was "unknowable", the rule expanded everything blind, and the
  // resize observer (which asks for the same ref) never attached. This flag
  // is set in the editor's own layout effect, which runs after the children's
  // and after ref attachment; a state update from a layout effect is flushed
  // synchronously before paint (React commits sync-lane work scheduled during
  // layout effects before returning to the browser — same code path in the
  // production build), so the first painted frame carries a real decision.
  const [sheetReady, setSheetReady] = useState(false)
  useLayoutEffect(() => { setSheetReady(true) }, [])
  // The room the bubble tree may occupy, from FIXED geometry only — nothing
  // here depends on how tall the tree currently is (a measurement derived
  // from the tree's own height answered the question it was meant to
  // decide): the column's content bottom, minus the tree box's top (everything
  // above it is fixed-height), minus the section below it (Connections) and
  // the column gap before that section. "Fits" therefore means fits in the
  // REMAINING space. The rule is depth-limited (SHEET_TREE_OVERFLOW_RATIO): a
  // tree that fits expands fully with no scrollbar; a deeper one opens as far
  // down as keeps the expanded height within the ratio × the remainder,
  // deepest levels folded first, and the tree box — the only scrollable thing
  // in the sheet — scrolls internally by up to that ratio. Tags, project and
  // connections never move. Docked (desktop) skips the rule entirely.
  const sheetTreeAvailable = () => {
    const col = sheetColRef.current
    const tree = sheetTreeBoxRef.current
    const after = sheetConnRef.current
    if (!col || !tree || !after) return null // unknowable → expand
    const cs = getComputedStyle(col)
    const contentBottom = col.getBoundingClientRect().bottom - (parseFloat(cs.paddingBottom) || 0)
    const gap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 0
    return contentBottom - tree.getBoundingClientRect().top - after.offsetHeight - gap
  }
  // Chevron visibility: hidden while typing — every EXISTING note opens in
  // read mode, so the affordance is seen before edit is ever reached. The
  // exception is a brand-new note, which opens straight into edit and never
  // passes read mode: `everRead` starts false there, keeping the chevron up
  // for that first capture; the first trip through read mode makes it a
  // normal note.
  const [everRead, setEverRead] = useState(() => !!note.content)
  useEffect(() => {
    if (bodyMode === 'read' && !everRead) setEverRead(true)
  }, [bodyMode, everRead])
  const chevronVisible = !sheetOpen && (bodyMode === 'read' || !everRead)
  // The note column's horizontal padding (className px-5 / md:px-10 on the
  // column) — the bounded box extends under the right half of it so its
  // scroll indicator sits at the screen edge like the page's. Same 768px
  // breakpoint as the md: variant.
  const bodyPadX = isDesktop ? 40 : 20
  // Scroll-linked fade (see CHEVRON_FADE_MS / CHEVRON_RESTORE_DELAY_MS).
  // State drives the opacity; the ref mirrors it for the touch handlers,
  // which must not close over a stale render. A tap that restores the
  // chevron is flagged so the click it produces is swallowed rather than
  // opening the sheet.
  //
  // The restore timer is armed by TOUCH END (and by momentum scroll events
  // after the finger is up, which re-arm it so it fires once the momentum
  // ends) — never by a scroll event while a finger is down. So a held,
  // motionless finger keeps the chevron hidden, in step with the native
  // scroll indicator, and the delay counts from the lift.
  const [chevronFaded, setChevronFaded] = useState(false)
  const chevronFadedRef = useRef(false)
  const chevronRestoreTimerRef = useRef(null)
  const chevronRestoreTapRef = useRef(false)
  // True from a touch's start until the scroll it started has settled (or at
  // touch end, if it never scrolled): the gate that makes momentum count as
  // gesture scrolling and programmatic writes not. A tap-restore closes it
  // too, so momentum still running after the tap doesn't re-fade the chevron.
  const gestureScrollRef = useRef(false)
  const restoreChevron = () => {
    clearTimeout(chevronRestoreTimerRef.current)
    gestureScrollRef.current = false
    if (chevronFadedRef.current) { chevronFadedRef.current = false; setChevronFaded(false) }
  }
  // Leaving edit mode is not a scroll: show the chevron at once (its
  // visibility rule already keeps it hidden while editing).
  useEffect(() => {
    if (bodyMode === 'read') restoreChevron()
  }, [bodyMode]) // eslint-disable-line react-hooks/exhaustive-deps
  const armChevronRestore = () => {
    clearTimeout(chevronRestoreTimerRef.current)
    if (chevronFadedRef.current) {
      chevronRestoreTimerRef.current = setTimeout(restoreChevron, CHEVRON_RESTORE_DELAY_MS)
    }
  }
  // Restore by tap: immediate. No attempt to halt momentum or wait out the
  // indicator's fade — a brief overlap there is accepted.
  const restoreChevronByTap = restoreChevron
  const fadeChevronForScroll = () => {
    if (hasFinePointer) return // desktop overlay: as-is
    if (!touchActiveRef.current && !gestureScrollRef.current) return // programmatic: not scrolling
    if (!chevronFadedRef.current) { chevronFadedRef.current = true; setChevronFaded(true) }
    if (touchActiveRef.current) clearTimeout(chevronRestoreTimerRef.current) // finger down: stay hidden
    else armChevronRestore() // momentum: re-arm from each event, fires after the last
  }
  useEffect(() => () => clearTimeout(chevronRestoreTimerRef.current), [])
  const sheetWidth = () =>
    Math.min((isDesktop ? Math.min(820, window.innerWidth) : window.innerWidth) - 56, 380)
  const sheetClosedX = () => sheetWidth() + 12
  const sheetX = useMotionValue(sheetClosedX())
  // Keep the closed rest position correct across rotation/resize.
  useEffect(() => {
    const sync = () => { if (!sheetOpenRef.current) sheetX.jump(sheetClosedX()) }
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // THE chevron — one element for the sheet's whole life. Its position is a
  // pure function of sheetX (nothing to hide, nothing to coordinate, no
  // second copy): at the closed rest it hugs the screen edge as the pull
  // tab; fully open it straddles the sheet's left border as the grip; in
  // between it interpolates, tracking a drag frame-for-frame. (It can't be
  // a CHILD of the sheet: the closed rest parks the sheet wholly past the
  // panel's overflow clip — border and shadow must not bleed — and a child
  // chevron would be clipped off-screen with it. A sibling driven by the
  // same motion value is the version of "belongs to the sheet" that
  // survives the clip.)
  const chevronRef = useRef(null)
  const chevronX = useTransform(sheetX, v => (14 + CHEVRON_EDGE_INSET - sheetWidth()) * (1 - v / sheetClosedX()))

  // Docking makes the overlay's open state meaningless; clear it so a later
  // undock starts from the closed rest (and the dismiss hook stays idle).
  useEffect(() => {
    if (!docked || !sheetOpenRef.current) return
    sheetOpenRef.current = false
    setSheetOpen(false)
    sheetX.jump(sheetClosedX())
  }, [docked]) // eslint-disable-line react-hooks/exhaustive-deps

  useDismissOnOutside(
    sheetOpen && !docked,
    () => settleSheet(false),
    // The chevron toggles rather than dismiss-and-reopen (per the hook's own
    // contract for triggers), so its press reaches onClick.
    [sheetRef, chevronRef],
    { escLevel: zIndex + 4 },
  )

  // One settle path for every route — chevron, strip, Escape, drag release:
  // state plus a spring that picks up whatever velocity the finger left.
  function settleSheet(open) {
    sheetOpenRef.current = open
    setSheetOpen(open)
    animate(sheetX, open ? 0 : sheetClosedX(), { type: 'spring', stiffness: 420, damping: 42 })
  }

  // Opening blurs the body: the keyboard and format bar dismiss through the
  // same blur → read path as every other route, and the sheet slides over a
  // read-mode note — no sheet-over-keyboard stacking to reason about.
  function openSheet() {
    bodyRef.current?.blur()
    settleSheet(true)
  }

  // Right-edge open drag (armed in handleTouchStart): decided/engaged in the
  // first ~8px — horizontal-and-leftward tracks the sheet in 1:1, anything
  // else leaves the touch to whatever it was for.
  const sheetOpenSwipeRef = useRef({ active: false, decided: false, engaged: false, startX: 0, startY: 0 })

  // Chevron drag — the grip drags the sheet 1:1 in BOTH directions, exactly
  // like dragging the sheet body: same thresholds, same velocity-carried
  // settle. Tap-vs-drag is decided by MOVEMENT (8px), never timing, so a
  // slow deliberate drag is a drag; `moved` also gates onClick so a drag's
  // trailing click can't double-toggle. Touch events stop here (the grip
  // owns its gesture — panel recognizers stay out of it) and touchAction
  // none keeps the browser from chaining a pan.
  const chevronDragRef = useRef({ active: false, moved: false, fromOpen: false, startX: 0, startBase: 0 })
  function handleChevronTouchStart(e) {
    e.stopPropagation()
    // A touch on the faded chevron brings it back at once; that touch's click
    // is then a restore, not an open (see onClick). Drags still track.
    chevronRestoreTapRef.current = chevronFadedRef.current
    if (chevronFadedRef.current) restoreChevronByTap()
    const t = e.touches[0]
    const base = sheetX.get()
    chevronDragRef.current = {
      active: true, moved: false,
      fromOpen: base < sheetClosedX() / 2,
      startX: t.clientX, startBase: base,
    }
  }
  function handleChevronTouchMove(e) {
    e.stopPropagation()
    const d = chevronDragRef.current
    if (!d.active) return
    const dx = e.touches[0].clientX - d.startX
    if (!d.moved && Math.abs(dx) < 8) return
    d.moved = true
    sheetX.set(Math.min(sheetClosedX(), Math.max(0, d.startBase + dx)))
  }
  function handleChevronTouchEnd(e) {
    e.stopPropagation()
    const d = chevronDragRef.current
    if (!d.active) return
    d.active = false
    if (!d.moved) return // a tap — onClick toggles
    // Same release rules as the sheet-body and edge drags, picked by which
    // rest position the drag started from.
    const v = sheetX.getVelocity()
    if (d.fromOpen) {
      const shouldClose = v > 500 || (sheetX.get() > sheetWidth() / 3 && v > -200)
      settleSheet(!shouldClose)
    } else {
      const pulled = sheetClosedX() - sheetX.get()
      if (v < -500 || (pulled > 80 && v < 200)) openSheet()
      else settleSheet(false)
    }
  }

  // Drag-to-close: same axis decision on the sheet itself; vertical wins →
  // the sheet's own scroller keeps the gesture. Thresholds: a rightward
  // flick past 500 px/s closes regardless of distance; past a third of the
  // width closes unless the finger was flicking back; anything else snaps
  // back — all through the same velocity-inheriting settle.
  const sheetDragRef = useRef({ active: false, decided: false, horizontal: false, startX: 0, startY: 0 })
  function handleSheetTouchStart(e) {
    const t = e.touches[0]
    sheetDragRef.current = { active: true, decided: false, horizontal: false, startX: t.clientX, startY: t.clientY }
  }
  function handleSheetTouchMove(e) {
    // Direction is decided in the native claim listener (so a horizontal
    // drag owns the touch and the tree box under it cannot scroll); this
    // only tracks.
    const d = sheetDragRef.current
    if (!d.active || !d.horizontal) return
    sheetX.set(Math.max(0, e.touches[0].clientX - d.startX))
  }
  function handleSheetTouchEnd() {
    const d = sheetDragRef.current
    d.active = false
    if (!d.horizontal) return
    const v = sheetX.getVelocity()
    const shouldClose = v > 500 || (sheetX.get() > sheetWidth() / 3 && v > -200)
    settleSheet(!shouldClose)
  }

  function confirmDelete() {
    setShowDeleteConfirm(false)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    onDeleteNote(note.id)
    onClose()
  }

  function handleNavigateToConnectedNote(targetNote) {
    if (!onNavigateToNote) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (text.trim()) {
      onUpdateNote(note.id, { content: text, bubble_ids: selectedBubbleIds, tags, connections })
    }
    onNavigateToNote(targetNote)
  }

  // Tap-away → read mode. iOS Safari/WKWebView never moves focus — and so
  // never fires blur — when a tap lands on non-focusable content (and iOS
  // buttons don't take focus on tap either), so the textarea's onBlur →
  // read-mode swap only ever ran via the keyboard's Done button or Esc.
  // Detect completed taps ourselves: ≤10px of movement counts as a tap (a
  // scroll drag never dismisses the keyboard mid-gesture), and a tap outside
  // the textarea while editing blurs it explicitly, flowing through the same
  // onBlur as every other route. Touch events never fire from a mouse, so
  // desktop — where a click on the page blurs natively — is untouched.
  const tapAwayRef = useRef({ startX: 0, startY: 0, moved: true })

  // Touch handling on the panel root does double duty: tap-away detection
  // (all touch devices — gated on touch itself, not viewport width, so iPad
  // widths behave) and the edge-swipe back gesture (mobile layout only).
  // Swipe tracking is 1:1 with the finger (no lag): swipeOffset is local
  // state so only this panel re-renders. onSwipeProgress lets the parent
  // drive a parallax on the view beneath (revealed as the panel slides away).
  function handleTouchStart(e) {
    const touch = e.touches[0]
    tapAwayRef.current = { startX: touch.clientX, startY: touch.clientY, moved: false }
    touchActiveRef.current = true
    gestureScrollRef.current = true
    // Sheet open: a touch on the note strip belongs to closing the sheet
    // (the dismiss hook closes it on the press); the note must not scroll
    // from the same touch — claim it now, before any move.
    touchClaimRef.current =
      sheetOpen && !docked && !(sheetRef.current?.contains(e.target)) ? 'strip' : null
    // Both edge gestures are disarmed while the details sheet is open: a
    // rightward swipe then belongs to the sheet (drag-to-close, handled on
    // the sheet itself), never to swipe-back — the conflict is resolved by
    // construction, not by racing recognizers.
    if (!isDesktop && !sheetOpen && touch.clientX < 28) {
      swipeRef.current = { active: true, startX: touch.clientX, currentX: touch.clientX }
      // Move the layer beneath to its parallax start position while it's still fully
      // hidden behind this panel, so there's no visible jump when the reveal begins.
      onSwipeProgress?.(0, true)
    }
    // Right-edge mirror gesture: a leftward drag from the right 28px pulls
    // the details sheet in 1:1 — the chevron is the guaranteed affordance,
    // this is the fast path.
    if (!isDesktop && !sheetOpen && touch.clientX > window.innerWidth - 28) {
      sheetOpenSwipeRef.current = { active: true, decided: false, engaged: false, startX: touch.clientX, startY: touch.clientY }
    }
  }

  function handleTouchMove(e) {
    const touch = e.touches[0]
    const tap = tapAwayRef.current
    if (Math.abs(touch.clientX - tap.startX) > 10 || Math.abs(touch.clientY - tap.startY) > 10) {
      tap.moved = true
    }
    // Decision (engaged or not) is made in the native claim listener; this
    // only tracks the finger 1:1 once engaged.
    const os = sheetOpenSwipeRef.current
    if (os.active && os.engaged) {
      const odx = touch.clientX - os.startX
      sheetX.set(Math.min(sheetClosedX(), Math.max(0, sheetClosedX() + odx)))
    }
    if (!swipeRef.current.active) return
    const dx = e.touches[0].clientX - swipeRef.current.startX
    swipeRef.current.currentX = e.touches[0].clientX
    if (dx > 0) {
      setSwipeOffset(dx)
      onSwipeProgress?.(Math.min(1, dx / window.innerWidth), true)
    }
  }

  function handleTouchEnd(e) {
    touchActiveRef.current = false
    touchClaimRef.current = null
    // A touch that never scrolled leaves nothing to settle; one that did
    // keeps the gate open for its momentum until the restore.
    if (!chevronFadedRef.current) gestureScrollRef.current = false
    scheduleMetaSnap()
    // A tap (no movement) in the right-edge region while the chevron is faded
    // restores it — the chevron's own touches never reach here (they stop
    // propagation), so this covers the rest of the edge strip. Same 28px
    // zone the sheet-open swipe arms in.
    const tap = tapAwayRef.current
    if (!tap.moved && chevronFadedRef.current && tap.startX > window.innerWidth - 28) restoreChevronByTap()
    else armChevronRestore() // finger up: the restore delay counts from here
    // touchend's target is the element the touch STARTED on, so a tap that
    // begins in the textarea can never blur it, and one that begins outside
    // always can — checkbox/link/button taps included, which then still run
    // their own click handlers from read mode. Exemption: anything inside a
    // [data-keep-edit] ancestor (undo/redo) is an edit control — it must act
    // on the live edit state and keep the keyboard up, so it never counts as
    // tap-away. This is a deliberate whitelist, not a re-opening of the
    // original hole: every non-exempt tap still blurs.
    if (!tapAwayRef.current.moved && bodyMode === 'edit') {
      const body = bodyRef.current
      const keepEdit = e.target instanceof Element && e.target.closest('[data-keep-edit]')
      if (body && !keepEdit && e.target !== body) body.blur()
    }
    tapAwayRef.current.moved = true
    if (sheetOpenSwipeRef.current.active) {
      const os = sheetOpenSwipeRef.current
      os.active = false
      if (os.engaged) {
        // Same shape as the close thresholds, mirrored: a fast leftward
        // flick opens regardless of distance, 80px of pull opens unless the
        // finger was flicking back out, anything else settles closed.
        const v = sheetX.getVelocity()
        const pulled = sheetClosedX() - sheetX.get()
        if (v < -500 || (pulled > 80 && v < 200)) openSheet()
        else settleSheet(false)
      }
    }
    if (!swipeRef.current.active) return
    swipeRef.current.active = false
    const dx = swipeRef.current.currentX - swipeRef.current.startX
    // Past 40% of the screen width → complete the back navigation; otherwise cancel
    // and snap the panel back to full screen.
    if (dx > window.innerWidth * 0.4) {
      onSwipeProgress?.(1, false) // let the layer beneath settle to its resting position
      handleClose()
    } else {
      setSwipeOffset(0)
      onSwipeProgress?.(0, false)
    }
  }

  // Keyboard-gone watchdog + keyboard geometry — ONE component, TWO detection
  // paths, chosen by platform.
  //
  // Watchdog: tap-away above only covers dismissal routes that reach our own
  // touch handlers — but iOS can take the keyboard down by itself (a touch in
  // the strip just above the keyboard gets consumed by the system's
  // keyboard-dismiss handling and never completes as a tap for us) without
  // moving focus, so no blur fires and the editor is stranded in edit mode
  // with no keyboard. Enforce the invariant directly: whenever the software
  // keyboard leaves while the body is editing, blur the textarea, so EVERY
  // dismissal route — anticipated or not — flows through the same onBlur →
  // read swap. Software-keyboard devices only; desktop window resizes must
  // never kick the editor out of edit.
  //
  // Web path (Safari, mobile web): visualViewport. innerHeight does not shrink
  // for the iOS keyboard, so innerHeight − vv.height ≈ keyboard occlusion. Arm
  // once real occlusion has been seen (>150px — the smallest iOS keyboard is
  // taller), fire when it collapses (<60px allows browser-chrome jitter).
  // Pinch zoom also shrinks vv.height, so events are ignored while zoomed.
  //
  // Native path (Capacitor app): @capacitor/keyboard's keyboardWillShow /
  // keyboardDidShow / keyboardWillHide. visualViewport is NOT a usable signal
  // in the app: on load the plugin removes WKWebView's own observers for the
  // UIKeyboard will-show / will-hide / change-frame notifications (see
  // Keyboard.m, load), which are how WebKit learns the keyboard's frame — so
  // vv.height never shrinks there — and with resize "none" the web view's
  // frame is never changed either, so innerHeight − vv.height stays 0 for
  // the whole session. The plugin events carry the keyboard height in
  // points (= CSS px at scale 1); since the web view is not resized, the
  // keyboard's top edge is innerHeight − keyboardHeight.
  //
  // Geometry: kbGeom.bottom is the keyboard's top edge in layout-viewport
  // coordinates — where the format bar's bottom must sit. Nothing here
  // hardcodes an accessory-bar height: on the web, vv.height already
  // excludes whatever occludes the viewport, so in Safari the bar lands on
  // Safari's own accessory bar; in the app (accessory bar suppressed) the
  // plugin's height is the keys alone and the bar lands directly on them.
  const [kbGeom, setKbGeom] = useState({ up: false, bottom: 0 })

  // ── Bounded body while the keyboard is up ────────────────────────────────
  // The custom caret-reveal apparatus (mirror measurement, settle beats, rAF
  // ordering against iOS's own reveal) is GONE — it was racing an engine we
  // can't observe. Instead the geometry problem is removed: while the
  // keyboard is up, the textarea gets a FIXED height ending above the format
  // bar and scrolls INTERNALLY, so there is exactly one scrolling box while
  // typing, its size never changes with a keystroke, and iOS's native caret
  // reveal — against stable geometry — does all the work. Read mode (and
  // desktop, and the brief keyboard-rise window) stays the unbounded
  // continuous page.
  //
  // The only seams are two ONE-SHOT scroll conversions, both exact and
  // both expressed in viewport positions (never in assumptions about where
  // the box will land — the outer scroll area clamps once the box renders,
  // because its content is then shorter than it is):
  //   in  — at the keyboard-up transition, the textarea's viewport top is
  //         captured; after the box renders, its inner scrollTop is set to
  //         however far the textarea moved, so every line stays exactly
  //         where it was on screen. Then, only if the tapped line is not
  //         clear of the bar, the box scrolls by exactly the shortfall;
  //   out — on blur, the box's inner scrollTop and viewport top are
  //         captured; after the swap the page scrolls so the same content
  //         sits at the same viewport position.
  const [boundBoxH, setBoundBoxH] = useState(null)
  // Second-pass guard for the box height (see the conversion-in effect).
  const boundPass2Ref = useRef(false)
  // The textarea's viewport top at the up-transition; consumed one-shot.
  const boundElTopRef = useRef(null)
  // The bounded box's inner scroll + viewport top at blur; consumed one-shot
  // after the swap.
  const restoreScrollRef = useRef(null)
  // The tapped line's bottom as a content coordinate, captured at the read
  // tap; consumed one-shot by the bounding conversion.
  const pendingTapLineRef = useRef(null)
  // The in-flight tap-clearance animation: { raf, el, target }. Cancelled
  // (and snapped to target) by a keystroke or blur; cancelled on unmount.
  const tapScrollAnimRef = useRef(null)
  const cancelTapScroll = useCallback((snap) => {
    const a = tapScrollAnimRef.current
    if (!a) return
    tapScrollAnimRef.current = null
    cancelAnimationFrame(a.raf)
    if (snap) a.el.scrollTop = a.target
  }, [])
  useEffect(() => () => cancelTapScroll(false), [cancelTapScroll])
  // Animate the box's inner scroll to `target` (ease-out). Writes scrollTop
  // directly every frame — no smooth-scroll API, so a cancel is
  // deterministic and the snap lands exactly on target.
  // ── Keystroke reveal correction ──────────────────────────────────────────
  // After every editing command WebKit reveals the caret with its default
  // alignment, alignCenterIfNeeded (ScrollAlignment.cpp): no scroll if the
  // caret rect is visible, scroll to the CLOSEST EDGE if it is partially
  // visible (the one-line case), and CENTER it if it is fully hidden. A caret
  // that lands on a line entirely below the box's bottom edge — a word
  // wrapping, autocorrect completing a wrapped word, Enter anywhere but the
  // very end of the note (Editor.cpp uses edge alignment only there) — is
  // centered: half a box up, six or seven lines above the bar.
  //
  // The correction pulls that back so the caret sits at the bottom edge,
  // exactly where an edge-aligned reveal would have put it. It keys on the
  // scroll DELTA between beforeinput (before WebKit's command) and the scroll
  // event the reveal fires: an edge reveal of a partially visible line moves
  // by less than one line height; anything more is a centering, and a
  // centering puts the caret rect's center at exactly half the box, so the
  // pull-back is half the box minus half a line — no caret measurement, and
  // both the threshold and the amount derive from the live line height.
  //
  // Why the scroll event and not the post-render effect: scroll events are
  // dispatched in the rendering update's scroll steps, BEFORE paint, whether
  // WebKit fires `input` before or after its reveal — so the centered frame
  // is corrected in the same commit and never painted. The pending window
  // closes at the next animation frame (which runs after the scroll steps
  // in the same update), so a later user scroll is never misread.
  const inputRevealRef = useRef(null)
  const handleBodyBeforeInput = e => {
    if (boundBoxH == null) { inputRevealRef.current = null; return }
    // A tap-clearance animation still in flight snaps first, so the pre
    // value reflects the settled position and the snap can't read as a reveal.
    cancelTapScroll(true)
    inputRevealRef.current = { pre: e.target.scrollTop }
    requestAnimationFrame(() => { inputRevealRef.current = null })
  }
  const handleBodyScroll = e => {
    const pending = inputRevealRef.current
    if (!pending) return
    inputRevealRef.current = null
    const el = e.target
    const lh = lineHeightOf(el)
    const delta = el.scrollTop - pending.pre
    if (delta <= lh) return // an edge-aligned reveal (or nothing) — leave it
    el.scrollTop -= el.clientHeight / 2 - lh / 2
  }

  // Parking the metadata row on keyboard-up. The row is a read-mode
  // affordance; while editing it is always parked (page scrollTop = its
  // height), so it can never sit above the box like a sticky header. If it
  // was showing at the moment of keyboard-up, parking moves the text up by
  // its height — done as a short slide during the keyboard's own rise
  // rather than an instant jump. parkOuterRef carries the target from the
  // box-height effect to the conversion-in effect, which starts the slide
  // after the box has rendered (the box is sized for the PARKED position).
  const parkOuterRef = useRef(null)
  const parkAnimRef = useRef(null)
  const cancelParkSlide = () => {
    if (parkAnimRef.current) { cancelAnimationFrame(parkAnimRef.current); parkAnimRef.current = null }
  }
  useEffect(() => cancelParkSlide, [])
  const slideOuterTo = (outer, target) => {
    cancelParkSlide()
    const from = outer.scrollTop
    if (Math.abs(target - from) < 1) { outer.scrollTop = target; return }
    const t0 = performance.now()
    const step = (now) => {
      const p = Math.min(1, (now - t0) / TAP_SCROLL_MS)
      outer.scrollTop = from + (target - from) * (1 - Math.pow(1 - p, 3))
      parkAnimRef.current = p < 1 ? requestAnimationFrame(step) : null
    }
    parkAnimRef.current = requestAnimationFrame(step)
  }

  const animateTapScroll = (el, target) => {
    cancelTapScroll(false)
    const from = el.scrollTop
    if (Math.abs(target - from) < 1) { el.scrollTop = target; return }
    const t0 = performance.now()
    const step = (now) => {
      const a = tapScrollAnimRef.current
      if (!a) return
      const p = Math.min(1, (now - t0) / TAP_SCROLL_MS)
      const eased = 1 - Math.pow(1 - p, 3)
      el.scrollTop = from + (target - from) * eased
      if (p < 1) a.raf = requestAnimationFrame(step)
      else tapScrollAnimRef.current = null
    }
    tapScrollAnimRef.current = { raf: requestAnimationFrame(step), el, target }
  }

  // Native keyboard state, mirrored from the plugin for the EDITOR's lifetime
  // rather than per edit session. Registering inside the edit-session effect
  // would race the keyboard itself: focus happens in a layout effect BEFORE
  // that effect runs, and addListener is a bridge round-trip, so the first
  // keyboardWillShow could land before anyone was listening and the session
  // would start blind. The latest height lives in a ref; the edit session
  // installs nativeApplyRef to be told about changes and reads the ref on
  // entry, so either order — event first or session first — converges.
  const nativeKbRef = useRef({ height: 0 })
  const nativeApplyRef = useRef(null)
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let cancelled = false
    const handles = []
    const onShow = info => {
      nativeKbRef.current = { height: Number(info?.keyboardHeight) || 0 }
      nativeApplyRef.current?.()
    }
    const onHide = () => {
      // Blur BEFORE the geometry write: onBlur's one-shot capture reads the
      // bounded box's inner scrollTop, which must still be the bounded box.
      bodyRef.current?.blur()
      nativeKbRef.current = { height: 0 }
      nativeApplyRef.current?.()
    }
    Promise.all([
      Keyboard.addListener('keyboardWillShow', onShow),
      Keyboard.addListener('keyboardDidShow', onShow),
      Keyboard.addListener('keyboardWillHide', onHide),
    ]).then(hs => { if (cancelled) hs.forEach(h => h.remove()); else handles.push(...hs) })
    return () => {
      cancelled = true
      handles.forEach(h => h.remove())
    }
  }, [])

  useEffect(() => {
    if (bodyMode !== 'edit') {
      setKbGeom(g => (g.up ? { up: false, bottom: 0 } : g))
      return
    }
    if (window.matchMedia(KEYBOARD_MEDIA_QUERY).matches) return

    // Shared tail of both detection paths: the up-transition capture, then
    // the geometry write.
    let wasUp = false
    const apply = (up, bottom) => {
      if (up && !wasUp) {
        // Up-transition: capture the textarea's viewport top NOW, while the
        // page is still unbounded — once the bounded box renders, the outer
        // scroll content collapses and its scrollTop clamps, moving the
        // textarea down; the conversion-in effect scrolls the box by exactly
        // that movement so every line stays put. Consumed one-shot.
        const el = bodyRef.current
        if (el) boundElTopRef.current = el.getBoundingClientRect().top
      }
      wasUp = up
      setKbGeom(g => (g.up === up && g.bottom === bottom ? g : { up, bottom }))
    }

    if (Capacitor.isNativePlatform()) {
      const syncNative = () => {
        const h = nativeKbRef.current.height
        apply(h > 0, Math.round(window.innerHeight - h))
      }
      nativeApplyRef.current = syncNative
      syncNative()
      return () => { nativeApplyRef.current = null }
    }

    const vv = window.visualViewport
    let sawKeyboard = false
    const sync = () => {
      if (!vv || Math.abs((vv.scale || 1) - 1) > 0.01) return
      const occluded = window.innerHeight - vv.height
      if (occluded > 150) sawKeyboard = true
      else if (sawKeyboard && occluded < 60) bodyRef.current?.blur()
      apply(occluded > 150, Math.round(vv.offsetTop + vv.height))
    }
    sync()
    vv?.addEventListener('resize', sync)
    vv?.addEventListener('scroll', sync)
    return () => {
      vv?.removeEventListener('resize', sync)
      vv?.removeEventListener('scroll', sync)
    }
  }, [bodyMode])

  // Bounded-box height: from the scroll area's top down to just above the
  // format bar. Tracks keyboard geometry (rotation included) — NOT keystrokes;
  // that stability is the whole point.
  useLayoutEffect(() => {
    if (!(kbGeom.up && bodyMode === 'edit')) {
      setBoundBoxH(null)
      boundPass2Ref.current = false
      return
    }
    const outer = scrollAreaRef.current
    const el = bodyRef.current
    if (!outer || !el) return
    // The box's top is NOT the scroll area's top: the textarea sits below
    // the metadata row and the column's top padding, and once the box
    // renders the outer's content is shorter than the area, so its
    // scrollTop clamps — to the metadata row's height at most (the column's
    // minHeight of 100% guarantees exactly that much range). The row is
    // PARKED while editing (see parkOuterRef): the outer ends at the row's
    // height whether it clamps down to it (scrolled past the row) or slides
    // up to it (row showing). Either way the textarea's top lands at its
    // current top plus (scroll - row height); size the box for that. The
    // conversion-in effect measures the real landing and corrects once if
    // the prediction was off.
    const rowH = metaRowRef.current?.offsetHeight || 0
    const scroll = outer.scrollTop
    const boxTop = el.getBoundingClientRect().top + (scroll - rowH)
    parkOuterRef.current = scroll < rowH ? rowH : null
    setBoundBoxH(Math.max(120, barTopOf(kbGeom) - BOX_BAR_MARGIN - boxTop))
  }, [kbGeom.up, kbGeom.bottom, bodyMode])

  // One-shot conversion IN, after the bounded box has rendered. Two steps,
  // both measured rather than assumed:
  //   1. Keep every line where it was: the textarea moved down by however
  //      much the outer's scrollTop clamped, so the box's inner scrollTop
  //      takes up exactly that movement.
  //   2. Tap clearance — the NO-OP case first: if the tapped line's bottom
  //      is already at least TAP_LINE_MARGIN above the bar, nothing moves.
  //      Otherwise the box scrolls by exactly the shortfall. (iOS's native
  //      reveal can't do this: its focus-time reveal ran against the
  //      unbounded page, where the caret was already visible, and an
  //      identical re-selection is a WebKit no-op. Native reveal takes over
  //      from the first real keystroke on.)
  // Before either: a second pass on the height. The predicted landing can
  // be off when the outer's clamp differs from the estimate; measure where
  // the box actually landed and correct once (the one-shot refs are still
  // unconsumed, so the re-run does the conversions against the final box).
  useLayoutEffect(() => {
    if (boundBoxH == null) return
    const el = bodyRef.current
    const outer = scrollAreaRef.current
    if (!el || !outer) return
    const bar = barTopOf(kbGeom)
    // A pending park slide hasn't moved the page yet: every viewport
    // measurement below is taken pre-slide and shifted by parkDelta to the
    // parked position the box was sized for.
    const park = parkOuterRef.current
    const parkDelta = park != null ? Math.max(0, park - outer.scrollTop) : 0
    const want = Math.max(120, bar - BOX_BAR_MARGIN - (el.getBoundingClientRect().top - parkDelta))
    if (Math.abs(want - boundBoxH) > 1 && !boundPass2Ref.current) {
      boundPass2Ref.current = true
      setBoundBoxH(want)
      return
    }
    if (park != null) {
      parkOuterRef.current = null
      slideOuterTo(outer, park)
    }
    const elTopBefore = boundElTopRef.current
    if (elTopBefore == null) return
    boundElTopRef.current = null
    const rect0 = el.getBoundingClientRect()
    el.scrollTop = Math.max(0, rect0.top - elTopBefore)
    const line = pendingTapLineRef.current
    pendingTapLineRef.current = null
    if (line != null) {
      const rect = el.getBoundingClientRect()
      const lineBottomNow = rect.top + line - el.scrollTop - parkDelta
      // No-op test against the box's VISIBLE bottom edge; landing target a
      // full line above the bar. Smooth from here — keystroke/blur snap.
      const boxBottom = rect.bottom - parkDelta
      const target = bar - TAP_LINE_MARGIN
      const needs = lineBottomNow > boxBottom
      if (needs) animateTapScroll(el, el.scrollTop + (lineBottomNow - target))
    }
  }, [boundBoxH]) // eslint-disable-line react-hooks/exhaustive-deps

  // One-shot conversion OUT, after the swap back to read mode: the box's
  // inner depth (captured at blur) becomes page scroll again, so the line
  // that was at the top of the box stays at the top of the view.
  useLayoutEffect(() => {
    if (bodyMode !== 'read') return
    const r = restoreScrollRef.current
    restoreScrollRef.current = null
    if (r == null) return
    const outer = scrollAreaRef.current
    const read = readRef.current
    if (!outer || !read) return
    // The content that was at the box's top edge (inner depth r.scrollTop,
    // viewport y r.top) now sits at read.top + r.scrollTop; scroll the page
    // by the difference so it lands back at r.top.
    outer.scrollTop += read.getBoundingClientRect().top + r.scrollTop - r.top
  }, [bodyMode])

  // Auto-grow — UNBOUNDED mode only (read never mounts the textarea; while
  // the keyboard is up the box is fixed-height and scrolls internally, so
  // height must NOT track content there). Keeps the textarea exactly as tall
  // as its content so the note reads as one continuous page on desktop and
  // during the brief keyboard-rise window. Re-synced on text changes and
  // window resize (rewrap). No scroll side effects: caret visibility is
  // iOS's own job against the bounded box.
  useLayoutEffect(() => {
    if (bodyMode !== 'edit' || boundBoxH != null) return
    const el = bodyRef.current
    if (!el) return
    const sync = () => {
      // Hold the column's height through the auto-height measurement (see
      // pinColumn), then release: the textarea carries its px height now.
      pinColumn()
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
      unpinColumn()
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [text, bodyMode, boundBoxH]) // eslint-disable-line react-hooks/exhaustive-deps

  // Formatting-bar transforms. Pure rewrites from mdFormat plus the editor's
  // existing plumbing: same history push and debounced save as typing, and
  // selection restore through transformCaretRef so the wrapped text stays
  // selected — which is exactly what lets a second press unwrap. Reading the
  // selection live off the textarea is safe because bar taps never move
  // focus (data-keep-edit + no focus steal), so the selection is still the
  // user's own.
  function applyFormat(kind) {
    const el = bodyRef.current
    if (!el) return
    const s = el.selectionStart
    const e = el.selectionEnd
    const r =
      kind === 'bold' || kind === 'italic' || kind === 'strike'
        ? toggleInline(text, s, e, kind === 'bold' ? '**' : kind === 'italic' ? '*' : '~~')
        : kind === 'link'
          ? insertLink(text, s, e)
          : toggleLinePrefix(text, s, e, kind)
    if (r.text === text) return
    pushHistory(text)
    transformCaretRef.current = { start: r.start, end: r.end }
    setText(r.text)
    scheduleSave(r.text, selectedBubbleIds, tags, connections)
  }

  // The bubble rows themselves; tree order, indentation and fit-based
  // auto-collapse come from BubblePickerTree. Tapping a row still only
  // toggles membership — the chevron is its own hit target.
  function renderBubblePickerRow(bubble) {
    const selected = selectedBubbleIds.includes(bubble.id)
    const color = bubble.color
    return (
      <button
        onClick={() => toggleBubble(bubble.id)}
        className="flex-1 min-w-0 flex items-center gap-2 px-2 rounded-lg text-left transition-all"
        style={{ background: selected ? `${color}22` : 'transparent' }}
      >
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all"
          style={{ backgroundColor: selected ? color : `${color}55` }}
        />
        <span
          className="text-sm transition-colors truncate"
          style={{ color: selected ? 'var(--text)' : '#6b7280' }}
        >
          {bubble.name}
        </span>
      </button>
    )
  }

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0

  // ── Metadata row: pull-to-reveal by scroll offset (Apple Notes) ────────
  // Word count and timestamps are the first ROW of the scroll content, above
  // the note column. Nothing collapses or expands, ever: "hidden" is the
  // scroll area RESTING with the row just above the fold (scrollTop = the
  // row's height — the column's minHeight of 100% guarantees at least that
  // much range), and a pull-down at the top scrolls it into view like any
  // other content. Because the content height never changes, there is
  // nothing to compensate and no jump is possible. What makes it a reveal
  // rather than a plain scroll is the snap: once scrolling settles (no
  // scroll events for 150ms, no finger down, no keyboard) with the row
  // partly in view, a smooth scroll settles it fully shown or fully hidden.
  // The note opens hidden on touch devices; fine-pointer devices (no pull
  // gesture, and the row carries desktop's undo/redo) open with it shown
  // and never snap.
  const hasFinePointer = window.matchMedia(KEYBOARD_MEDIA_QUERY).matches
  const metaRowRef = useRef(null)
  const metaSnapTimerRef = useRef(null)
  const touchActiveRef = useRef(false)
  const kbUpRef = useRef(false)
  kbUpRef.current = kbGeom.up
  const scheduleMetaSnap = () => {
    if (hasFinePointer) return
    clearTimeout(metaSnapTimerRef.current)
    metaSnapTimerRef.current = setTimeout(() => {
      if (touchActiveRef.current || kbUpRef.current) return
      const outer = scrollAreaRef.current
      const h = metaRowRef.current?.offsetHeight || 0
      if (!outer || !h) return
      const at = outer.scrollTop
      if (at > 0 && at < h) outer.scrollTo({ top: at < h / 2 ? 0 : h, behavior: 'smooth' })
    }, 150)
  }
  useEffect(() => () => clearTimeout(metaSnapTimerRef.current), [])
  // Open with the row hidden: rest the scroll area just past it.
  useLayoutEffect(() => {
    if (hasFinePointer) return
    const outer = scrollAreaRef.current
    const h = metaRowRef.current?.offsetHeight || 0
    if (outer && h) outer.scrollTop = h
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Manual title when set, else the first non-empty body line, tracking the
  // live text rather than the last saved copy.
  const displayTitle = customTitle || getNoteTitle(text)

  function startTitleEdit() {
    titleDraftInitialRef.current = displayTitle
    setTitleDraft(displayTitle)
    setEditingTitle(true)
  }

  // Commit on blur/Enter. An untouched draft keeps the prior mode — tapping
  // in and back out never freezes a derived title. A cleared draft reverts
  // to deriving (stored as null).
  function commitTitle() {
    setEditingTitle(false)
    if (titleDraft === titleDraftInitialRef.current) return
    const next = titleDraft.trim()
    setCustomTitle(next)
    onUpdateNote(note.id, { title: next || null })
  }
  // A locked note's title must not surface through the connections UI either — it's
  // shown as "Locked" in existing connections, and can't be picked as a new one.
  const lockIndex = buildLockIndex(project.bubbles, project.notes, unlockedIds)

  // Back-button label, capped the same way for EVERY origin (bubble and
  // project names can run as long as note titles). Orientation is the job,
  // not fidelity: roughly a couple of words. Over the cap it's cut at the
  // character budget with an ellipsis; if even that can't leave a few
  // readable characters (or the label is blank), the chevron stands alone.
  const BACK_LABEL_MAX = 10
  // The centered title's reserve on EACH side is MEASURED, not assumed: after
  // each commit the layout effect below reads the real rendered width of the
  // back button and of the icon cluster, takes the wider of the two plus a
  // small gap, and applies it to both sides — so the box stays symmetric
  // around the panel's center, can't collide with either side at any label
  // length, and a short (or absent) back label hands the title the room it
  // isn't using. TITLE_INSET is only the pre-measurement fallback, sized for
  // the worst case (pad + chevron + a full capped label).
  const TITLE_INSET = 128
  const [titleInset, setTitleInset] = useState(TITLE_INSET)
  const headerRowRef = useRef(null)
  const backBtnRef = useRef(null)
  const iconGroupRef = useRef(null)
  useLayoutEffect(() => {
    const hdr = headerRowRef.current
    const back = backBtnRef.current
    const icons = iconGroupRef.current
    if (!hdr || !back || !icons) return
    const h = hdr.getBoundingClientRect()
    const leftSide = back.getBoundingClientRect().right - h.left
    const rightSide = h.right - icons.getBoundingClientRect().left
    const next = Math.round(Math.max(leftSide, rightSide)) + 8
    setTitleInset(prev => (prev === next ? prev : next))
  })
  const backTrimmed = (backLabel ?? '').trim()
  const backCut = backTrimmed.length > BACK_LABEL_MAX
    ? backTrimmed.slice(0, BACK_LABEL_MAX - 1).trimEnd()
    : backTrimmed
  const backText = backTrimmed.length > BACK_LABEL_MAX
    ? (backCut.length >= 4 ? backCut + '…' : '')
    : backTrimmed
  const connectableNotes = project.notes.filter(
    n => n.id !== note.id && !lockIndex.gatedNoteIds.has(n.id)
  )
  const titleOf = (n) =>
    lockIndex.gatedNoteIds.has(n.id) ? 'Locked' : (noteTitle(n) || 'Untitled')
  const swipeTransition = swipeRef.current.active
    ? 'none'
    : 'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)'

  // All custom tags come from the project-level color map (toggling off just deselects, never removes)
  const allCustomTags = Object.keys(project.customTagColors || {})

  // The metadata row — one definition, two homes (see where it renders).
  const metaRow = (
    <div className="flex items-end justify-between">
      <div className="flex items-end gap-3">
      {/* Undo / Redo. On touch devices these live in the format bar on
          the keyboard; this cluster exists ONLY on desktop, which has
          no format bar (no software keyboard) and no other undo — the
          custom history stack means native Ctrl+Z can't restore
          programmatic transforms on this controlled textarea. It stays
          with the body (not the details sheet): it's an edit control,
          not organization, and desktop's only undo must not live
          behind a chevron. */}
      {isDesktop && (
      <div className="flex items-center gap-1 -ml-1.5">
        <button
          onClick={undo}
          disabled={past.length === 0}
          // Edit control: undo-then-keep-typing must not cost a
          // re-entry tap, so it's exempt from tap-away (data-keep-edit)
          // and from desktop's native mousedown focus steal.
          data-keep-edit=""
          onMouseDown={e => e.preventDefault()}
          className="p-1.5 rounded-lg transition-opacity flex-shrink-0 text-gray-400 disabled:opacity-25"
          title="Undo"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M3 10h10a6 6 0 010 12H9m-6-12l4-4m-4 4l4 4" />
          </svg>
        </button>
        <button
          onClick={redo}
          disabled={future.length === 0}
          data-keep-edit=""
          onMouseDown={e => e.preventDefault()}
          className="p-1.5 rounded-lg transition-opacity flex-shrink-0 text-gray-400 disabled:opacity-25"
          title="Redo"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 10H11a6 6 0 000 12h4m6-12l-4-4m4 4l-4 4" />
          </svg>
        </button>
      </div>
      )}
      {/* Passive metadata about the note in front of you — visible at
          a glance without opening anything, same reasoning that keeps
          undo/redo here rather than in the sheet. Word count left,
          timestamps right: opposite ends of one row — the top of the
          page on touch (pull-to-reveal), the bottom on desktop. */}
      <p className="text-[11px] text-gray-700">
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </p>
      </div>
      <div className="text-right space-y-0.5 ml-auto">
        <p className="text-[11px] text-gray-600">Created {formatNoteDate(note.created_at)}</p>
        <p className="text-[11px] text-gray-700">Last edited {formatNoteDate(note.updated_at)}</p>
      </div>
    </div>
  )

  return (
    <motion.div
      data-modal
      className="fixed inset-0"
      style={{
        zIndex,
        // Mobile: transparent so the view beneath (bubble/all-notes/previous note)
        // shows through as this panel slides away during a swipe-back.
        background: isDesktop ? 'rgba(0,0,0,0.6)' : 'transparent',
        display: isDesktop ? 'flex' : 'block',
        alignItems: isDesktop ? 'stretch' : undefined,
        // Docked: the panel positions itself with a margin (note centered
        // when the sheet fits beside it, see PANEL_DOCKED_MARGIN_LEFT).
        justifyContent: isDesktop ? (docked ? 'flex-start' : 'center') : undefined,
      }}
      initial={isDesktop ? { opacity: 0 } : { x: '100%' }}
      animate={isDesktop ? { opacity: 1 } : { x: 0 }}
      exit={isDesktop ? { opacity: 0 } : { x: '100%' }}
      transition={{ type: 'tween', duration: isDesktop ? 0.18 : 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
      // Desktop only: pressing the dimmed backdrop closes the note the same way
      // the back arrow does (same pending-edit save). target===currentTarget
      // means presses inside the panel — or on any menu/dialog it spawns, which
      // are all children — can never reach here; mousedown (not click) means a
      // text-selection drag that ends outside the panel can't close it either.
      // Touch devices keep swipe-back/Escape only, where a stray tap is too easy.
      onMouseDown={isDesktop ? (e => { if (e.target === e.currentTarget) handleClose() }) : undefined}
    >
    <div
      ref={panelRef}
      // The column is minmax(0, 1fr), NOT the implicit auto: grid items
      // default to min-width auto, so the header's intrinsic width (a nowrap
      // title) would otherwise blow the track — and with it every row —
      // wider than the panel. minmax(0,1fr) caps the track at the panel
      // width, which is what lets min-w-0 flex items inside actually shrink.
      style={isDesktop ? {
        position: 'relative',
        width: '100%',
        // Docked: the panel is still just the note; the sheet is positioned
        // OUTSIDE it, off its right edge. The note keeps its 820 unless the
        // window can't hold note + sheet, then it narrows to leave the
        // sheet's width. Overflow must be visible for the sheet to show.
        maxWidth: docked ? `min(${NOTE_PANEL_W}px, calc(100% - ${SHEET_DOCK_W}px))` : NOTE_PANEL_W,
        marginLeft: docked ? PANEL_DOCKED_MARGIN_LEFT : undefined,
        // EXPERIMENT (neutral scheme): was var(--surface) — the panel matches the
        // pitch-black ground so the bare header doesn't read as a black band on a
        // lighter panel (both branches below).
        background: 'var(--bg)',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        gridTemplateColumns: 'minmax(0, 1fr)',
        overflow: docked ? 'visible' : 'hidden',
        borderLeft: '1px solid var(--border)',
        borderRight: '1px solid var(--border)',
      } : {
        position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
        background: 'var(--bg)',
        display: 'grid', gridTemplateRows: 'auto 1fr',
        gridTemplateColumns: 'minmax(0, 1fr)', overflow: 'hidden',
        transform: `translateX(${swipeOffset}px)`, transition: swipeTransition,
        // Left-edge shadow gives the sliding panel depth over the revealed layer.
        boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => {
        touchActiveRef.current = false
        touchClaimRef.current = null
        if (!chevronFadedRef.current) gestureScrollRef.current = false
        scheduleMetaSnap()
        armChevronRestore()
      }}
    >
      {/* ── Header — grid row 1 (auto height, never scrolls) ─────────────────── */}
      {/* EXPERIMENT (neutral scheme): header had a border-b divider and painted
          var(--surface); now bare on the panel ground like the canvas header. */}
      <div
        ref={headerRowRef}
        className="relative flex items-center px-3"
        style={{
          gridColumn: 1,
          paddingTop: 'max(12px, env(safe-area-inset-top))', paddingBottom: 10,
          background: 'var(--bg)',
        }}
      >
        <button
          ref={backBtnRef}
          onClick={handleClose}
          className="flex items-center gap-0.5 text-indigo-400 hover:text-indigo-300 font-medium text-[15px] py-1 -ml-1 flex-shrink-0 transition-colors z-10 max-w-[140px]"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          {backText && <span className="truncate">{backText}</span>}
        </button>

        {/* Title. Follows the first body line until manually edited (tap to
            edit); a manual title is fixed and no longer tracks the body, and
            clearing it reverts to deriving. Absolutely positioned in a box
            centered on the panel (the measured titleInset each side), so it
            stays centered at any back-label length; out of flow, it also
            can't blow the grid track (and the panel's minmax(0,1fr) column
            guards that regardless). The back button and icons carry z-10, so
            they layer above it and keep their full hit areas. */}
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitTitle() }
              if (e.key === 'Escape') { e.stopPropagation(); setEditingTitle(false) }
            }}
            placeholder="Untitled"
            aria-label="Note title"
            className="absolute text-center text-[15px] font-semibold outline-none bg-transparent px-2"
            style={{ left: titleInset, right: titleInset, color: 'var(--text)', userSelect: 'text', WebkitUserSelect: 'text' }}
          />
        ) : (
          <button
            onClick={startTitleEdit}
            className="absolute text-center text-[15px] font-semibold truncate px-2"
            style={{ left: titleInset, right: titleInset, color: displayTitle ? 'var(--text)' : '#6b7280' }}
            title="Edit title"
          >
            {displayTitle || 'Untitled'}
          </button>
        )}

        <div className="flex-1" />

        {/* Icon cluster — one wrapper so the title-inset measurement reads the
            group's true extent in a single rect. Apple Notes pattern: Share +
            a "..." menu; copy and delete moved into the menu. */}
        <div ref={iconGroupRef} className="flex items-center flex-shrink-0">
          {/* Share — the text as it stands in the editor, not the last saved
              version, same live-text rule the old copy button had. Falls back
              to the clipboard where no share sheet exists (see noteShare). */}
          <button
            onClick={() => shareNoteText({ content: text, title: customTitle || null }).then(showToast)}
            disabled={!text.trim()}
            className="p-3 rounded-lg transition-opacity flex-shrink-0 z-10 text-gray-400 disabled:opacity-25"
            title="Share note"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M8.5 8H7a2 2 0 00-2 2v9a2 2 0 002 2h10a2 2 0 002-2v-9a2 2 0 00-2-2h-1.5M12 14V2.5m0 0L8.5 6M12 2.5L15.5 6" />
            </svg>
          </button>

          <button
            ref={headerMenuBtnRef}
            onClick={() => setShowHeaderMenu(m => !m)}
            className="p-3 text-gray-400 rounded-lg transition-colors -mr-2 flex-shrink-0 z-10"
            title="Note options"
            aria-label="Note options"
            aria-expanded={showHeaderMenu}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="19" cy="12" r="1.5" />
            </svg>
          </button>
        </div>

        {/* "..." menu. Dismissal (outside press + Escape) comes entirely from
            the shared useDismissOnOutside hook registered above. */}
        {showHeaderMenu && (
          <div
            ref={headerMenuRef}
            className="absolute rounded-xl shadow-lg py-1 min-w-[160px] z-30"
            style={{ top: '100%', right: 12, background: 'var(--surface-2)', border: '1px solid var(--border)' }}
          >
            <button
              onClick={handleToggleLock}
              className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800"
            >
              {note.locked ? 'Unlock' : 'Lock'}
            </button>
            <button
              onClick={() => { setShowHeaderMenu(false); onTogglePin?.() }}
              className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800"
            >
              {pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              onClick={() => {
                setShowHeaderMenu(false)
                copyNoteText({ content: text, title: customTitle || null }).then(showToast)
              }}
              disabled={!text.trim()}
              className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-25"
            >
              Copy
            </button>
            {/* Delete — red, at the bottom, separated. Same confirm dialog as
                the old header trash button (handleDelete → showDeleteConfirm). */}
            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            <button
              onClick={() => { setShowHeaderMenu(false); handleDelete() }}
              className="w-full text-left px-4 py-2.5 text-sm text-red-500 hover:bg-red-950"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {/* ── Scroll area — grid row 2 (1fr), only this scrolls ─────────────────
          No keyboard compensation here: while the keyboard is up the
          textarea is a fixed-height box ending above the format bar (see
          boundBoxH), so nothing below it needs reserving. */}
      <div
        ref={scrollAreaRef}
        // While the bounded box is up the page is not the scroller — the box
        // is — and its only range is the parked metadata row, which stays
        // parked (see the box-height effect). overflow: hidden, NOT a hidden
        // ::-webkit-scrollbar: toggling the scrollbar's existence made WebKit
        // rebuild it, and the rebuilt indicator came back a different tone
        // after every edit round trip. Programmatic scrollTop writes (the
        // park slide, the exit conversion) work on overflow: hidden.
        style={{
          gridColumn: 1, minHeight: 0, WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain',
          // Also not scrollable while the overlay sheet is open: a drag on
          // the visible note strip closes the sheet and stops there; the
          // note scrolls again on the next touch, after it has closed.
          overflowY: (bodyMode === 'edit' && boundBoxH != null) || (sheetOpen && !docked) ? 'hidden' : 'auto',
        }}
        onScroll={() => { scheduleMetaSnap(); fadeChevronForScroll() }}
      >

        {/* Metadata row, touch: the first row of the scroll content; the
            scroll area rests with it just above the fold (see
            scheduleMetaSnap). Its top padding matches the column's, so at
            rest the note sits exactly where it would without the row.
            Fine-pointer devices render metaRow at the BOTTOM of the note
            instead (below) — no pull gesture there. */}
        {!hasFinePointer && (
          <div ref={metaRowRef} className="px-5 md:px-10 pt-4 md:pt-8">
            {metaRow}
          </div>
        )}

        {/* Text content — a full-height flex column with no bottom border:
            the note reads as one continuous page to the screen bottom (the
            old border-b was the divider to the metadata that now lives in
            the sheet). minHeight 100% makes a short note's column fill the
            visible area, so the flex-grown body box owns the blank space
            and the stats row lands at the very bottom of the screen. */}
        <div
          ref={columnRef}
          className="px-5 md:px-10 pt-4 md:pt-8 flex flex-col"
          // Scrollable tail below the last line (Apple Notes) in the
          // unbounded page. NOT while the bounded box is up: the box carries
          // its own tail, and the outer must collapse to exactly its own
          // height then (see the box-height effect). Keyed on EDIT + box,
          // not the box alone: boundBoxH is still set in the render that
          // swaps back to read, and the exit conversion scrolls the page in
          // that very render — with only the small padding the page had
          // too little range, the scroll clamped to the end of the note,
          // and the last lines snapped back to the screen bottom (which is
          // exactly where a tapped low line had been before editing).
          // 60vh, not 50: the box lets the last line reach the box's
          // midpoint, roughly 40% down the screen; the page must allow the
          // same depth or the exit clamps by the difference.
          //
          // The tail is an ELEMENT (below), not column padding: padding sits
          // outside the read box, so a tap in it reached nothing — the read
          // box's flex-grow only ever filled what was left above the padding,
          // ~175px on a phone — and "tap below the last line to append"
          // silently stopped working the day the tail landed. The tail
          // element forwards its taps to the read handler, which resolves
          // an off-text point to the end of the note.
          style={{
            minHeight: '100%',
            paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
          }}
        >
          {bodyMode === 'edit' ? (
            <textarea
              ref={bodyRef}
              value={text}
              onChange={handleTextChange}
              onBeforeInput={handleBodyBeforeInput}
              onScroll={handleBodyScroll}
              onBlur={e => {
                cancelTapScroll(true)
                cancelParkSlide()
                // One-shot capture for the return trip: the bounded box's
                // inner depth converts back to page scroll after the swap.
                restoreScrollRef.current = boundBoxH != null
                  ? { scrollTop: e.target.scrollTop, top: e.target.getBoundingClientRect().top }
                  : null
                setBodyMode('read')
              }}
              placeholder="Start writing…"
              autoComplete="off"
              autoCorrect="on"
              autoCapitalize="sentences"
              spellCheck={true}
              className="w-full text-[16px] md:text-[17px] text-gray-200 placeholder-gray-700 outline-none resize-none bg-transparent leading-relaxed"
              // Two geometries. Keyboard up: a FIXED-height box ending above
              // the format bar that scrolls internally — stable geometry,
              // iOS's native caret reveal does the rest. Otherwise (desktop,
              // keyboard rise): the unbounded auto-grown page, overflow
              // hidden because auto-grow leaves nothing to scroll (and a
              // desktop scrollbar would break metric parity with read mode).
              style={boundBoxH != null
                ? {
                    height: boundBoxH, flex: 'none', overflowY: 'auto',
                    overscrollBehavior: 'contain',
                    // Apple Notes-style room below the last line: half the
                    // visible box, so any line — the last included — can be
                    // scrolled well clear of the keyboard and bar.
                    paddingBottom: Math.round(boundBoxH / 2),
                    // The box's scroll indicator must sit where the page's
                    // does — at the screen edge — not at the text's right
                    // edge inside the column padding. Extend the box under
                    // the column's right padding and give the same amount
                    // back as the box's own padding: the text keeps its
                    // exact wrap width (metric parity with read mode), and
                    // the indicator moves to the edge. BODY_PAD_X mirrors the
                    // column's px-5 / md:px-10.
                    width: `calc(100% + ${bodyPadX}px)`,
                    marginRight: -bodyPadX,
                    paddingRight: bodyPadX,
                    userSelect: 'text', WebkitUserSelect: 'text',
                  }
                : { ...BODY_BOX_STYLE, overflowY: 'hidden' }}
            />
          ) : (
            /* Read mode. Same classes, same shared BODY_BOX_STYLE metrics as
               the textarea — the two must stay metric-identical or the caret
               mapping and the swap's scroll continuity drift.
               whitespace-pre-wrap + break-words match textarea wrapping; one
               block per raw line reproduces the same line layout. Known
               exception: a checkbox is not the same width as its raw "- [ ] "
               marker, so WRAPPING can drift slightly on checklist lines —
               the caret offset itself stays exact everywhere, it's a string
               offset and immune to wrapping. A click (never a scroll gesture
               — those don't produce clicks) drops into edit at the tapped
               character; empty space below the text appends. */
            <div
              ref={readRef}
              onClick={handleReadTap}
              className="note-read-body w-full text-[16px] md:text-[17px] text-gray-200 outline-none bg-transparent leading-relaxed whitespace-pre-wrap break-words"
              style={{ ...BODY_BOX_STYLE, cursor: 'text' }}
            >
              {text ? renderReadBody(text) : <span className="text-gray-700">Start writing…</span>}
            </div>
          )}
          {/* Fine pointer: the metadata row at the bottom of the note — the
              flex-grown body owns the blank space of a short note, so the
              row lands at the bottom of the screen; on a long note it
              follows the last line. */}
          {hasFinePointer && <div className="pt-2">{metaRow}</div>}
          {/* Scrollable tail below the last line (see the column comment):
              part of the tap target in read mode — a tap here appends. In
              edit mode it's inert, so the existing tap-away handling blurs
              as before. */}
          {!hasFinePointer && !(bodyMode === 'edit' && boundBoxH != null) && (
            <div
              onClick={bodyMode === 'read' ? handleReadTap : undefined}
              style={{ height: '60vh', flexShrink: 0, cursor: 'text' }}
            />
          )}
        </div>

      </div>

      {/* ── Details-sheet chevron — ONE element for open and closed ──────────
          The visible, tappable affordance (the swipe is the fast path for
          people who learn it; this is the path everyone can see — the
          long-press lesson). Rides chevronX, a pure transform of the sheet's
          own motion value, so it travels with the sheet's edge through every
          drag — never a second copy, never two on screen. Fades (never pops)
          for edit mode via SHEET_CHEVRON_OPACITY — the one prominence knob —
          and runs full-strength while the sheet is open, where it's the
          grip/close control. The icon flips direction with the state. */}
      {!docked && (
      <motion.button
        ref={chevronRef}
        type="button"
        aria-label={sheetOpen ? 'Close note details' : 'Note details'}
        onClick={() => {
          if (chevronDragRef.current.moved) return // that gesture was a drag
          if (chevronRestoreTapRef.current) { chevronRestoreTapRef.current = false; return } // restored it — that's all
          sheetOpen ? settleSheet(false) : openSheet()
        }}
        onTouchStart={handleChevronTouchStart}
        onTouchMove={handleChevronTouchMove}
        onTouchEnd={handleChevronTouchEnd}
        className="absolute flex items-center justify-center"
        style={{
          x: chevronX, y: '-50%',
          right: CHEVRON_EDGE_INSET, top: '50%',
          width: 28, height: 64, zIndex: 41,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 10, color: 'var(--text-muted)',
          touchAction: 'none',
          // Faded by scrolling → 0, but it keeps its pointer events so the
          // restoring tap lands on it.
          opacity: sheetOpen ? 1 : chevronVisible && !chevronFaded ? SHEET_CHEVRON_OPACITY : 0,
          pointerEvents: sheetOpen || chevronVisible ? 'auto' : 'none',
          transition: `opacity ${CHEVRON_FADE_MS}ms ease`,
        }}
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ transform: sheetOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </motion.button>
      )}

      {/* ── Details sheet ────────────────────────────────────────────────────
          Tags, filing and connections. Covers most of the width; the strip
          of note left visible closes it via the shared dismiss hook (which
          swallows the click so the tap can't edit the note). Inside the
          panel: clipped by the panel's overflow — which is what hides it at
          its closed rest position — and it slides with the panel during any
          panel motion. */}
      {/* Docked (desktop): absolutely positioned OFF the panel's right edge
          (left: 100%), full panel height, so the note panel keeps its own
          width and centering; a plain static sibling — no motion value, no
          inert, no gestures. The panel's right border is the seam, so no
          left border here; a right border closes the sheet off. Otherwise
          the slide-in overlay exactly as before. */}
      <motion.div
        ref={sheetRef}
        inert={docked || sheetOpen ? undefined : ''}
        className={docked ? 'flex flex-col min-h-0' : 'absolute inset-y-0 right-0 flex flex-col'}
        style={docked ? {
          position: 'absolute', top: 0, bottom: 0, left: '100%',
          width: SHEET_DOCK_W,
          background: 'var(--bg)',
          borderRight: '1px solid var(--border)',
        } : {
          x: sheetX,
          width: 'min(calc(100% - 56px), 380px)',
          background: 'var(--bg)',
          borderLeft: '1px solid var(--border)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
          zIndex: 40,
        }}
        onTouchStart={docked ? undefined : handleSheetTouchStart}
        onTouchMove={docked ? undefined : handleSheetTouchMove}
        onTouchEnd={docked ? undefined : handleSheetTouchEnd}
      >
        {/* (No chevron inside the sheet: THE chevron is the single
            panel-level element riding chevronX — it straddles this sheet's
            left border when open and travels with its edge during drags.) */}

        {/* STATIC content column — the sheet itself never scrolls: tags,
            project and connections hold their places; the tree box below is
            the one flex child allowed to shrink (and the only scroller). */}
        <div
          ref={sheetColRef}
          className="flex-1 min-h-0 flex flex-col gap-6"
          style={{
            paddingLeft: 16, paddingRight: 16,
            // The sheet spans the panel's full height, status bar and notch
            // included (the header above the note handles its own inset;
            // the sheet is a sibling, not a child of it), so the top inset
            // is the sheet's own job — same as the bottom already is.
            paddingTop: 'calc(1.25rem + env(safe-area-inset-top))',
            paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))',
          }}
        >

          {/* Tags — all in one wrapping row, under the same small-caps
              section label the other sections carry. */}
          <div className="flex-shrink-0">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Tags</p>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5 items-center">
            {allCustomTags.map(tag => {
              const selected = tags.includes(tag)
              const color = (project.customTagColors || {})[tag] || '#0A84FF'
              return (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className="text-sm font-medium transition-colors"
                  style={{ color: selected ? color : '#6b7280' }}
                >
                  #{tag}
                </button>
              )
            })}
            {addingTag ? (
              <input
                ref={tagInputRef}
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCustomTag() }
                  if (e.key === 'Escape') { setTagInput(''); setAddingTag(false) }
                }}
                onBlur={addCustomTag}
                placeholder="Tag name…"
                className="text-sm px-3 py-1.5 rounded-full outline-none bg-transparent text-gray-300 placeholder-gray-600"
                style={{ border: '1px solid var(--border)', width: 112 }}
              />
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm text-gray-500 border border-white/10 hover:border-white/25 hover:text-gray-400 transition-colors"
              >
                + Tag
              </button>
            )}
            </div>
          </div>

          {/* Bubble membership — the one section that may shrink: its labels
              and project row stay fixed, the tree box inside takes whatever
              height remains and scrolls only past that. */}
          <div className="flex flex-col min-h-0">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex-shrink-0">Project</p>
            <div className="space-y-0.5">
              {/* Project root — selecting it puts the note loose on the canvas */}
              {(() => {
                const selected = selectedBubbleIds.includes(ROOT_BUBBLE_ID)
                const color = '#6b7280'
                return (
                  <button
                    onClick={() => toggleBubble(ROOT_BUBBLE_ID)}
                    className="flex items-center gap-2 py-1 px-2 rounded-lg w-full text-left transition-all"
                    style={{ background: selected ? `${color}22` : 'transparent' }}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all"
                      style={{ backgroundColor: selected ? color : `${color}55` }}
                    />
                    <span
                      className="text-sm transition-colors"
                      style={{ color: selected ? 'var(--text)' : '#6b7280' }}
                    >
                      {project.name}
                    </span>
                  </button>
                )
              })()}
            </div>
            {/* No rule between PROJECT and BUBBLE — the small-caps labels
                carry the separation; the margin keeps the section rhythm. */}
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2 mt-4 flex-shrink-0">Bubble</p>
            <div
              ref={sheetTreeBoxRef}
              className="min-h-0 overflow-y-auto"
              // Snap type MANDATORY, not proximity: the point is that a row
              // is NEVER half-cut, and proximity only snaps when the rest
              // position lands near a snap point — a mid-flight stop could
              // still split a row. Uniform 36px rows snap cleanly. Rows are
              // the snap points (scroll-snap-align in BubblePickerTree).
              style={{ flex: '0 1 auto', overscrollBehavior: 'contain', scrollSnapType: 'y mandatory' }}
            >
              {/* The sheet's ONLY scroller. flex 0-1-auto: natural height
                  while the tree fits (no scrollbar), shrunk to the remaining
                  space when it doesn't — the depth-limited fit decision
                  (measureAvailable against that remainder, see
                  sheetTreeAvailable) folds the deepest levels until the
                  expanded tree is within SHEET_TREE_OVERFLOW_RATIO × that
                  space, so it scrolls at most that far. observeResize on the
                  column re-decides when the sheet's box changes (rotation,
                  or any window resize when docked). */}
              <BubblePickerTree
                bubbles={project.bubbles}
                rowHeight={36}
                measureAvailable={sheetTreeAvailable}
                observeResize={() => sheetColRef.current}
                // Session starts once the refs above exist (see sheetReady).
                active={sheetReady}
                // Docked, the fit session is the editor's lifetime, so a
                // resize hands control back to the rule; the overlay keeps
                // its open-to-close session semantics.
                refitOnResize={docked}
                // Touch / overlay: depth-limited, not all-or-nothing — open as
                // deep as fits within SHEET_TREE_OVERFLOW_RATIO × the box,
                // deepest levels folded first. Docked (desktop): NO fit
                // decision at all — an unlimited row budget expands everything
                // without measuring; the tree box scrolls if it's enormous.
                // The pickers and sidebar keep the all-or-nothing rule.
                overflowRatio={docked ? null : SHEET_TREE_OVERFLOW_RATIO}
                maxExpandedRows={docked ? Infinity : undefined}
                renderRow={renderBubblePickerRow}
              />
            </div>
          </div>

          {/* Connections */}
          <div ref={sheetConnRef} className="flex-shrink-0">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Connections</p>

            {/* Forward connections: this note → other note (deletable) */}
            {connections.map((conn, idx) => {
              const otherNote = project.notes.find(n => n.id === conn.note_id)
              const thisTitle = displayTitle || 'Untitled'
              const otherTitle = otherNote ? titleOf(otherNote) : null
              const otherLocked = otherNote ? lockIndex.gatedNoteIds.has(otherNote.id) : false
              return (
                <div key={`fwd-${idx}`} className="flex items-center gap-2 bg-white/6 rounded-lg px-3 py-2 mb-1.5">
                  <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
                    <span className="text-gray-300 truncate max-w-[120px]">{thisTitle}</span>
                    <span className="text-gray-500 italic flex-shrink-0">{connectionType(conn)}</span>
                    {otherNote ? (
                      <button
                        onClick={() => otherLocked
                          ? requestUnlock(lockIndex.gatingIdsFor({ ...otherNote, type: 'note' }))
                          : handleNavigateToConnectedNote(otherNote)}
                        className={`transition-colors truncate max-w-[120px] ${otherLocked ? 'text-gray-500' : 'text-indigo-400 hover:text-indigo-300'}`}
                      >
                        {otherTitle}
                      </button>
                    ) : (
                      <span className="text-gray-600 italic">Deleted note</span>
                    )}
                  </div>
                  <button onClick={() => removeConnection(idx)} className="text-gray-400 hover:text-red-500 flex-shrink-0 text-base leading-none">×</button>
                </div>
              )
            })}

            {/* Reverse connections: other notes that point to this note (read-only here) */}
            {project.notes.flatMap(n => {
              if (n.id === note.id) return []
              return n.connections
                .filter(c => c.note_id === note.id)
                .map((conn, i) => {
                  const otherTitle = titleOf(n)
                  const otherLocked = lockIndex.gatedNoteIds.has(n.id)
                  const thisTitle = displayTitle || 'Untitled'
                  return (
                    <div key={`rev-${n.id}-${i}`} className="flex items-center gap-2 bg-white/6 rounded-lg px-3 py-2 mb-1.5">
                      <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
                        <button
                          onClick={() => otherLocked
                            ? requestUnlock(lockIndex.gatingIdsFor({ ...n, type: 'note' }))
                            : handleNavigateToConnectedNote(n)}
                          className={`transition-colors truncate max-w-[120px] ${otherLocked ? 'text-gray-500' : 'text-indigo-400 hover:text-indigo-300'}`}
                        >
                          {otherTitle}
                        </button>
                        <span className="text-gray-500 italic flex-shrink-0">{connectionType(conn)}</span>
                        <span className="text-gray-300 truncate max-w-[120px]">{thisTitle}</span>
                      </div>
                    </div>
                  )
                })
            })}

            {addingConnection ? (
              <div className="space-y-2 bg-white/5 rounded-xl p-3">
                <select
                  value={connNoteId}
                  onChange={e => setConnNoteId(e.target.value)}
                  className="w-full text-sm border border-white/15 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-500 bg-[#2C2C2E] text-white"
                >
                  <option value="">Select a note…</option>
                  {connectableNotes.map(n => (
                    <option key={n.id} value={n.id}>
                      {titleOf(n).slice(0, 60)}
                    </option>
                  ))}
                </select>
                <select
                  value={connType}
                  onChange={e => setConnType(e.target.value)}
                  className="w-full text-sm border border-white/15 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-500 bg-[#2C2C2E] text-white"
                >
                  {CONNECTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  <option value="__custom__">Custom type…</option>
                </select>
                {connType === '__custom__' && (
                  <input
                    value={customConnType}
                    onChange={e => setCustomConnType(e.target.value)}
                    placeholder="Relationship type…"
                    className="w-full text-sm border border-white/15 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-500 bg-[#2C2C2E] text-white placeholder-gray-600"
                  />
                )}
                <div className="flex gap-2">
                  <button
                    onClick={addConnection}
                    disabled={!connNoteId}
                    className="flex-1 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                  >Add Connection</button>
                  <button
                    onClick={() => setAddingConnection(false)}
                    className="flex-1 py-1.5 text-xs font-medium bg-white/8 text-gray-300 rounded-lg hover:bg-white/12 transition-colors"
                  >Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingConnection(true)}
                disabled={connectableNotes.length === 0}
                className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <span className="text-sm leading-none font-bold">+</span>
                Add connection
              </button>
            )}
          </div>

        </div>
      </motion.div>

      {/* ── Format bar — floats above the software keyboard ─────────────────
          Only while the body is editing AND the keyboard is actually up
          (kbGeom), so it can never float without a keyboard beneath it. An
          absolute child of the panel: the panel spans the layout viewport,
          so translateY positions the row FORMAT_BAR_GAP above the keyboard's
          top edge — a visible gap, the bar reads as floating rather than
          attached — and during edge-swipe-back it slides with the panel like
          everything else. Two detached pieces, Obsidian-style: a fully
          rounded pill of scrollable controls, and a separate dismiss circle
          to its right. Both fill with the app's surface treatment
          (--surface, hairline border, soft shadow), not a bright panel.
          The pill scrolls horizontally — ten 44px controls, deliberately;
          targets never shrink to fit the viewport. Touch events stop at this
          row: a gesture that starts on the bar belongs to the bar (scrolling
          the pill must not simultaneously drag the panel's edge-swipe or
          count as tap-away movement), while gestures starting anywhere else
          are untouched. data-keep-edit stays on the container as the
          documented tap-away exemption, and onMouseDown preventDefault keeps
          any focus steal from collapsing the selection the transforms
          operate on. */}
      {bodyMode === 'edit' && kbGeom.up && (
        <div
          data-keep-edit=""
          className="absolute flex items-center"
          style={{
            top: 0,
            left: 12,
            right: 12,
            height: FORMAT_BAR_H,
            gap: 10,
            transform: `translateY(${kbGeom.bottom - FORMAT_BAR_GAP - FORMAT_BAR_H}px)`,
            zIndex: 30,
          }}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
          onTouchEnd={e => e.stopPropagation()}
        >
          <div
            className="hide-scrollbar flex items-center h-full flex-1 min-w-0"
            style={{
              overflowX: 'auto',
              WebkitOverflowScrolling: 'touch',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: FORMAT_BAR_H / 2,
              boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
              padding: '0 8px',
            }}
          >
          <button
            type="button"
            aria-label="Undo"
            onMouseDown={e => e.preventDefault()}
            onClick={undo}
            disabled={past.length === 0}
            className="h-full flex items-center justify-center active:opacity-50 disabled:opacity-25"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a6 6 0 010 12H9m-6-12l4-4m-4 4l4 4" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Redo"
            onMouseDown={e => e.preventDefault()}
            onClick={redo}
            disabled={future.length === 0}
            className="h-full flex items-center justify-center active:opacity-50 disabled:opacity-25"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 10H11a6 6 0 000 12h4m6-12l-4-4m4 4l-4 4" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Checklist"
            onMouseDown={e => e.preventDefault()}
            onClick={() => applyFormat('checklist')}
            className="h-full flex items-center justify-center active:opacity-50"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 12.2l2.4 2.4 4.6-5" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Bulleted list"
            onMouseDown={e => e.preventDefault()}
            onClick={() => applyFormat('bullet')}
            className="h-full flex items-center justify-center active:opacity-50"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="5" cy="7" r="1.6" fill="currentColor" stroke="none" />
              <circle cx="5" cy="17" r="1.6" fill="currentColor" stroke="none" />
              <path strokeLinecap="round" d="M10 7h10M10 17h10" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Numbered list"
            onMouseDown={e => e.preventDefault()}
            onClick={() => applyFormat('numbered')}
            className="h-full flex items-center justify-center active:opacity-50"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <text x="2" y="10" fontSize="9" fill="currentColor" stroke="none">1.</text>
              <text x="2" y="21" fontSize="9" fill="currentColor" stroke="none">2.</text>
              <path strokeLinecap="round" d="M11 6.5h9M11 17.5h9" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Header"
            onMouseDown={e => e.preventDefault()}
            onClick={() => applyFormat('header')}
            className="h-full flex items-center justify-center active:opacity-50"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <span className="text-[20px] font-semibold leading-none">H</span>
          </button>
          <button
            type="button"
            aria-label="Bold"
            onMouseDown={e => e.preventDefault()}
            onClick={() => applyFormat('bold')}
            className="h-full flex items-center justify-center active:opacity-50"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <span className="text-[19px] font-bold leading-none">B</span>
          </button>
          <button
            type="button"
            aria-label="Italic"
            onMouseDown={e => e.preventDefault()}
            onClick={() => applyFormat('italic')}
            className="h-full flex items-center justify-center active:opacity-50"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation', fontFamily: 'Georgia, serif' }}
          >
            <span className="text-[20px] italic leading-none">I</span>
          </button>
          <button
            type="button"
            aria-label="Link"
            onMouseDown={e => e.preventDefault()}
            onClick={() => applyFormat('link')}
            className="h-full flex items-center justify-center active:opacity-50"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M10.5 13.5a4.2 4.2 0 006 0l3.2-3.2a4.24 4.24 0 00-6-6l-1.6 1.6" />
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M13.5 10.5a4.2 4.2 0 00-6 0l-3.2 3.2a4.24 4.24 0 006 6l1.6-1.6" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Strikethrough"
            onMouseDown={e => e.preventDefault()}
            onClick={() => applyFormat('strike')}
            className="h-full flex items-center justify-center active:opacity-50"
            style={{ width: 48, flexShrink: 0, color: 'var(--text-2)', touchAction: 'manipulation' }}
          >
            <span className="text-[19px] font-medium leading-none line-through">S</span>
          </button>
          </div>
          {/* Dismiss circle — a separate piece, not part of the pill. Not a
              new mechanism: the explicit blur is the very call tap-away
              makes, so it flows through the same onBlur → read swap (and the
              keyboard-gone watchdog would agree anyway). */}
          <button
            type="button"
            aria-label="Dismiss keyboard"
            onMouseDown={e => e.preventDefault()}
            onClick={() => bodyRef.current?.blur()}
            className="flex items-center justify-center active:opacity-50 flex-shrink-0"
            style={{
              width: FORMAT_BAR_H,
              height: FORMAT_BAR_H,
              borderRadius: '50%',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
              color: 'var(--text-2)',
              touchAction: 'manipulation',
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="3.5" width="18" height="11.5" rx="2" />
              <path strokeLinecap="round" strokeWidth="1.9"
                d="M6.2 6.8h.01M9.4 6.8h.01M12.6 6.8h.01M15.8 6.8h.01M6.2 9.4h.01M9.4 9.4h.01M12.6 9.4h.01M15.8 9.4h.01M17.8 6.8h.01M17.8 9.4h.01M8 12.2h8" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.2 18.2l2.8 2.8 2.8-2.8" />
            </svg>
          </button>
        </div>
      )}

    </div>

    {/* Delete confirmation modal */}
    <AnimatePresence>
      {showDeleteConfirm && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: zIndex + 10, background: 'rgba(0,0,0,0.6)' }}
          // Destructive confirm: no outside-press dismissal — explicit
          // choice or Escape only.
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
            <h2 className="text-white font-semibold text-lg text-center mb-1">Delete Note?</h2>
            <p className="text-gray-400 text-sm text-center mb-5">This note will be permanently deleted.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
                style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
              >
                Delete
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </motion.div>
  )
}
