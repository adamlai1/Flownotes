import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, createContext, useContext } from 'react'
import { flushSync } from 'react-dom'
import { motion, AnimatePresence, useMotionValue, animate } from 'framer-motion'
import { getNoteCountForBubble, getBubbleDescendantIds, getNoteTitle, contrastColor } from '../utils/helpers'
import { buildLockIndex } from '../utils/locks'
import {
  fitNameFont, nameBoxHeight,
  TEXT_PAD, NAME_COUNT_GAP, COUNT_FONT, COUNT_LINE_H,
  NAME_MAX_FONT, NAME_MIN_FONT, NAME_LINE_H,
} from '../utils/bubbleText'
import { TAG_COLORS, ROOT_BUBBLE_ID } from '../data/defaultData'
import { useTheme } from '../contexts/ThemeContext'
import { usePreferences, NOTE_SIZE_SCALE } from '../contexts/PreferencesContext'
import { useLock } from '../contexts/LockContext'
import { useEscapeLayer, ESC_LEVEL } from '../lib/escapeStack'
import ConfirmDialog from './ConfirmDialog'

// ─── Position persistence ─────────────────────────────────────────────────────

function posKey(projectId, contextId, itemId) {
  return `${projectId}:${contextId ?? 'root'}:${itemId}`
}

function loadSavedPositions(projectId) {
  try { return JSON.parse(localStorage.getItem(`mindmap-pos-${projectId}`)) || {} }
  catch { return {} }
}

function saveSavedPositions(projectId, positions) {
  try { localStorage.setItem(`mindmap-pos-${projectId}`, JSON.stringify(positions)) }
  catch {}
}

// ─── Paged assignment persistence ──────────────────────────────────────────────
// Which page each bubble lives on: { [posKey]: pageIndex }. Positions within a page
// reuse the normal per-item saved x/y (an item is only ever on one page at a time),
// so every page keeps the same free-form layout + physics as the single-page view.

function loadSavedPages(projectId) {
  try { return JSON.parse(localStorage.getItem(`mindmap-pages-${projectId}`)) || {} }
  catch { return {} }
}

function saveSavedPagesMap(projectId, map) {
  try { localStorage.setItem(`mindmap-pages-${projectId}`, JSON.stringify(map)) }
  catch {}
}

// Assign each item to a page: honour saved assignments, then bin-pack the rest into
// the first page that still has room (so overflow naturally spills to a new page).
//
// Bubbles are packed FIRST and judge a page's fullness by its BUBBLE count only, so a
// note dropped onto a full page can never displace a bubble — the page's note count no
// longer pushes bubbles to the next page. Notes are packed afterwards against the true
// total, so they absorb all the overflow themselves. (A page can therefore end up a
// couple of items over perPage when notes are pinned onto a page holding bubbles; the
// layout tolerates that, and keeping bubbles put is what matters here.)
function assignPages(items, savedPages, projectId, contextId, perPage) {
  const pageOf = {}
  const counts = {}        // every item, per page
  const bubbleCounts = {}  // bubbles only, per page
  const unassignedBubbles = []
  const unassignedNotes = []
  for (const it of items) {
    const p = savedPages[posKey(projectId, contextId, it.id)]
    if (Number.isInteger(p) && p >= 0) {
      pageOf[it.id] = p
      counts[p] = (counts[p] || 0) + 1
      if (it.type !== 'note') bubbleCounts[p] = (bubbleCounts[p] || 0) + 1
    } else {
      (it.type === 'note' ? unassignedNotes : unassignedBubbles).push(it)
    }
  }
  let bubbleCursor = 0
  for (const it of unassignedBubbles) {
    while ((bubbleCounts[bubbleCursor] || 0) >= perPage) bubbleCursor++
    pageOf[it.id] = bubbleCursor
    bubbleCounts[bubbleCursor] = (bubbleCounts[bubbleCursor] || 0) + 1
    counts[bubbleCursor] = (counts[bubbleCursor] || 0) + 1
  }
  let cursor = 0
  for (const it of unassignedNotes) {
    while ((counts[cursor] || 0) >= perPage) cursor++
    pageOf[it.id] = cursor
    counts[cursor] = (counts[cursor] || 0) + 1
  }
  return pageOf
}

// Re-flow one level's SAVED page assignments against a new per-page capacity.
//
// Only saved assignments need this: everything else is packed from scratch by
// assignPages on the next render, so it already tracks the current capacity. A saved
// assignment is an absolute page number written when the user dragged an item across a
// page edge, and it survives a capacity change unchanged — which is exactly what leaves
// pages overfull after the note size grows, and half-empty after it shrinks.
//
// Two rules, applied in order, both keyed off the new capacity:
//   • Pull forward — the level can only span ceil(total / perPage) pages now, so an
//     assignment past the last of them is clamped onto it. This is what fills the room
//     a smaller note size just freed up.
//   • Spill forward — walking the assignments in page order, an item landing on a page
//     already holding perPage of them moves to the next page with room, cascading. This
//     is what empties a page the larger note size just overfilled.
// Relative order is preserved throughout, so a hand-made arrangement survives the
// change as far as the new capacity allows.
export function reflowSavedPages(entries, perPage, totalItems) {
  const maxPage = Math.max(0, Math.ceil(totalItems / perPage) - 1)
  const ordered = entries
    .map(([id, page], i) => ({ id, page: Math.min(Math.max(page, 0), maxPage), i }))
    .sort((a, b) => a.page - b.page || a.i - b.i)
  const next = {}
  const counts = {}
  for (const { id, page } of ordered) {
    let p = page
    while ((counts[p] || 0) >= perPage) p++
    next[id] = p
    counts[p] = (counts[p] || 0) + 1
  }
  return next
}

// The items a level holds, by type — the same membership rules the render path uses,
// but for an arbitrary level rather than the visible one (contextKey is a bubble id, or
// 'root' for the top level, matching posKey).
function levelItemCounts(project, contextKey) {
  const contextId = contextKey === 'root' ? null : contextKey
  const bubbleN = project.bubbles.filter(b => b.parent_id === contextId).length
  const noteN = contextId
    ? project.notes.filter(n => n.bubble_ids.includes(contextId)).length
    : project.notes.filter(n => n.bubble_ids.length === 0 || n.bubble_ids.includes(ROOT_BUBBLE_ID)).length
  return { bubbleN, noteN }
}

// Split a saved-pages/positions key back into its level and item parts, or null if the
// key doesn't belong to this project. Ids carry no colons, so the first two are ours.
function splitPosKey(key, projectId) {
  const prefix = `${projectId}:`
  if (!key.startsWith(prefix)) return null
  const rest = key.slice(prefix.length)
  const cut = rest.indexOf(':')
  if (cut < 0) return null
  return { contextKey: rest.slice(0, cut), itemId: rest.slice(cut + 1) }
}

// ─── Layout randomness ────────────────────────────────────────────────────────
// Every organic-looking offset below is a pure function of an item's index and its
// page's seed. It HAS to be: the layout is recomputed from scratch on every render, so
// a Math.random() would re-roll on each frame and the whole page would shimmer. These
// are the standard sin-based shader hashes — cheap, and mixed enough between the two
// inputs that the x and y offsets of one item don't visibly correlate.

// Deterministic pseudo-random in [-1, 1] from a pair of integers.
function hash2(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}

// FNV-1a over a string → a stable integer, so a level's identity can seed its layout.
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// One seed per (level, page). Pages of the same level get different seeds so they don't
// all repeat the same silhouette, and different levels differ too — otherwise every
// bubble you opened showed its notes in the identical arrangement.
const layoutSeed = (contextId, pageIndex = 0) =>
  (hashStr(`${contextId ?? 'root'}#${pageIndex}`) % 4096) + 1

// Lay out ONE page's items exactly like the single-page view: organic scatter from
// computeLayout, overridden by saved positions, new items settled, overlaps cleared.
function layoutPage(pageItems, savedPositions, projectId, contextId, width, height, noteScale = 1, seed = 0) {
  if (width <= 0) return []
  const laid = computeLayout(pageItems, width, height, SUB_BAR_H, BOTTOM_PAD, noteScale, seed)
  const laidMapped = laid.map(item => {
    const saved = savedPositions[posKey(projectId, contextId, item.id)]
    return saved ? { ...item, cx: saved.xFrac * width, cy: saved.yFrac * height } : item
  })
  const anchored = new Set(
    laidMapped.filter(item => savedPositions[posKey(projectId, contextId, item.id)]).map(i => i.id)
  )
  // Mixed page with saved positions: flow the free notes around the bubbles' actual
  // (loaded) locations instead of just settling them off the phantom fresh layout.
  if (anchored.size > 0) {
    const arranged = arrangeNotesAroundBubbles(laidMapped, anchored, width, height)
    if (arranged) return arranged
  }
  const settled = (anchored.size > 0 && anchored.size < laidMapped.length)
    ? settleItems(laidMapped, anchored, width, height)
    : laidMapped
  return separateOverlaps(settled, width, height, shouldPinBubbles(settled, anchored.size))
}

// Everything layoutPage's OUTPUT depends on, as one string — the cache key for a page.
//
// The rendered item objects carry far more than this: name, colour, tags, lock state,
// note body, child/note counts. All of that changes without moving anything, which is
// why the cache stores coordinates only and the caller re-merges the live item objects
// onto them. What actually moves an item is: the page's item ids IN ORDER (computeLayout
// places by index), each one's size input (the note flag, or a bubble's contentCount —
// bubble radii are log-scaled against the busiest bubble ON THIS PAGE, so every
// contentCount on the page belongs here), the page geometry, the note-size scale, the
// page's layout seed, and any saved drag positions among them.
//
// Adding, removing or moving an item between pages changes some page's id list; a
// resize or a note-size change alters the geometry for every page; a drop rewrites the
// saved positions. Each of those falls out of the key on its own.
function pageLayoutKey(group, savedPositions, projectId, contextId, width, height, noteScale, seed) {
  let key = `${projectId}|${contextId ?? 'root'}|${width}x${height}|${noteScale}|${seed}`
  for (const it of group) {
    key += `|${it.id}:${it.type === 'note' ? 'n' : it.contentCount || 0}`
    const saved = savedPositions[posKey(projectId, contextId, it.id)]
    if (saved) key += `@${saved.xFrac.toFixed(5)},${saved.yFrac.toFixed(5)}`
  }
  return key
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  if (!hex || hex[0] !== '#') return '99,102,241'
  const h = hex.length === 4
    ? hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex.slice(1)
  const n = parseInt(h, 16)
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}

function solidMutedColor(hex) {
  if (!hex || hex[0] !== '#') return '#9ca3af'
  const h = hex.length === 4
    ? hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex.slice(1)
  const n = parseInt(h, 16)
  const r = Math.round(((n >> 16) & 255) * 0.82 + 255 * 0.18)
  const g = Math.round(((n >> 8) & 255) * 0.82 + 255 * 0.18)
  const b = Math.round((n & 255) * 0.82 + 255 * 0.18)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}


// ─── Layout ───────────────────────────────────────────────────────────────────

// Note squares render at W = r*1.55, H = r*1.15, so their half-extents are these
// fractions of r. Notes are separated by their real box, not the bounding circle.
const NOTE_HW = 1.55 / 2   // half-width  / r  = 0.775
const NOTE_HH = 1.15 / 2   // half-height / r  = 0.575

// Note spacing per axis. Horizontal: a tight 5px. Vertical: the float animation bobs each
// note UP by floatAmt = 2.5 + (index % 3) * 1.5 → up to 5.5px, so vertically adjacent notes
// need that extra clearance on top of the base gap or they visually collide mid-bob.
const NOTE_GAP_X = 5
const NOTE_GAP_Y = 11      // 5px base + 5.5px max float travel, rounded up

// Category bubbles render as wide rounded rectangles at W = r*2, H = r*1.33 (a ~3:2
// card), so their half-extents are these fractions of r. `r` is NOT a circle radius
// anywhere any more — it's the size scalar the box is derived from, and every packing,
// collision, bounds and hit test below measures a bubble by that box.
const BUB_HW = 2 / 2       // half-width  / r  = 1.0
const BUB_HH = 1.33 / 2    // half-height / r  = 0.665

// Bubbles bob UP by floatAmt = 2.5 + (index % 3) * 1.5 → up to 5.5px, so any pair
// involving a bubble needs that much extra vertical clearance on top of the pass's
// base gap or the boxes visually collide mid-bob (the same reason NOTE_GAP_Y > NOTE_GAP_X).
const BUB_FLOAT_PAD = 6
// Base inter-bubble gap: tighter when a page is crowded so many bubbles pack closer.
const bubPackGap = (n) => n > 16 ? 4 : n > 10 ? 6 : 8

// Minimum bubble size — the floor every other bubble size derives from. MIN_BUB_D is the
// box's WIDTH (BUB_HW is 1, so width = 2r); the height follows from BUB_HH.
const MIN_BUB_D = 80
const MIN_BUB_R = MIN_BUB_D / 2
// How far inside each screen edge an item's box is held (see clampToBounds).
const EDGE_INSET = 12

// Note cards render at the user's note-size preference; category bubbles are sized by
// content and never scaled by it. With a fixed bubble floor, a sparse bubble stayed at
// MIN_BUB_D while notes grew past it, so at medium/large a note card rendered BIGGER than
// the bubbles beside it. The floor therefore has to rise with the note size. Height is the
// binding axis (NOTE_HH/BUB_HH = 0.865 > NOTE_HW/BUB_HW = 0.775), and at small the ratio
// lands below MIN_BUB_R so that setting is unchanged.
const NOTE_TO_BUB_R = Math.max(NOTE_HW / BUB_HW, NOTE_HH / BUB_HH)
const noteRFor = (noteScale) => MIN_BUB_R * noteScale
const minBubbleRFor = (noteScale) => Math.max(MIN_BUB_R, noteRFor(noteScale) * NOTE_TO_BUB_R)

// The content-scaled bubble radius range for a page of this size, BEFORE the fill-scale:
// the floor every bubble starts at, and the ceiling the busiest one on the page reaches.
// These are seed sizes — the cluster is scaled to the page afterwards, so what actually
// renders can be well outside this range in either direction.
function bubbleRRange(width, availH, noteScale) {
  const base = Math.min(width, availH) * 0.4
  const minR = Math.max(base * 0.15, minBubbleRFor(noteScale))
  return { minR, maxR: Math.max(Math.min(base * 0.42, 124), minR) }
}

// Largest bubble radius that still fits the page on both axes. Nothing downstream can
// place an item bigger than its page: every pass just clamps it against the edges and
// leaves it overlapping whatever it lands on. So this is a hard ceiling on any size the
// fill-scaling below computes, not a preference.
function maxFittingBubbleR(width, availH) {
  return Math.min(
    (width - EDGE_INSET * 2) / (2 * BUB_HW),
    (availH - EDGE_INSET * 2) / (2 * BUB_HH),
  )
}
// Corner rounding, as a fraction of the box's short side. Exported because it is what
// makes a note square, a category bubble and the floating + button read as the same
// family of shape — anything else adopting that silhouette should round by this, not by
// a number that happens to match today.
export const CORNER_RATIO = 0.22
// Resolved to px so the corners stay circular instead of stretching into ellipses along
// the wide axis (which a `%` radius would do).
const bubbleCornerPx = (r) => Math.round(r * BUB_HH * 2 * CORNER_RATIO)

// Rectangle (AABB) separation for a pair. Pushes the pair apart along the axis of least
// penetration so their boxes keep gapX/gapY px between edges. Mutates whichever endpoints
// the move callbacks set. Returns how deep the pair was overlapping (0 if already clear),
// so callers can both test "did this push?" and score how bad a whole arrangement is.
function separateBoxPair(dx, dy, halfWa, halfHa, halfWb, halfHb, gapX, gapY, pushX, pushY) {
  const ox = halfWa + halfWb + gapX - Math.abs(dx)
  const oy = halfHa + halfHb + gapY - Math.abs(dy)
  if (ox <= 0 || oy <= 0) return 0
  if (ox < oy) pushX((ox / 2) * (dx < 0 ? -1 : 1))
  else pushY((oy / 2) * (dy < 0 ? -1 : 1))
  return Math.min(ox, oy)
}
// Rendered half-extents — the single source of truth for how big an item is on screen.
const halfWidthOf  = (p) => p.type === 'note' ? p.r * NOTE_HW : p.r * BUB_HW
const halfHeightOf = (p) => p.type === 'note' ? p.r * NOTE_HH : p.r * BUB_HH

// Per-axis minimum gap for a pair, given a pass's base gap. Note-note pairs keep the
// note grid's fixed gaps (the even-spread grid is built to them); any pair involving a
// bubble uses the base gap, plus the float-bob clearance on the vertical axis.
const pairGapX = (a, b, base) => (a.type === 'note' && b.type === 'note') ? NOTE_GAP_X : base
const pairGapY = (a, b, base) => (a.type === 'note' && b.type === 'note') ? NOTE_GAP_Y : base + BUB_FLOAT_PAD

// Symmetric box separation for ANY pair at the pass's base gap. Mutates a and b.
function separatePair(a, b, base) {
  return separateBoxPair(
    b.cx - a.cx, b.cy - a.cy,
    halfWidthOf(a), halfHeightOf(a), halfWidthOf(b), halfHeightOf(b),
    pairGapX(a, b, base), pairGapY(a, b, base),
    (p) => { a.cx -= p; b.cx += p }, (p) => { a.cy -= p; b.cy += p },
  )
}

// Circle vs box penetration: distance from the circle's center to the nearest point of
// the item's rendered rectangle, versus the circle radius + gap. Returns the penetration
// depth (0 if clear); callers push along the center-to-center direction. Used for the one
// genuinely round obstacle left on the page — the floating + button.
function circleBoxPen(circle, item, gap) {
  const hw = halfWidthOf(item), hh = halfHeightOf(item)
  const px = Math.max(item.cx - hw, Math.min(circle.cx, item.cx + hw))
  const py = Math.max(item.cy - hh, Math.min(circle.cy, item.cy + hh))
  const d = Math.hypot(px - circle.cx, py - circle.cy)
  return Math.max(0, circle.r + gap - d)
}

// Rightmost note-CENTER x for a grid row at cy that keeps the note's real BOX clear of
// the + button (plus `pad` slack); Infinity when the row clears the button vertically.
// Measuring the card as its bounding circle (r=40, +10 margin) reserved ~45px more
// horizontal room than the 62x46 card needs, costing the bottom rows a cell each.
// The grid and noteGridCapacity MUST both use this so capacity matches placement.
const BTN_ROW_PAD = 4
function noteRowXMax(cy, width, height, hw, hh) {
  const btnCx = width - 52, btnCy = height - 52
  const need = PLUS_BTN_EXCL_R + BTN_ROW_PAD
  const vGap = Math.max(0, Math.abs(cy - btnCy) - hh)
  if (vGap >= need) return Infinity
  return btnCx - hw - Math.sqrt(need * need - vGap * vGap)
}

// ── Lloyd spread ──────────────────────────────────────────────────────────────
// Even out a MIXED page (bubbles + notes) by repeatedly moving each item to the
// centroid of the page region it owns (power diagram: bigger items claim more area).
// Packing + fit-scaling alone only pushes overlapping items apart — nothing
// distributes them, so a fresh mixed layout clumped in the middle. A uniform grid
// (the notes-only path) doesn't apply when item sizes differ, but Lloyd handles
// mixed sizes naturally and fills the page evenly. Deterministic; ~30 iterations
// over an ~18px sample lattice, run once per fresh page layout.
// pinnedNoteIds: notes that must not move (user-saved positions) — only free notes
// redistribute around them and the pinned bubbles.
//
// A BUBBLE-ONLY page has no notes to redistribute, so the two rules that exist to protect
// the cluster from them — pinning the bubbles, and fencing off the cluster's interior —
// would leave the pass with nothing to do. There, the bubbles ARE the items being spread,
// and they get the same even coverage the notes get everywhere else.
function lloydSpread(items, width, height, headerH, bottomPad, pinnedNoteIds = null) {
  const pos = items.map(i => ({ ...i }))
  const bubblesOnly = !pos.some(p => p.type === 'note')
  const step = 18
  const btnCx = width - 52, btnCy = height - 52
  // Effective claim radius — one scalar per item for the power diagram, sized so each
  // type claims page area in proportion to the box it actually occupies (a bubble is
  // wider than a note but also much shorter, so its claim is the geometric mean of its
  // half-extents rather than its full half-width).
  const rEff = (p) => p.type === 'note'
    ? p.r * 0.85
    : p.r * Math.sqrt(BUB_HW * BUB_HH)
  // The bubble cluster's ellipse is note-forbidden territory: samples inside it are
  // owned by nobody, so no note's centroid can pull it into the pockets between
  // bubbles. (Bubbles are pinned, so the ellipse is constant across passes.)
  const bubs = pos.filter(p => p.type !== 'note')
  const eCl = (bubs.length > 0 && !bubblesOnly) ? clusterEllipse(bubs) : null
  for (let t = 0; t < 30; t++) {
    const sx = new Array(pos.length).fill(0)
    const sy = new Array(pos.length).fill(0)
    const sc = new Array(pos.length).fill(0)
    for (let y = headerH + step / 2; y < height - bottomPad; y += step) {
      for (let x = step / 2; x < width; x += step) {
        const bdx = x - btnCx, bdy = y - btnCy
        if (bdx * bdx + bdy * bdy < 46 * 46) continue // + button zone owned by nobody
        if (eCl && insideEllipse(x, y, eCl, 0, 0)) continue // cluster interior: not note territory
        let bi = 0, bd = Infinity
        for (let k = 0; k < pos.length; k++) {
          const dx = x - pos[k].cx, dy = y - pos[k].cy
          const d = dx * dx + dy * dy - rEff(pos[k]) * rEff(pos[k])
          if (d < bd) { bd = d; bi = k }
        }
        sx[bi] += x; sy[bi] += y; sc[bi]++
      }
    }
    for (let k = 0; k < pos.length; k++) {
      if (!sc[k]) continue
      // Bubbles are pinned: they stay in their cluster (centered or saved); only
      // notes redistribute into the space around them — and user-saved notes are
      // pinned too when pinnedNoteIds is given. On a bubble-only page there is no
      // cluster to protect, so the bubbles themselves are what spreads.
      if (!bubblesOnly && pos[k].type !== 'note') continue
      if (pinnedNoteIds && pinnedNoteIds.has(pos[k].id)) continue
      // Damped move toward the owned-region centroid.
      pos[k].cx += (sx[k] / sc[k] - pos[k].cx) * 0.75
      pos[k].cy += (sy[k] / sc[k] - pos[k].cy) * 0.75
    }
  }
  return pos
}

// ── Cluster ellipse ───────────────────────────────────────────────────────────
// The note-free zone around a mixed page's bubble cluster. An ellipse fitted to the
// bubbles' bounding box hugs elongated clusters far tighter than the circumscribed
// circle (notes can crowd right against the cluster's silhouette) while staying
// convex — so the between-bubble pockets remain off-limits to notes.
function clusterEllipse(bubs) {
  const minX = Math.min(...bubs.map(b => b.cx - halfWidthOf(b))), maxX = Math.max(...bubs.map(b => b.cx + halfWidthOf(b)))
  const minY = Math.min(...bubs.map(b => b.cy - halfHeightOf(b))), maxY = Math.max(...bubs.map(b => b.cy + halfHeightOf(b)))
  return { ex: (minX + maxX) / 2, ey: (minY + maxY) / 2, A: (maxX - minX) / 2, B: (maxY - minY) / 2 }
}
// Per-axis clearances so a note is held off by its real half-extents (31px wide,
// 23px tall + buffer), not its fat bounding circle — a ~16px smaller vertical moat.
function insideEllipse(x, y, e, clearX, clearY) {
  const tx = (x - e.ex) / (e.A + clearX), ty = (y - e.ey) / (e.B + clearY)
  return tx * tx + ty * ty < 1
}
// Push p radially (from the ellipse center) onto the clear-dilated boundary.
// Returns true if p was inside and got moved.
function projectOutOfEllipse(p, e, clearX, clearY) {
  const dx = p.cx - e.ex, dy = p.cy - e.ey
  const a = e.A + clearX, b = e.B + clearY
  const t = Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b))
  if (t >= 1) return false
  if (t < 0.001) { p.cx = e.ex + a; return true }
  p.cx = e.ex + dx / t
  p.cy = e.ey + dy / t
  return true
}

// ── Centered bubble cluster (mixed pages) ─────────────────────────────────────
// Re-cluster a mixed page's bubbles compactly around the page center: mini golden-angle
// spiral seed, pairwise box relaxation, and the cluster centroid re-anchored to the
// center each pass. The notes around them are then distributed by lloydSpread (which
// pins bubbles), so mixed pages read as "bubbles in the middle, notes around them".
function recenterBubbles(items, width, height, headerH, bottomPad, noteScale = 1) {
  const pos = items.map(i => ({ ...i }))
  const bubs = pos.filter(p => p.type !== 'note')
  if (bubs.length === 0) return pos
  const cx0 = width / 2
  const cy0 = headerH + (height - headerH - bottomPad) / 2
  const GAP = 8
  if (bubs.length === 1) {
    bubs[0].cx = cx0; bubs[0].cy = cy0
  } else if (bubs.length === 2) {
    // Pair: side by side, centered.
    const off = (halfWidthOf(bubs[0]) + halfWidthOf(bubs[1]) + GAP) / 2
    bubs[0].cx = cx0 - off; bubs[0].cy = cy0
    bubs[1].cx = cx0 + off; bubs[1].cy = cy0
  } else {
    // Triangle core: the first three bubbles sit at the vertices of a point-up
    // triangle (not hub-and-spoke, which read as a lopsided "V" for 3 bubbles);
    // any further bubbles spiral snugly around that core and the relaxation
    // below packs everything to touching.
    //
    // The seed radii are per-axis: the relaxation below only ever pushes boxes APART,
    // so a seed sized for circles (one radius on both axes) would leave the now-shorter
    // bubbles with a permanent vertical gap nothing pulls closed. Rtx makes the two base
    // vertices — a triangle side, Rt*sqrt(3) apart horizontally — just clear each other;
    // Rty makes the apex, 1.5*Rt above the base, just clear the row below it.
    const GA = Math.PI * (3 - Math.sqrt(5))
    const rCore = (bubs[0].r + bubs[1].r + bubs[2].r) / 3
    const Rtx = (2 * rCore * BUB_HW + GAP) / Math.sqrt(3)
    const Rty = (2 * rCore * BUB_HH + GAP + BUB_FLOAT_PAD) / 1.5
    for (let i = 0; i < 3; i++) {
      const ang = -Math.PI / 2 + i * (2 * Math.PI / 3)
      bubs[i].cx = cx0 + Math.cos(ang) * Rtx
      bubs[i].cy = cy0 + Math.sin(ang) * Rty
    }
    for (let i = 3; i < bubs.length; i++) {
      const ang = (i - 3) * GA
      const step = (rCore + bubs[i].r) * 0.5 + 4 * (i - 3)
      bubs[i].cx = cx0 + Math.cos(ang) * (Rtx + step * BUB_HW)
      bubs[i].cy = cy0 + Math.sin(ang) * (Rty + step * BUB_HH)
    }
    for (let iter = 0; iter < 120; iter++) {
      let any = false
      for (let i = 0; i < bubs.length; i++) {
        for (let j = i + 1; j < bubs.length; j++) {
          // -0.25 sub-pixel tolerance so float noise can't keep the loop "moving".
          if (separatePair(bubs[i], bubs[j], GAP - 0.25)) any = true
        }
      }
      // Keep the cluster centroid anchored on the page center as it relaxes.
      const mx = bubs.reduce((s, b) => s + b.cx, 0) / bubs.length
      const my = bubs.reduce((s, b) => s + b.cy, 0) / bubs.length
      bubs.forEach(b => { b.cx += cx0 - mx; b.cy += cy0 - my })
      if (!any) break
    }
  }

  // Shrink the formation to fit the page.
  //
  // These radii were chosen by computeLayout's fill-scaling, which measured them against
  // the PACKED SCATTER — a completely different arrangement from the centered formation
  // just built above. A scatter that happened to stack two bubbles vertically scales up
  // to fill the page's height, and then gets re-clustered side by side here, where the
  // same radii need far more width than the page has. Nothing downstream can undo that:
  // separateOverlaps just clamps both bubbles against opposite edges and ships the
  // overlap. So measure the formation we actually built, and scale the bubbles — radii
  // and offsets from the center together — until it fits.
  const usableW = width - EDGE_INSET * 2
  const usableH = (height - headerH - bottomPad) - EDGE_INSET * 2
  const bbW = Math.max(...bubs.map(b => b.cx + halfWidthOf(b))) - Math.min(...bubs.map(b => b.cx - halfWidthOf(b)))
  const bbH = Math.max(...bubs.map(b => b.cy + halfHeightOf(b))) - Math.min(...bubs.map(b => b.cy - halfHeightOf(b)))
  const fit = Math.min(1, usableW / (bbW || 1), usableH / (bbH || 1))
  if (fit < 1) {
    // Honour the minimum size: below it, bubbles pack tight and overlap rather than
    // shrink away to nothing (pagination is what rescues a genuinely overfull page).
    // The floor is note-size dependent — this shrink pass runs AFTER computeLayout has
    // already applied it, so using the bare MIN_BUB_R here would undo it and put a bubble
    // back below the note cards.
    const minR = minBubbleRFor(noteScale)
    const floored = Math.max(fit, Math.min(1, minR / Math.min(...bubs.map(b => b.r))))
    for (const b of bubs) {
      b.r *= floored
      b.cx = cx0 + (b.cx - cx0) * floored
      b.cy = cy0 + (b.cy - cy0) * floored
    }
  }

  // Seed notes OUTSIDE the cluster ellipse so none start in the pockets between
  // bubbles (lloydSpread and the pinned separation then keep them out).
  const e = clusterEllipse(bubs)
  pos.forEach((p, i) => {
    if (p.type !== 'note') return
    // Nudge a dead-center note off the ellipse center so the projection has a bearing.
    if (Math.hypot(p.cx - e.ex, p.cy - e.ey) < 1) { p.cx = e.ex + 1 + (i % 3); p.cy = e.ey + 1 }
    projectOutOfEllipse(p, e, p.r * NOTE_HW + 3, p.r * NOTE_HH + 3)
  })
  return pos
}

// ── Arrange notes around loaded bubbles ───────────────────────────────────────
// For a mixed page whose bubble locations came from SAVED positions: the fresh layout
// arranged notes around the centered formation, but the saved overrides may have put
// the bubbles somewhere else entirely — so re-flow the un-anchored notes around the
// bubbles' ACTUAL positions (eject from the real cluster ellipse → Lloyd around pinned
// bubbles and pinned saved-notes → pinned separation). Notes the user placed manually
// are never moved by Lloyd and are exempt from the ellipse ejection.
// Returns null when the flow doesn't apply (no bubbles, or no free notes to arrange).
function arrangeNotesAroundBubbles(items, anchoredIds, width, height) {
  const bubs = items.filter(p => p.type !== 'note')
  const freeNotes = items.filter(p => p.type === 'note' && !anchoredIds.has(p.id))
  if (bubs.length === 0 || freeNotes.length === 0) return null
  const freeIds = new Set(freeNotes.map(p => p.id))
  const e = clusterEllipse(bubs)
  const seeded = items.map((p, i) => {
    if (!freeIds.has(p.id)) return p
    const q = { ...p }
    if (Math.hypot(q.cx - e.ex, q.cy - e.ey) < 1) { q.cx = e.ex + 1 + (i % 3); q.cy = e.ey + 1 }
    projectOutOfEllipse(q, e, q.r * NOTE_HW + 3, q.r * NOTE_HH + 3)
    return q
  })
  const pinnedNotes = new Set(
    items.filter(p => p.type === 'note' && anchoredIds.has(p.id)).map(p => p.id)
  )
  return separateOverlaps(
    lloydSpread(seeded, width, height, SUB_BAR_H, BOTTOM_PAD, pinnedNotes),
    width, height, true, freeIds,
  )
}

// ── Note grid geometry ────────────────────────────────────────────────────────
// Single source of truth for the even-spread grid's frame, shared by the layout path
// and the capacity estimate so the two can never drift apart.
//
// resX/resY is the jitter amplitude the margins hold back. It used to be pinned at the
// MAXIMUM amplitude (12/10) unconditionally, but the jitter actually applied is derived
// from whatever pitch is left over (see jitterFor) — so a densely packed page jitters by
// ~0 while still paying 24px of width and 20px of height for jitter it never uses. That
// cost a whole row or column outright at the larger note sizes, where the boxes are big
// enough that one row is a big fraction of the page. The reserve is now solved for.
const NOTE_MARGIN_X = 14, NOTE_MARGIN_Y = 10
// Jitter ceiling, as a fraction of the card's OWN box rather than a flat pixel count.
// A flat 12/10px was a third of a small card's width and barely a tenth of a large
// one's, so the wobble that read as hand-placed at the small size all but vanished as
// the cards grew — exactly where the grid is most visible, because there are fewer,
// bigger cards per row. Tied to the box, the offset stays proportionally the same.
const NOTE_JITTER_FRAC = 0.34
const noteJitterCap = (f) => ({ x: f.BOX_W * NOTE_JITTER_FRAC, y: f.BOX_H * NOTE_JITTER_FRAC })

export function noteGridFrame(width, height, headerH, bottomPad, noteR, resX, resY) {
  const BOX_W = noteR * 2 * NOTE_HW, BOX_H = noteR * 2 * NOTE_HH
  const mX = NOTE_MARGIN_X + resX + BOX_W / 2
  const mT = headerH + NOTE_MARGIN_Y + resY + BOX_H / 2
  const mB = NOTE_MARGIN_Y + resY + BOX_H / 2
  return {
    BOX_W, BOX_H, mX, mT,
    spanW: width - mX * 2,
    spanH: (height - bottomPad) - mT - mB,
  }
}

// Jitter amplitude for a chosen pitch: whatever slack is left over once the minimum gap
// is honoured, capped. A grid at its densest legal pitch yields 0 on both axes.
//
// Halving the leftover is what makes the offset safe without a collision check: two
// neighbours can each wobble this far TOWARD each other and still be exactly the minimum
// gap apart, so no arrangement of offsets can overlap.
export const jitterFor = (f, cols, rows, pitchX, pitchY) => {
  const cap = noteJitterCap(f)
  return {
    jx: Math.min(Math.max(((cols > 1 ? pitchX - f.BOX_W : f.spanW) - NOTE_GAP_X) / 2, 0), cap.x),
    jy: Math.min(Math.max(((rows > 1 ? pitchY - f.BOX_H : f.spanH) - NOTE_GAP_Y) / 2, 0), cap.y),
  }
}

// The inverse of noteRowXMax: the lowest a note card centred at `cx` may sit and still
// keep its box clear of the + button. Infinity when the card is far enough left that the
// button never reaches it. Same circle, same padding — solved for y instead of x.
function noteCyMaxAt(cx, width, height, noteR) {
  const hw = noteR * NOTE_HW, hh = noteR * NOTE_HH
  const btnCx = width - 52, btnCy = height - 52
  const need = PLUS_BTN_EXCL_R + BTN_ROW_PAD
  const hGap = Math.max(0, btnCx - (cx + hw))
  if (hGap >= need) return Infinity
  return btnCy - hh - Math.sqrt(need * need - hGap * hGap)
}

// The usable span of ONE row of cells: the frame's own spanW, cut back only where the
// + button bites into this row. Every consumer — the capacity count, the placement, the
// pitch — measures the row through this, so there is exactly one usable width in play.
export function noteRowSpan(f, cy, width, height) {
  const xMax = noteRowXMax(cy, width, height, f.BOX_W / 2, f.BOX_H / 2)
  return Math.min(f.spanW, xMax - f.mX)
}

// Per-row usable right edge: rows level with the + button stop short of its exclusion zone.
const noteRowXMaxAt = (f, cy, width, height) => f.mX + noteRowSpan(f, cy, width, height)

// How many cells a row can hold at a given pitch, given the + button's bite.
//
// The span has to come from the frame (noteRowSpan above) rather than be re-derived by
// subtracting the margins a second time. This used to compute `(width - mX) - mX` while
// the pitch it divides by came from the frame's `width - mX * 2` — the same quantity by
// algebra, but not bit-for-bit, and the frame's was the LARGER of the two. A grid whose
// columns fit the row exactly then divided out to 1.9999999999999998 instead of 2, floored
// to 1, and the row was reported one cell short. Every row, on every page: with three
// columns spanning a phone at the large note size, a third of the page was thrown away,
// and the solver fell back to two-column grids that visibly wasted the right margin.
// The epsilon is the other half of the same point — an exact fit must count as fitting.
const CELL_EPS = 1e-6

// How many cells of size `box` fit across `span` at the minimum `gap`. The span measures
// CENTER to CENTER (the frame already reserves half a box at each end), so n cells need
// n-1 pitches. Same epsilon, same reason: an exact fit counts.
const cellsAcross = (span, box, gap) =>
  Math.max(1, Math.floor(span / (box + gap) + CELL_EPS) + 1)

function noteRowCap(f, cy, pitchX, width, height) {
  const rs = noteRowSpan(f, cy, width, height)
  if (rs < 0) return 0
  return Math.floor(rs / Math.max(pitchX, f.BOX_W + NOTE_GAP_X) + CELL_EPS) + 1
}

// Gap ceiling: a few notes shouldn't be flung to the page corners — beyond this, extra
// space stays as page margin around a centered cluster instead of gap.
const GAP_X_MAX = 48, GAP_Y_MAX = 44

// Choose the col/row split for n notes: the one whose (capped) leftover gaps are closest
// to equal on both axes, biased toward the page's aspect so sparse clusters take a fitting
// shape, honouring the per-axis minimum gaps and the button-reduced row capacities.
// Everything is evaluated at the CAPPED pitch — that's what actually gets placed.
export function solveNoteGrid(n, width, height, headerH, bottomPad, noteR, resX, resY) {
  const f = noteGridFrame(width, height, headerH, bottomPad, noteR, resX, resY)
  const { BOX_W, BOX_H, mT, spanW, spanH } = f
  let best = null
  for (let cols = 1; cols <= n; cols++) {
    for (let rows = Math.ceil(n / cols); rows <= Math.ceil(n / cols) + 2; rows++) {
      const pitchX = cols > 1 ? Math.min(spanW / (cols - 1), BOX_W + GAP_X_MAX) : 0
      const pitchY = rows > 1 ? Math.min(spanH / (rows - 1), BOX_H + GAP_Y_MAX) : 0
      const gapX = cols > 1 ? spanW / (cols - 1) - BOX_W : Infinity
      const gapY = rows > 1 ? spanH / (rows - 1) - BOX_H : Infinity
      if (cols > 1 && gapX < NOTE_GAP_X) break // fewer cols only → gapX won't recover
      if (rows > 1 && gapY < NOTE_GAP_Y) continue
      const mTc = rows > 1 ? mT + (spanH - (rows - 1) * pitchY) / 2 : mT
      let capTotal = 0
      for (let r = 0; r < rows; r++) {
        const cy = rows > 1 ? mTc + r * pitchY : mT + spanH / 2
        capTotal += Math.min(cols, noteRowCap(f, cy, pitchX, width, height))
      }
      if (capTotal < n) continue
      const fx = Math.min(isFinite(gapX) ? gapX : spanW, GAP_X_MAX)
      const fy = Math.min(isFinite(gapY) ? gapY : spanH, GAP_Y_MAX)
      const idealR = Math.sqrt(spanW * (BOX_H + GAP_Y_MAX) / (spanH * (BOX_W + GAP_X_MAX)))
      const score = Math.abs(fx - fy) + 30 * Math.abs(Math.log((cols / rows) / idealR))
      if (!best || score < best.score) best = { cols, rows, pitchX, pitchY, score }
      break // loosest fitting rows found for this cols; more rows only tightens Y
    }
  }
  if (!best) {
    // Over this frame's capacity: densest legal grid; the caller's separation passes
    // resolve whatever overlap the surplus items cause. `fits: false` tells the caller
    // the frame couldn't hold n, so it can back off to a roomier one rather than ship
    // notes stacked on top of each other.
    const cols = cellsAcross(spanW, BOX_W, NOTE_GAP_X)
    const rows = Math.ceil(n / cols)
    return {
      f, cols, rows, fits: false,
      pitchX: spanW / Math.max(cols - 1, 1),
      pitchY: spanH / Math.max(rows - 1, 1),
    }
  }
  return { f, ...best, fits: true }
}

// True notes-per-page capacity: the largest n the solver can actually place at a zero
// jitter reserve — the densest legal frame, and the one a full page converges on.
//
// This used to re-derive the count from the geometry (densest cols × rows, summed per row
// with the + button's losses). That was a second implementation of the solver's own fit
// rules, and the two disagreed on some viewports: capacity came out a few notes above
// anything the solver would accept, pagination handed a page that many notes, the solver
// found no legal grid, and the surplus landed in the corner stack. Asking the solver
// directly is slower — a handful of solves per layout — but it cannot drift.
export function noteGridCapacity(width, height, headerH, bottomPad, noteScale = 1) {
  const noteR = noteRFor(noteScale)
  const f = noteGridFrame(width, height, headerH, bottomPad, noteR, 0, 0)
  const cols = cellsAcross(f.spanW, f.BOX_W, NOTE_GAP_X)
  const rows = cellsAcross(f.spanH, f.BOX_H, NOTE_GAP_Y)
  const fits = (n) => solveNoteGrid(n, width, height, headerH, bottomPad, noteR, 0, 0).fits
  // The grid can never hold more than its own cells, so that bounds the search.
  let lo = 1, hi = Math.max(1, cols * rows)
  if (fits(hi)) return hi
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return Math.max(1, lo)
}

// ── Page capacity ─────────────────────────────────────────────────────────────
//
// Pages are deliberately NOT filled to their theoretical maximum. Both layout paths
// degenerate at 100% fill:
//
//   • Notes: jitterFor() returns the leftover pitch above the minimum gap, so a page at
//     noteGridCapacity() has almost none to spend. Measured across common viewports it
//     collapses to 0.2–2px on at least one axis (iPad small 0.4/1.7, Pixel 7 medium
//     7.8/0.2, desktop large 0.3/4.4) — sub-pixel wobble on one axis is what makes the
//     page read as exact rows or columns. At PAGE_FILL the same viewports get several
//     px on BOTH axes (8.9/6.3, 7.8/10.0, 11.9/10.0).
//   • Bubbles: the golden-angle scatter and the separation passes have nothing left to
//     push into, so items pin against the bounds clamp and settle into tight rows.
//
// Holding a page to a fraction of its maximum keeps the pitch above its minimum, which
// is what leaves jitter and the organic scatter room to work. The cost is more pages
// with fewer items each — the intended trade. Items are never shrunk to fit more in;
// the floors (noteRFor / minBubbleRFor) are untouched by any of this.
export const PAGE_FILL = 0.72

// How many pages a given mix of bubbles and notes needs, and the blended per-page count.
// Capacity comes from each type's REAL footprint, not a one-size bubble grid: notes render
// as small rectangles (W = r*1.55 ≈ 62px, H = r*1.15 ≈ 46px) packed ~5px apart, so counting
// them as 98px bubble cells paginated note pages long before they were visually full.
// pageLoad > 1 means the mix doesn't fit one screen; perPage is the count assignPages
// splits on (it is count-based, so the two capacities blend into one number).
export function pageLoadFor(bubbleN, noteN, width, height, noteScale) {
  if (width <= 0) return { pageLoad: 0, perPage: 1 }
  const pageAvailH = height - SUB_BAR_H - BOTTOM_PAD
  // The cell is the bubble FLOOR, and it has to be.
  //
  // Sizing it to the biggest bubble a page can hold sounds more honest and is badly
  // wrong, because a bubble has no fixed size: computeLayout scales the whole cluster to
  // the page, so the same set of bubbles renders at r 118–298px when three share a page
  // and r 40–61px when twenty-four do. The biggest bubble is only big when there are few
  // of them — precisely the case where capacity doesn't bind. A full page converges on
  // the floor, which is what this measures. (Cell = maxR was tried: iPad capacity fell
  // from 101 bubbles to 7, paginating pages that render fine as one.)
  //
  // The floor rises with the note-size preference (see minBubbleRFor), so the cell rises
  // with it too — otherwise larger note sizes would be told more bubbles fit than the
  // packer can place, and pages would overfill instead of paginating.
  const bubR = minBubbleRFor(noteScale)
  const bubD = bubR * 2
  // The packer keeps item centers a half-extent + EDGE_INSET inside each edge (see
  // clampToBounds), so the usable band is the screen minus that inset on both sides.
  // Bubbles are wide rectangles, so the horizontal and vertical insets differ.
  const usablePageW = Math.max(width - 2 * (bubR * BUB_HW + EDGE_INSET), 1)
  const usablePageH = Math.max(pageAvailH - 2 * (bubR * BUB_HH + EDGE_INSET), 1)
  // Notes: the even-spread grid's true capacity (densest legal pitch incl. float-bob
  // clearance, minus the cells lost to the + button), held back to PAGE_FILL so the
  // solver always lands on a looser pitch than the densest one and jitterFor has slack
  // to spend. Filling to rawNotesPerPage is precisely the zero-jitter case.
  const rawNotesPerPage = noteGridCapacity(width, height, SUB_BAR_H, BOTTOM_PAD, noteScale)
  const notesPerPage = Math.max(1, Math.floor(rawNotesPerPage * PAGE_FILL))
  // Reported for the capacity log: the one usable width every note count is derived from
  // (centre-to-centre, i.e. the page minus the header, the edge margin and half a card at
  // each end), and how many cards fit across it as pure arithmetic. If the placement ever
  // puts fewer than noteCols in a full row again, these two numbers show it immediately.
  const noteFrame = noteGridFrame(width, height, SUB_BAR_H, BOTTOM_PAD, noteRFor(noteScale), 0, 0)
  const usableW = noteFrame.spanW
  const noteCols = cellsAcross(usableW, noteFrame.BOX_W, NOTE_GAP_X)
  const noteRows = cellsAcross(noteFrame.spanH, noteFrame.BOX_H, NOTE_GAP_Y)
  // Bubbles are wide rounded rectangles, and the packer separates them by that box — so at
  // the crowded gap they settle into a roughly RECTANGULAR arrangement, not the hexagonal
  // circle packing this used to model. Estimate from the cell area of the region the packer
  // can place centers in, bounded by the row/column count so narrow pages stay sane.
  // Pagination only triggers on a crowded page, where the packer uses its tightest gap.
  const gap = bubPackGap(Infinity)
  const cellW = bubD * BUB_HW + gap
  const cellH = bubD * BUB_HH + gap + BUB_FLOAT_PAD
  const rawBubblesPerPage = Math.max(1, Math.floor(Math.min(
    (usablePageW * usablePageH) / (cellW * cellH),
    (Math.floor(usablePageW / cellW) + 1) * (Math.floor(usablePageH / cellH) + 1),
  )))
  // PAGE_FILL also subsumes the 20% derate this used to carry for the size variation of
  // content-scaled bubbles (the cell is sized for the minimum bubble, and only the
  // smallest are actually that size) — 0.72 is the stricter of the two.
  const bubblesPerPage = Math.max(1, Math.floor(rawBubblesPerPage * PAGE_FILL))
  const pageLoad = noteN / notesPerPage + bubbleN / bubblesPerPage
  return {
    pageLoad,
    perPage: Math.max(1, Math.floor((bubbleN + noteN) / Math.max(pageLoad, 0.001))),
    notesPerPage,
    bubblesPerPage,
    rawNotesPerPage,
    rawBubblesPerPage,
    usableW,
    noteCols,
    noteRows,
  }
}

// How wrong a finished layout is, in pixels: how deeply every pair penetrates, plus how
// far anything hangs off the page. Both are the same unit, so they add. Zero means the
// layout is clean — nothing overlapping, nothing off-screen — which is the only thing the
// caller below actually tests for.
const LAYOUT_PENALTY_EPS = 0.5 // sub-pixel float noise is not an overlap
function layoutPenalty(laid, width, height, headerH, bottomPad) {
  let s = 0
  const btn = { cx: width - 52, cy: height - 52, r: PLUS_BTN_EXCL_R }
  for (let i = 0; i < laid.length; i++) {
    const p = laid[i]
    const hw = halfWidthOf(p), hh = halfHeightOf(p)
    s += Math.max(0, hw - p.cx) + Math.max(0, p.cx - (width - hw))
      + Math.max(0, headerH + hh - p.cy) + Math.max(0, p.cy - (height - bottomPad - hh))
    // The + button is as much an obstacle as another item — a candidate that only looks
    // clean because it parked a bubble under the button is not clean.
    s += circleBoxPen(btn, p, BTN_ROW_PAD)
    for (let j = i + 1; j < laid.length; j++) {
      const b = laid[j]
      const ox = hw + halfWidthOf(b) - Math.abs(b.cx - p.cx)
      const oy = hh + halfHeightOf(b) - Math.abs(b.cy - p.cy)
      if (ox > 0 && oy > 0) s += Math.min(ox, oy)
    }
  }
  return s
}

export function computeLayout(items, width, height, headerH = 56, bottomPad = 0, noteScale = 1, seed = 0) {
  const n = items.length
  if (n === 0) return []

  // availH excludes the header and the bottom clearance needed for the + button
  const availH = height - headerH - bottomPad
  const cx0 = width / 2
  // Center the cluster in the usable band between header and bottom clearance
  const cy0 = headerH + availH / 2
  const base = Math.min(width, availH) * 0.4

  // Note cards render at a user-chosen size: the base radius scaled by the note-size
  // preference (small = 1×). Only notes scale; category bubbles stay content-sized — but
  // the bubble floor tracks the note size so a sparse bubble never renders smaller than
  // the note cards around it (see minBubbleRFor).
  const NOTE_R = noteRFor(noteScale)
  const MIN_R = minBubbleRFor(noteScale)
  // No bubble may be bigger than the page it lives on, whatever the fill-scaling below
  // computes — see maxFittingBubbleR.
  const MAX_R = maxFittingBubbleR(width, availH)

  if (n === 1) {
    const r = items[0].type === 'note'
      ? NOTE_R
      : Math.min(Math.max(Math.min(width, availH) * 0.27, MIN_R), MAX_R)
    return [{ ...items[0], cx: cx0, cy: cy0, r }]
  }

  // ── Even-spread path for notes-only pages ─────────────────────────────────────
  // Fixed-size cards can't fill a page through packing + scaling: the gap constants are
  // only minimums, and the fit-scale stretched gaps unevenly (some pairs at 5px, others
  // 60px+, plus dead zones). Instead, distribute notes on an even pitch spanning the
  // whole usable page — equal gaps by construction — then add bounded deterministic
  // jitter for the organic feel. Jitter can never violate the per-axis minimum gaps
  // (float-bob clearance included). Pages containing bubbles keep the organic scatter
  // below (bubbles scale up to fill, so they don't have this problem).
  if (items.every(i => i.type === 'note')) {
    // Solve the grid twice. The first pass holds back no jitter room and measures the
    // jitter its pitch would actually produce; the second holds back exactly that much.
    // A full page converges on a zero reserve — which is the grid noteGridCapacity
    // measures, so the two agree exactly where it matters — while a sparse page still
    // reserves room for the wobble it will actually use.
    const probe = solveNoteGrid(n, width, height, headerH, bottomPad, NOTE_R, 0, 0)
    const probeJ = jitterFor(probe.f, probe.cols, probe.rows, probe.pitchX, probe.pitchY)
    const reserved = solveNoteGrid(n, width, height, headerH, bottomPad, NOTE_R, probeJ.jx, probeJ.jy)
    // The probe can pick a loose split whose jitter, once reserved, leaves too little room
    // for n — a full desktop page of large notes did exactly that and dumped the surplus
    // in a stack. Only adopt the reserved frame if it still holds every note; otherwise
    // keep the roomier zero-reserve frame, which by definition has no jitter to reserve.
    const useReserved = reserved.fits
    const { f, cols, rows, pitchX, pitchY } = useReserved ? reserved : probe
    const reserve = useReserved ? probeJ : { jx: 0, jy: 0 }
    const { mX, mT, spanH } = f
    // Rows near the + button stop short of it: cells are never placed inside its
    // exclusion zone (shoving them out after placement broke the float clearance).
    const xMaxAt = (cy) => noteRowXMaxAt(f, cy, width, height)
    const rowCapAt = (cy, px) => noteRowCap(f, cy, px, width, height)
    // Pitches are already gap-capped by the search; center the block vertically so
    // sparse pages read as a loose cluster, not a corner-to-corner stretch.
    const mT2 = rows > 1 ? mT + (spanH - (rows - 1) * pitchY) / 2 : mT
    // The applied jitter can never exceed what the frame held back: the margins are
    // NOTE_MARGIN + reserve, so `reserve` IS the room an edge cell has to wobble into.
    // Don't assume the second pass wants less than the first — the col/row search is
    // discrete, so a larger reserve can flip it to a looser split that wants MORE jitter
    // (an iPhone SE page of large notes does exactly this). Clamping is what makes the
    // margin a guarantee rather than an argument about monotonicity.
    const fit = jitterFor(f, cols, rows, pitchX, pitchY)
    const jx = Math.min(fit.jx, reserve.jx)
    const jy = Math.min(fit.jy, reserve.jy)
    // Allot items per row: fill each row to ITS capacity from the top, so the only
    // short rows are at the bottom (where the + button eats cells). The old
    // "spread the remainder evenly" rule dented full pages mid-grid (5,5,5,5,4,4,5,4,3
    // instead of solid fives), because even-spread and the capacity clamp fought.
    const rowCaps = Array.from({ length: rows }, (_, r) => {
      const cy = rows > 1 ? mT2 + r * pitchY : mT + spanH / 2
      return Math.min(cols, rowCapAt(cy, pitchX))
    })
    const rowKs = []
    {
      let remaining = n
      for (let r = 0; r < rows && remaining > 0; r++) {
        const k = Math.min(rowCaps[r], remaining)
        rowKs.push(k)
        remaining -= k
      }
      // Balance the last two used rows so a tiny remainder doesn't leave a lone note
      // (e.g. ...,4,1 becomes ...,3,2) — the bottom still holds the only short rows.
      if (rowKs.length >= 2) {
        const li = rowKs.length - 1
        const t = rowKs[li - 1] + rowKs[li]
        if (rowKs[li] < rowCaps[li] && rowKs[li] < rowKs[li - 1] - 1) {
          rowKs[li - 1] = Math.min(rowCaps[li - 1], Math.ceil(t / 2))
          rowKs[li] = t - rowKs[li - 1]
          if (rowKs[li] > rowCaps[li]) {
            // Button-shortened last row can't take the even split; give the excess back.
            rowKs[li - 1] += rowKs[li] - rowCaps[li]
            rowKs[li] = rowCaps[li]
          }
        }
      }
    }
    const slots = []
    let placed = 0
    for (let r = 0; r < rowKs.length; r++) {
      const cy = rows > 1 ? mT2 + r * pitchY : mT + spanH / 2
      const k = rowKs[r]
      if (k <= 0) continue
      const rowSpan = xMaxAt(cy) - mX
      const pitch = k > 1 ? Math.min(pitchX, rowSpan / (k - 1)) : 0
      // Slack is the room the row's block of cells does NOT use. Centering it wastes
      // that room identically on every row, which is half of why the grid reads as a
      // grid — the columns line up perfectly all the way down. Sliding each row to its
      // own hashed offset within its own slack breaks the columns outright, and cannot
      // overlap anything: the block stays inside the row, and rows never touch (they
      // are a full pitchY apart). A row packed to capacity has no slack and doesn't move.
      const slack = k > 1 ? rowSpan - (k - 1) * pitch : 0
      // The row's OWN pitch, not the frame's, bounds how far its cells may wobble: a
      // button-shortened row packs tighter than pitchX, and spending the frame's larger
      // budget there would close the gap past its minimum.
      const jxRow = k > 1
        ? Math.min(jx, Math.max((pitch - f.BOX_W - NOTE_GAP_X) / 2, 0))
        : jx
      // The slide has to leave the end cards room for their own wobble on top of it,
      // or the two together walk the last card past the end of the row — and the end of
      // a bottom row is the + button's exclusion zone, not just empty margin.
      const phase = hash2(r + 1, seed) * Math.max(slack / 2 - jxRow, 0)
      const x0 = k > 1 ? mX + slack / 2 + phase : mX + rowSpan / 2
      for (let c = 0; c < k && placed < n; c++) {
        slots.push({ x: k > 1 ? x0 + c * pitch : x0, y: cy, jx: jxRow })
        placed++
      }
    }
    // True over-capacity leftovers (pagination normally prevents this): drop in and
    // let the caller's separation passes sort them out.
    while (placed < n) {
      slots.push({ x: mX + (placed % 3) * (f.BOX_W + NOTE_GAP_X), y: mT + spanH / 2, jx: 0 })
      placed++
    }
    // Cells are built row-major (top-left → bottom-right), but new notes are APPENDED
    // to the project — in item order the newest note always drew the bottom-right cell,
    // right beside the + button, so every fresh note "spawned" at the button. Assign
    // cells in reverse: the newest note takes the top-left cell (newest-first reading
    // order) and the button-adjacent cell goes to the oldest, stably placed note.
    return items.map((item, i) => {
      const s = slots[slots.length - 1 - i] ?? slots[slots.length - 1]
      // Per-item wobble on top of the row's offset. Seeded per page, and the two axes
      // are hashed from different inputs so a card's horizontal and vertical offsets
      // don't move together (sin(i·127.1) and sin(i·311.7) drift into step over a long
      // page, which put diagonal streaks through the wobble).
      const hx = hash2(i, seed), hy = hash2(i + 4093, seed + 7)
      const cx = s.x + hx * s.jx
      // A row's usable width was measured at the row's OWN cy. Wobbling a card downward
      // moves it to a cy where the + button's exclusion circle reaches further left, so
      // the bottom-right card could wobble into a zone its row had already cleared.
      // Cap how far down this card may go, given where it ended up horizontally. The
      // unjittered cell is always clear (that is what rowSpan guarantees), so the cap
      // never pulls a card above its own jitter band and into the row overhead.
      return {
        ...item,
        cx,
        cy: Math.min(s.y + hy * jy, noteCyMaxAt(cx, width, height, NOTE_R)),
        r: NOTE_R,
      }
    })
  }

  const bubbleItems = items.filter(i => i.type !== 'note')
  // Log-scale bubble sizes by total nested content (notes + descendant bubbles),
  // relative to the busiest bubble in this view.
  const maxContent = Math.max(...bubbleItems.map(i => i.contentCount || 0), 1)
  const { minR, maxR } = bubbleRRange(width, availH, noteScale)
  // Note cards are the user-chosen size (independent of content) — only category
  // bubbles scale by content.
  const noteR = NOTE_R

  const radii = items.map(item => {
    if (item.type === 'note') return noteR
    const content = item.contentCount || 0
    const t = Math.log(content + 1) / Math.log(maxContent + 1)
    return minR + (maxR - minR) * t
  })

  // Tighter box-packing when crowded: shrink the inter-bubble gap as the
  // count grows so many bubbles pack closer together.
  const packGap = bubPackGap(n)
  // Notes use the fixed per-axis gaps (NOTE_GAP_X / NOTE_GAP_Y), independent of the
  // category-bubble spacing above.

  const GA = Math.PI * (3 - Math.sqrt(5))
  // Elliptical scatter: bias the golden-angle spiral toward the page's aspect ratio so the
  // cluster fills a tall (or wide) page instead of packing into a circle in the narrow
  // dimension — a round blob in a tall rectangle is what left big empty "pockets" along the
  // long edges. Dampened (^0.8) so it leans toward the aspect without fully matching it.
  const aspect = availH / width
  const ell = Math.pow(aspect, 0.8)
  const ellX = ell < 1 ? 1 / ell : 1
  const ellY = ell > 1 ? ell : 1
  // The seed is squashed vertically by the bubble aspect as well: every pass below only
  // pushes boxes APART, so a seed spread for round items would leave the now-shorter
  // bubbles with vertical dead air that nothing pulls closed.
  //
  // The golden angle on its own is too even to look scattered: it is the step that
  // distributes points as UNIFORMLY as possible, which is precisely the regularity that
  // survives the relaxation below and reads as rows and columns. Three things break it,
  // all scaled by `wobble` so the whole scatter can be re-run tamer (see below):
  //   • startAngle — a per-page phase, so pages of the same level don't repeat one
  //     silhouette (the spiral is otherwise identical wherever it is drawn).
  //   • the angular wobble — up to ±0.5 rad on each step, enough to visibly disturb the
  //     arms without collapsing the even area coverage the spiral is there to provide.
  //   • the radial wobble — a fraction of THIS item's own size rather than a pixel
  //     count, so it stays proportionally the same as the note size grows.
  //
  // None of it applies to a BUBBLE-ONLY page. A page holding notes hands its bubbles to
  // recenterBubbles, which throws this scatter away and re-seeds them as a tight centred
  // cluster, so the wobble there only ever reaches the notes — and lloydSpread tidies
  // those. A bubble-only page returns the scatter as its final layout, making it the one
  // place a wobbled spiral survives to the screen: bubbles landed at odd spacings and
  // odd angles while the very same bubbles packed neatly the moment a note joined them.
  // Bubbles pack one way everywhere; the variation stays on the items that get tidied.
  const hasNotes = items.some(i => i.type === 'note')
  const ANGLE_WOBBLE = 0.5    // radians, ±
  const RADIAL_WOBBLE = 0.45  // ± this fraction of the item's own size scalar
  const scatterSeed = (amount) => items.map((item, i) => {
    const wobble = hasNotes ? amount : 0
    const angle = i * GA
      + hash2(seed, 17) * Math.PI * wobble
      + hash2(i, seed) * ANGLE_WOBBLE * wobble
    const dist = base * 0.46 * Math.sqrt(i / (n - 1 || 1))
      + radii[i] * RADIAL_WOBBLE * wobble * hash2(i + 4093, seed + 7)
    return {
      ...item,
      x: dist * Math.cos(angle) * ellX,
      y: dist * Math.sin(angle) * ellY * (BUB_HH / BUB_HW),
      r: radii[i],
    }
  })

  const scatter = (wobble) => {
  let pos = scatterSeed(wobble)

  // Pack in layout space. Every pair separates by its rendered box: notes as their card
  // (W = r*1.55, H = r*1.15), bubbles as theirs (W = r*2, H = r*1.33). Packing bubbles by
  // a bounding circle instead would leave their corners overlapping on the diagonals.
  for (let iter = 0; iter < 240; iter++) {
    let any = false
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j]
        if (separateBoxPair(
          b.x - a.x, b.y - a.y,
          halfWidthOf(a), halfHeightOf(a), halfWidthOf(b), halfHeightOf(b),
          pairGapX(a, b, packGap), pairGapY(a, b, packGap),
          (p) => { a.x -= p; b.x += p }, (p) => { a.y -= p; b.y += p },
        )) any = true
      }
    }
    if (!any) break
  }

  // Tighter margin around the cluster when crowded so it can scale up to fill more.
  const pad = n > 10 ? 16 : 28
  const xs = pos.flatMap(p => [p.x - halfWidthOf(p), p.x + halfWidthOf(p)])
  const ys = pos.flatMap(p => [p.y - halfHeightOf(p), p.y + halfHeightOf(p)])
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const bw = maxX - minX || 1, bh = maxY - minY || 1
  // Fill each axis independently (anisotropic) so the cluster expands to the page in BOTH
  // dimensions, instead of a single uniform scale limited by whichever axis is tightest —
  // that under-filled the long axis and left the cluster clumped in the middle. Capped so a
  // sparse page eases items apart without flinging them to the far corners.
  const FILL_CAP = 2.4
  const scaleX = Math.min((width - pad * 2) / bw, FILL_CAP)
  const scaleY = Math.min((availH - pad * 2) / bh, FILL_CAP)
  const lcx = (minX + maxX) / 2, lcy = (minY + maxY) / 2

  const result = pos.map(p => ({
    ...p,
    cx: cx0 + (p.x - lcx) * scaleX,
    cy: cy0 + (p.y - lcy) * scaleY,
    // Notes are always fixed at the minimum size (never scaled). Category bubbles keep the
    // minimum ON SCREEN — scaled by the smaller axis factor so their box keeps its aspect
    // ratio (never stretched), never shrinking below MIN_R nor growing past what fits.
    r: p.type === 'note'
      ? NOTE_R
      : Math.min(Math.max(p.r * Math.min(scaleX, scaleY), MIN_R), MAX_R),
  }))

  // Flooring the radius can re-introduce overlaps; relax in screen space with a
  // tight gap, clamping every item fully on-screen each pass so nothing ends up
  // off the viewport. (When bubbles can't all fit at the minimum size they will
  // pack tightly / overlap rather than shrink below it.)
  const clampXY = (p) => {
    const hw = halfWidthOf(p), hh = halfHeightOf(p)
    p.cx = Math.max(hw + 8, Math.min(width - hw - 8, p.cx))
    p.cy = Math.max(headerH + hh + 8, Math.min(height - bottomPad - hh, p.cy))
  }
  const tightGap = Math.min(packGap, 5)
  for (let iter = 0; iter < 160; iter++) {
    let any = false
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        if (separatePair(result[i], result[j], tightGap)) any = true
      }
    }
    result.forEach(clampXY)
    if (!any) break
  }

  // Keep every bubble fully clear of the + button (full-circle barrier, all sides).
  result.forEach(item => keepClearOfPlusButton(item, width, height, headerH, height - bottomPad))

  // Mixed pages (bubbles + notes): cluster the bubbles compactly at the page center,
  // then spread the NOTES around them (lloydSpread pins bubbles), and finish with the
  // pinned separation so notes yield to the anchored bubble cluster.
  if (items.some(i => i.type === 'note')) {
    return separateOverlaps(
      lloydSpread(recenterBubbles(result, width, height, headerH, bottomPad, noteScale), width, height, headerH, bottomPad),
      width, height, true,
    )
  }

  // Bubble-only page: same even coverage the notes get, applied to the bubbles.
  //
  // The packing above only pushes overlapping boxes apart and then scales the whole
  // cluster to the page — nothing inside it distributes anything, so the result kept the
  // spiral's shape: dense in the middle, thinning toward the edges, corners empty. Lloyd
  // is what the mixed path already uses to spread notes evenly, and it handles the
  // bubbles' varying sizes natively (bigger items claim more area).
  //
  // But Lloyd moves each item to its region's centroid without regard for boxes, and a
  // bubble's box is large and irregular where a note's is small and uniform, so on a
  // crowded page it can drive two big bubbles together harder than the separation pass
  // can pull them apart. So the spread is a candidate, not a conclusion: both are scored
  // after the same cleanup and the more even one only wins if it is no more overlapped.
  // Lloyd steers centroids away from the button but knows nothing about the boxes around
  // them, so it undoes the barrier applied above — re-apply it to the spread candidate
  // before the separation pass, exactly as the packed one already had it.
  const spreadPos = lloydSpread(result, width, height, headerH, bottomPad)
  spreadPos.forEach(item => keepClearOfPlusButton(item, width, height, headerH, height - bottomPad))
  const packed = separateOverlaps(result, width, height, false)
  const spread = separateOverlaps(spreadPos, width, height, false)
  return layoutPenalty(spread, width, height, headerH, bottomPad)
    <= layoutPenalty(packed, width, height, headerH, bottomPad) + LAYOUT_PENALTY_EPS
    ? spread
    : packed
  }

  // Take the most varied scatter that costs nothing.
  //
  // The relaxation inside scatter() separates every pair, but the anisotropic fill-scale
  // that follows it stretches the two axes by DIFFERENT factors, which can put boxes back
  // into each other; the screen-space passes then clean up what they can. On a crowded
  // mixed page they can't always, and which pages come out overlapped turns out to depend
  // on the seed — measured over ~4000 synthetic pages, wobbling the spiral moved the
  // overlapping fraction from 6% to 8%. That is a real regression against "items must
  // never overlap", and it is not fixable by picking smaller constants: even rotating the
  // spiral by a per-page phase and changing nothing else shifts the same number.
  //
  // So the amplitude isn't chosen up front — the page is laid out at full wobble, scored,
  // and only re-run tamer if that particular page came out overlapping. A page that packs
  // cleanly (the large majority) keeps the full variation and pays for one extra scoring
  // pass; a page that doesn't gives the variation back a step at a time rather than
  // shipping an overlap. The plain golden angle is always the last candidate, so this can
  // never place worse than the unvaried layout did.
  let best = scatter(1)
  let bestPenalty = layoutPenalty(best, width, height, headerH, bottomPad)
  // A bubble-only page has no wobble to give back, so the other candidates would be the
  // identical layout recomputed — don't pay for them.
  for (const wobble of hasNotes ? [0.5, 0] : []) {
    if (bestPenalty <= LAYOUT_PENALTY_EPS) break
    const candidate = scatter(wobble)
    const penalty = layoutPenalty(candidate, width, height, headerH, bottomPad)
    if (penalty < bestPenalty) { best = candidate; bestPenalty = penalty }
  }
  return best
}

// ─── Page transition variants ─────────────────────────────────────────────────

const pageVariants = {
  initial: (dir) => dir === 'in'
    ? { opacity: 0, scale: 0.88 }
    : { opacity: 0, scale: 1.08 },
  animate: { opacity: 1, scale: 1 },
  exit: (dir) => dir === 'in'
    ? { opacity: 0, transition: { duration: 0.14 } }
    : { opacity: 0, scale: 0.88, transition: { duration: 0.22, ease: 'easeIn' } },
}

// Small padlock drawn on a locked bubble / note card, above its (withheld) label.
function LockGlyph({ size = 14, color = 'rgba(255,255,255,0.8)', style }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={2.2}
      style={{ flexShrink: 0, pointerEvents: 'none', ...style }}
    >
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  )
}

// Bin icon for the long-press menu's delete row.
function TrashGlyph({ size = 14, color = 'currentColor', style }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={2.2}
      style={{ flexShrink: 0, pointerEvents: 'none', ...style }}
    >
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  )
}

// Bubble name/count type metrics live in utils/bubbleText.js (pure, and tested).

// ─── Shared name size ─────────────────────────────────────────────────────────
//
// A dozen names each at their own best size makes a page look like a ransom note, so
// the bubbles on one screen all render at the same size: the smallest that any of them
// needed. Each bubble still works out its own fit — the size at which its name stays on
// one line — and reports it here; the scope hands back the minimum of the reports.
//
// One scope covers the whole level, pages included. Scoping it per page instead looks
// right on a desktop — which is wide enough that a level rarely paginates at all, so
// there is only ever one page — but on a phone the same level splits across pages, and
// a name that had to shrink on page 1 left the same-sized name on page 2 rendering
// larger. The pages are one screenful of content that happens to swipe, so they share
// a size. Only bubbles report: note cards size their text by their own rules.
const BubbleNameFontContext = createContext(null)

// liveIds: every bubble id currently at this level, across all its pages. Only the pages
// around the current one are mounted, so unmounting no longer means "gone" — a bubble two
// pages away has simply been windowed out, and its measured fit must stay in the pool or
// swiping would grow every remaining name mid-gesture. The shared size is one size for
// the whole level, pages included, and that is what keeps it so. A bubble that really has
// left the level is pruned by the effect below, since a windowed-out one never gets to
// run its own cleanup.
function BubbleNameFontScope({ children, liveIds = null }) {
  const [minFont, setMinFont] = useState(null)
  const fits = useRef(new Map())
  const liveRef = useRef(liveIds)
  liveRef.current = liveIds

  // Stable across renders: the measuring effect depends on it, and an identity that
  // changed with `minFont` would re-run every measurement each time the shared size
  // moved — which is what the measurement decides in the first place.
  const report = useCallback((id, size) => {
    if (size == null) {
      if (liveRef.current?.has(id)) return // windowed out, not gone — keep its fit
      if (!fits.current.delete(id)) return
    } else {
      if (fits.current.get(id) === size) return
      fits.current.set(id, size)
    }
    setMinFont(fits.current.size ? Math.min(...fits.current.values()) : null)
  }, [])

  useEffect(() => {
    if (!liveIds) return
    let dropped = false
    for (const id of fits.current.keys()) {
      if (!liveIds.has(id)) { fits.current.delete(id); dropped = true }
    }
    if (dropped) setMinFont(fits.current.size ? Math.min(...fits.current.values()) : null)
  }, [liveIds])

  const value = useMemo(() => ({ minFont, report }), [minFont, report])
  return <BubbleNameFontContext.Provider value={value}>{children}</BubbleNameFontContext.Provider>
}

// ─── BubbleCircle ─────────────────────────────────────────────────────────────

// `floating`: run the idle bob. False for items on a mounted-but-not-current page, and
// for everything while a swipe is in flight — an off-screen bob is invisible work, and
// during a swipe every float competes with the track for the same frames. The item
// simply rests at its layout position; the layout's vertical gaps are measured from
// there (the bob only ever travels UP), so a paused item can't overlap a neighbour.
function BubbleCircle({ item, index, hidden, isDragging, animateLayout, floating = true, selectable = false, selected = false }) {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const rgb = hexToRgb(item.color)
  const solidBg = isLight ? solidMutedColor(item.color) : null
  const solidText = isLight ? contrastColor(solidBg) : null
  // `item.gated` — locked and not unlocked this session. The name and the child/note
  // counts are both withheld (a count leaks how much is inside).
  const gated = !!item.gated
  const name = gated ? 'Locked' : (item.name || '')

  // Count line ("N bubbles" / "N notes" on separate lines). Fixed size — it's
  // secondary information, so it never scales with the name or the bubble.
  const countLines = (item.childBubbleCount > 0 ? 1 : 0) + (item.noteCount > 0 ? 1 : 0)
  const showSub = !gated && countLines > 0 && item.r >= 34

  // Rendered box: a wide rounded rectangle, not a circle.
  const W = Math.round(item.r * 2 * BUB_HW)
  const H = Math.round(item.r * 2 * BUB_HH)

  // Vertical budget: the name is centred, the count hangs directly beneath it, and
  // both have to live inside H with a little breathing room top and bottom.
  const lineW = Math.max(W - TEXT_PAD * 2, 1)   // usable width, every line
  const nameBoxH = nameBoxHeight(H, showSub ? countLines : 0)

  // Width the name itself gets, which on a gated bubble is what the lock glyph and its
  // gap leave of the line. The gap is figured at the cap rather than the current size so
  // this doesn't move with the very font size it's used to choose.
  const measureW = Math.max(
    lineW - (gated ? Math.max(Math.min(item.r * 0.3, 18), 10) + Math.max(NAME_MAX_FONT * 0.35, 4) : 0),
    1,
  )

  // Starting size: the largest the name is *estimated* to fit at on a single line,
  // shrinking rather than wrapping to get there. The measured pass below corrects it
  // against the real glyph widths.
  const estimatedFont = useMemo(
    () => fitNameFont(name, lineW, nameBoxH),
    [name, lineW, nameBoxH]
  )

  const nameRef = useRef(null)
  const [nameFont, setNameFont] = useState(estimatedFont)
  const shared = useContext(BubbleNameFontContext)
  const reportFit = shared?.report

  // Correct the estimate against what the browser actually renders, so a name is only
  // ever wrapped or truncated when it genuinely doesn't fit at the floor — not because
  // the glyph width guess was off.
  //
  // One line is the goal, so what's tested at each size is the thing itself — does the
  // name render on a single line — rather than a width model of it. Predicting the line
  // from measured text width failed twice over (scrollWidth on a -webkit-box reports the
  // padding box, and any client rect is scaled by the bubble's mount/drag transform while
  // the layout width it'd be compared against isn't), and both failures read as "fits at
  // any size". scrollHeight has neither problem: it's layout, so no transform, and with
  // the clamp lifted it counts every line the name really took.
  useLayoutEffect(() => {
    const el = nameRef.current
    if (!el || !name) return
    const restoreClamp = el.style.webkitLineClamp
    const restoreWidth = el.style.width
    const restoreMaxWidth = el.style.maxWidth
    // Put back the size React wrote, not the empty string: clearing the property leaves
    // React believing it is still set, so it skips the DOM write whenever the size it
    // renders next is the one it last wrote — and the name is left with no font-size at
    // all, at the browser's 16px. It bites exactly the bubble whose own fit is the
    // shared minimum, since that is the one whose value never changes.
    const restoreFont = el.style.fontSize
    el.style.webkitLineClamp = 'unset'

    // Measure against the box the bubble is settling INTO, not the one it has right
    // now. The wrapper CSS-transitions its width over 350ms whenever a page re-layouts,
    // so this effect runs mid-animation, and a name measured against the old, wider box
    // comes back as fitting on one line and then wraps once the box finishes shrinking.
    // maxWidth has to go with it, or it clamps the forced width back to the animating
    // container. Wide enough desktop bubbles hid this: there, both widths fit.
    el.style.maxWidth = 'none'
    el.style.width = `${measureW}px`

    const heightAt = (px) => { el.style.fontSize = `${px}px`; return el.scrollHeight }
    // scrollHeight is rounded, so one line is told from two by the halfway mark rather
    // than an exact match. A line that doesn't fit the height budget doesn't count.
    const oneLineAt = (px) =>
      px * NAME_LINE_H <= nameBoxH + 0.5 && heightAt(px) < px * NAME_LINE_H * 1.5

    const seed = Math.min(NAME_MAX_FONT, Math.max(NAME_MIN_FONT, estimatedFont))
    let size = seed
    // Down to the floor if that's what one line takes, then back up to the largest size
    // that still holds it.
    while (size > NAME_MIN_FONT && !oneLineAt(size)) size = Math.max(NAME_MIN_FONT, size - 0.5)
    if (oneLineAt(size)) {
      while (size < NAME_MAX_FONT && oneLineAt(size + 0.5)) size += 0.5
    } else {
      // Not even the floor keeps it on one line — wrap, at the largest size that fits.
      const fits = (px) => heightAt(px) <= nameBoxH + 0.5
      size = seed
      while (size > NAME_MIN_FONT && !fits(size)) size = Math.max(NAME_MIN_FONT, size - 0.5)
      while (size < NAME_MAX_FONT && fits(size + 0.5)) size += 0.5
    }

    el.style.fontSize = restoreFont
    el.style.width = restoreWidth
    el.style.maxWidth = restoreMaxWidth
    el.style.webkitLineClamp = restoreClamp
    setNameFont(size)
    reportFit?.(item.id, size)
  }, [name, measureW, nameBoxH, estimatedFont, reportFit, item.id])

  // Withdraw from the screen's minimum on the way out, so a bubble that has been
  // deleted, filtered away or swiped past can't hold every other title small.
  useEffect(() => () => reportFit?.(item.id, null), [reportFit, item.id])

  // The screen's shared size, which is the smallest fit on it — never larger than this
  // bubble's own fit, so a name that fitted on one line still does.
  const fontSize = shared?.minFont ?? nameFont
  // Lines this font may occupy. Text is only ellipsised at the floor.
  const nameLines = Math.max(1, Math.floor(nameBoxH / (fontSize * NAME_LINE_H)))

  const floatAmt = 2.5 + (index % 3) * 1.5
  const floatDuration = 2.6 + (index % 4) * 0.45
  const floatDelay = (index * 0.22) % 3

  return (
    // Outer wrapper: framer only animates opacity here, so style.transform is safe to set
    // directly by the RAF drag loop without framer interference.
    <motion.div
      data-item-id={item.id}
      style={{
        position: 'absolute',
        left: item.cx - W / 2,
        top: item.cy - H / 2,
        width: W,
        height: H,
        cursor: isDragging ? 'grabbing' : 'grab',
        visibility: hidden ? 'hidden' : 'visible',
        pointerEvents: hidden ? 'none' : 'auto',
        zIndex: isDragging ? 100 : 'auto',
        willChange: 'transform',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        // Smoothly resize/reposition when a page re-layouts (e.g. after a bubble is
        // moved to/from another page). Only enabled briefly so it never interferes
        // with the transform-based drag.
        transition: animateLayout
          ? 'left 0.35s ease, top 0.35s ease, width 0.35s ease, height 0.35s ease'
          : undefined,
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, delay: index * 0.04 }}
    >
      {/* Inner: framer owns transform here (scale mount + scale+y float/drag) */}
      <motion.div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          borderRadius: bubbleCornerPx(item.r),
          background: isLight
            ? solidBg
            : `radial-gradient(135deg, rgba(255,255,255,0.24) 0%, rgba(${rgb},0.22) 55%, rgba(${rgb},0.07) 100%)`,
          backdropFilter: isLight ? 'none' : 'blur(24px)',
          WebkitBackdropFilter: isLight ? 'none' : 'blur(24px)',
          border: isLight
            ? `1.5px solid rgba(${rgb},${isDragging ? '0.7' : '0.5'})`
            : `1.5px solid ${isDragging ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.28)'}`,
          boxShadow: isDragging
            ? `0 20px 60px rgba(${rgb},${isLight ? '0.45' : '0.7'}), 0 6px 20px rgba(0,0,0,${isLight ? '0.12' : '0.5'})`
            : `0 8px 32px rgba(${rgb},${isLight ? '0.35' : '0.42'}), 0 2px 10px rgba(0,0,0,${isLight ? '0.08' : '0.3'})`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          userSelect: 'none',
          overflow: 'hidden',
          transition: 'box-shadow 0.18s ease-out, border-color 0.18s ease-out',
        }}
        initial={{ scale: 0 }}
        animate={isDragging
          ? { scale: 1.1, y: 0 }
          : { scale: 1, y: floating ? [0, -floatAmt, 0] : 0 }}
        transition={isDragging
          ? { duration: 0.18, ease: [0.34, 1.56, 0.64, 1] }
          : {
              scale: { type: 'spring', stiffness: 260, damping: 22, delay: index * 0.07 },
              // Paused: ease back to rest over a beat rather than snapping — a swipe that
              // ends where it started would otherwise show every bubble twitch on release.
              y: floating
                ? { duration: floatDuration, repeat: Infinity, ease: 'easeInOut', delay: floatDelay }
                : { duration: 0.25, ease: 'easeOut' },
            }
        }
      >
        {/* Text container: the title is centered (both axes) in the bubble on its own.
            The count is anchored right below the title text (top: 100%) so it hugs it
            without pushing the title off-center, and can wrap onto a second line. */}
        <div style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: gated ? Math.max(fontSize * 0.35, 4) : 0,
          textAlign: 'center',
          width: '100%',
          padding: `0 ${TEXT_PAD}px`,
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }}>
          {gated && (
            <LockGlyph
              size={Math.max(Math.min(item.r * 0.3, 18), 10)}
              color={isLight ? solidText : 'rgba(255,255,255,0.85)'}
            />
          )}
          <span ref={nameRef} style={{
            fontSize,
            fontWeight: 600,
            color: isLight ? solidText : 'rgba(255,255,255,0.93)',
            textAlign: 'center',
            textShadow: isLight ? 'none' : '0 1px 4px rgba(0,0,0,0.55)',
            lineHeight: NAME_LINE_H,
            maxWidth: '100%',
            // The font is sized to hold the name on one line, so this is the fallback
            // for a name too long for the bubble at the floor: wrap at spaces, and
            // break mid-word rather than overflow. Ellipsis only if it still can't fit.
            wordBreak: 'normal',
            overflowWrap: 'anywhere',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: nameLines,
            WebkitBoxOrient: 'vertical',
          }}>
            {name}
          </span>
          {showSub && (
            <div style={{
              position: 'absolute',
              top: '100%',       // directly below the title text
              // Match the title's horizontal padding (aligns with the title content box).
              left: TEXT_PAD,
              right: TEXT_PAD,
              marginTop: NAME_COUNT_GAP,
              // Fixed, except that it never outgrows the name above it: a long name in a
              // small bubble can be sized down past COUNT_FONT, and a count bigger than
              // the title it belongs to reads as the more important of the two. The
              // height budget still reserves COUNT_FONT, so this only ever frees space.
              fontSize: Math.min(COUNT_FONT, fontSize),
              color: isLight ? (solidText === '#ffffff' ? 'rgba(255,255,255,0.65)' : 'rgba(31,41,55,0.55)') : 'rgba(255,255,255,0.48)',
              fontWeight: 500,
              textAlign: 'center',
              lineHeight: COUNT_LINE_H,
              // Each count on its own line; wrap a long line if needed.
              wordBreak: 'normal',
              overflowWrap: 'anywhere',
              overflow: 'hidden',
            }}>
              {item.childBubbleCount > 0 && (
                <div>{item.childBubbleCount} {item.childBubbleCount === 1 ? 'bubble' : 'bubbles'}</div>
              )}
              {item.noteCount > 0 && (
                <div>{item.noteCount} {item.noteCount === 1 ? 'note' : 'notes'}</div>
              )}
            </div>
          )}
        </div>
      </motion.div>

      {/* Selection overlay — ring (when selected) + checkmark badge, in the non-clipped
          outer wrapper so the corner badge isn't cut off by the bubble's overflow. */}
      {selectable && <SelectionOverlay selected={selected} radius={bubbleCornerPx(item.r)} />}
    </motion.div>
  )
}

// Ring + checkmark badge drawn over a selectable item. `radius` matches the item shape
// (the bubble's px corner radius for bubbles, 22% for note cards).
function SelectionOverlay({ selected, radius }) {
  return (
    <>
      {selected && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: radius,
          border: '2.5px solid #6366f1',
          boxShadow: '0 0 0 4px rgba(99,102,241,0.25)',
          pointerEvents: 'none', zIndex: 5,
        }} />
      )}
      <div style={{
        position: 'absolute', top: -3, right: -3,
        width: 20, height: 20, borderRadius: '50%',
        background: selected ? '#6366f1' : 'rgba(0,0,0,0.55)',
        border: selected ? 'none' : '1.5px solid rgba(255,255,255,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none', zIndex: 6,
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
      }}>
        {selected && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
    </>
  )
}

// ─── NoteCard ─────────────────────────────────────────────────────────────────

// `floating` — same contract as BubbleCircle's: run the idle bob only when this item is
// on the current page and no swipe is in flight.
function NoteCard({ item, index, customTagColors = {}, isDragging, animateLayout, floating = true, selectable = false, selected = false }) {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const rgb = hexToRgb(item.color)
  const solidBg = isLight ? solidMutedColor(item.color) : null
  const solidText = isLight ? contrastColor(solidBg) : null
  const r = item.r
  const W = Math.round(r * 1.55)
  const H = Math.round(r * 1.15)
  // Locked and not unlocked this session: title, body preview and tag dots are all
  // content, so none of them are drawn — just a padlock and "Locked".
  const gated = !!item.gated
  const tagDots = gated
    ? []
    : (item.tags || []).map(t => TAG_COLORS[t] || customTagColors[t]).filter(Boolean)

  const floatAmt      = 2.5 + (index % 3) * 1.5
  const floatDuration = 2.6 + (index % 4) * 0.45
  const floatDelay    = (index * 0.22) % 3

  const label    = gated ? 'Locked' : (getNoteTitle(item.content) || 'New note')
  const lines    = (item.content || '').split('\n').filter(l => l.trim())
  const bodyText = gated ? '' : lines.slice(1).join('\n').trim() // content after the first (title) line
  const fontSize = Math.max(Math.min(r * 0.17, 13), 8)
  const subSize  = Math.max(Math.min(r * 0.13, 10), 7)
  const iconSize = Math.max(Math.min(r * 0.18, 12), 8)

  // The title takes as many lines as it needs (up to what physically fits); the body
  // preview then fills whatever vertical space is left — as many lines as will fit,
  // NOT a fixed cap. The body is shown ONLY when the whole first line (the title) is
  // fully visible without truncation; if the title is cut off, the body is hidden.
  const CHAR_W = 0.55
  const LINE_HT = 1.25
  const usableW = Math.max(W * 0.86, 1)
  const usableH = Math.max(H * 0.9, 1)
  const charsPerLine = Math.max(1, Math.floor(usableW / (fontSize * CHAR_W)))
  const titleLineH = fontSize * LINE_HT
  const bodyLineH  = subSize * LINE_HT
  const hasBodyText = bodyText.length > 0
  // Most lines the title may occupy before it can no longer fit in the card.
  const maxTitleLines = Math.max(1, Math.floor(usableH / titleLineH))
  const titleLinesNeeded = Math.max(1, Math.ceil(label.length / charsPerLine))

  const titleRef = useRef(null)
  // Initial estimates from the char count (avoid a first-frame flash); the DOM
  // measurement below corrects both once laid out.
  const estTitleLines = Math.min(titleLinesNeeded, maxTitleLines)
  const [titleTruncated, setTitleTruncated] = useState(
    () => hasBodyText && titleLinesNeeded > maxTitleLines
  )
  const [bodyLines, setBodyLines] = useState(() => {
    if (!hasBodyText || titleLinesNeeded > maxTitleLines) return 0
    return Math.max(0, Math.floor((usableH - estTitleLines * titleLineH) / bodyLineH))
  })

  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    // With -webkit-line-clamp, the title is truncated iff its full content is taller
    // than the clamped box.
    const truncated = el.scrollHeight > el.clientHeight + 1
    setTitleTruncated(truncated)
    if (!hasBodyText || truncated) { setBodyLines(0); return }
    // Fill the space left below the measured title with as many body lines as fit.
    // The +2px tolerance keeps a line that only just fits from being dropped by rounding.
    const remaining = usableH - el.clientHeight - 2
    setBodyLines(Math.max(0, Math.floor((remaining + 2) / bodyLineH)))
  }, [label, bodyText, W, H, fontSize, subSize, hasBodyText, usableH, bodyLineH, titleLineH])

  const showBody = hasBodyText && !titleTruncated && bodyLines > 0

  return (
    <motion.div
      data-item-id={item.id}
      style={{
        position: 'absolute',
        left: item.cx - W / 2,
        top: item.cy - H / 2,
        width: W,
        height: H,
        cursor: isDragging ? 'grabbing' : 'grab',
        zIndex: isDragging ? 100 : 'auto',
        willChange: 'transform',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        transition: animateLayout
          ? 'left 0.35s ease, top 0.35s ease, width 0.35s ease, height 0.35s ease'
          : undefined,
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, delay: index * 0.04 }}
    >
      <motion.div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: `${CORNER_RATIO * 100}%`,
          background: isLight
            ? solidBg
            : `radial-gradient(135deg, rgba(255,255,255,0.24) 0%, rgba(${rgb},0.22) 55%, rgba(${rgb},0.07) 100%)`,
          backdropFilter: isLight ? 'none' : 'blur(24px)',
          WebkitBackdropFilter: isLight ? 'none' : 'blur(24px)',
          border: isLight
            ? `1.5px solid rgba(${rgb},${isDragging ? '0.7' : '0.5'})`
            : `1.5px solid ${isDragging ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.28)'}`,
          boxShadow: isDragging
            ? `0 16px 40px rgba(0,0,0,${isLight ? '0.16' : '0.5'})`
            : `0 4px 14px rgba(0,0,0,${isLight ? '0.1' : '0.3'}), 0 1px 4px rgba(0,0,0,${isLight ? '0.07' : '0.2'})`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          userSelect: 'none',
          overflow: 'hidden',
          position: 'relative',
          transition: 'box-shadow 0.18s ease-out, border-color 0.18s ease-out',
        }}
        initial={{ scale: 0 }}
        animate={isDragging
          ? { scale: 1.1, y: 0 }
          : { scale: 1, y: floating ? [0, -floatAmt, 0] : 0 }}
        transition={isDragging
          ? { duration: 0.18, ease: [0.34, 1.56, 0.64, 1] }
          : {
              scale: { type: 'spring', stiffness: 260, damping: 22, delay: index * 0.07 },
              y: floating
                ? { duration: floatDuration, repeat: Infinity, ease: 'easeInOut', delay: floatDelay }
                : { duration: 0.25, ease: 'easeOut' },
            }
        }
      >
        {gated && (
          <LockGlyph
            size={Math.max(Math.min(r * 0.26, 15), 9)}
            color={isLight ? solidText : 'rgba(255,255,255,0.85)'}
            style={{ marginBottom: 2 }}
          />
        )}
        <span ref={titleRef} style={{
          fontSize,
          fontWeight: 600,
          color: isLight ? solidText : 'rgba(255,255,255,0.93)',
          textAlign: 'center',
          textShadow: isLight ? 'none' : '0 1px 4px rgba(0,0,0,0.55)',
          padding: '0 5px',
          lineHeight: 1.25,
          maxWidth: '92%',
          wordBreak: 'break-word',
          pointerEvents: 'none',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: maxTitleLines,
          WebkitBoxOrient: 'vertical',
        }}>
          {label}
        </span>
        {showBody && (
          <span style={{
            fontSize: subSize,
            color: isLight ? (solidText === '#ffffff' ? 'rgba(255,255,255,0.65)' : 'rgba(31,41,55,0.55)') : 'rgba(255,255,255,0.48)',
            marginTop: 2,
            fontWeight: 500,
            pointerEvents: 'none',
            textAlign: 'center',
            padding: '0 5px',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: bodyLines,
            WebkitBoxOrient: 'vertical',
            whiteSpace: 'pre-line',
            maxWidth: '92%',
          }}>
            {bodyText}
          </span>
        )}
        {tagDots.length > 0 && (
          <div style={{
            position: 'absolute',
            left: 5,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            pointerEvents: 'none',
          }}>
            {tagDots.slice(0, 4).map((color, i) => (
              <span key={i} style={{
                width: 2.5,
                height: 2.5,
                borderRadius: '50%',
                backgroundColor: color,
                boxShadow: `0 0 4px ${color}`,
                display: 'inline-block',
              }} />
            ))}
          </div>
        )}
      </motion.div>

      {/* Selection overlay (rounded-rect to match the note card) */}
      {selectable && <SelectionOverlay selected={selected} radius="22%" />}
    </motion.div>
  )
}

// ─── ZoomExpand ───────────────────────────────────────────────────────────────
// The clicked bubble itself expands to fill the screen (or shrinks back).
// Only one visual exists — the original bubble is hidden while this animates.

function ZoomExpand({ anim, size, onDone }) {
  if (!anim || !size.width) return null

  const { phase, cx, cy, r, color } = anim
  const rgb = hexToRgb(color)

  const bubbleRect = {
    left: cx - r * BUB_HW, top: cy - r * BUB_HH,
    width: r * 2 * BUB_HW, height: r * 2 * BUB_HH,
    borderRadius: bubbleCornerPx(r),
  }
  const screenRect = { left: 0, top: 0, width: size.width, height: size.height, borderRadius: 0 }

  const from = phase === 'in' ? bubbleRect : screenRect
  const to   = phase === 'in' ? screenRect : bubbleRect

  return (
    <motion.div
      style={{
        position: 'absolute',
        zIndex: 30,
        pointerEvents: 'none',
        background: `radial-gradient(135deg, rgba(255,255,255,0.18) 0%, rgba(${rgb},0.88) 55%, rgba(${rgb},0.97) 100%)`,
        boxShadow: `0 8px 40px rgba(${rgb},0.5), inset 0 1.5px 0 rgba(255,255,255,0.35)`,
      }}
      initial={from}
      animate={to}
      transition={{ duration: 0.38, ease: [0.4, 0, 0.2, 1] }}
      onAnimationComplete={onDone}
    />
  )
}

// ─── Layout constants & shared helpers ────────────────────────────────────────

// Press-and-hold on an item without moving for this long opens its menu. It's
// deliberately well past the drag threshold (100ms here, 220ms in paged mode): any
// movement at all cancels the menu and the press stays a drag, so the two gestures
// never compete. Raised by half from 500ms — the menu now carries a destructive action,
// so it should take a deliberate hold to reach rather than a slightly slow tap.
const LONG_PRESS_MENU_MS = 750

// ─── Long-press item menu ─────────────────────────────────────────────────────
// Anchored at the press point and clamped to stay on screen. Stops its own pointer
// events so the canvas's drag handlers underneath don't pick them up.

function LockMenu({ menu, gated, onLock, onDelete, onClose, width, height }) {
  if (!menu) return null
  const MENU_W = 176
  const MENU_H = 138 // header + two rows
  const x = Math.max(8, Math.min(menu.x, width - MENU_W - 8))
  const y = Math.max(SUB_BAR_H + 8, Math.min(menu.y, height - MENU_H - 8))
  const item = menu.item
  const label = gated ? 'Unlock' : item.locked ? 'Remove Lock' : 'Lock'

  return (
    <>
      <div
        className="absolute inset-0 z-40"
        onPointerDown={e => { e.stopPropagation(); onClose() }}
        onClick={e => e.stopPropagation()}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.13 }}
        className="absolute z-50 rounded-xl overflow-hidden shadow-2xl"
        style={{
          left: x, top: y, width: MENU_W, transformOrigin: 'top left',
          background: 'var(--surface-2)', border: '1px solid var(--border)',
        }}
        onPointerDown={e => e.stopPropagation()}
        onPointerUp={e => e.stopPropagation()}
      >
        <div
          className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider truncate"
          style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}
        >
          {gated ? 'Locked' : (item.type === 'note' ? (getNoteTitle(item.content) || 'New note') : item.name)}
        </div>
        <button
          onClick={e => { e.stopPropagation(); onLock() }}
          className="w-full flex items-center gap-2 px-3 py-3 text-sm text-left active:opacity-70"
          style={{ color: 'var(--text)' }}
        >
          <LockGlyph size={15} color="currentColor" />
          {label}
        </button>
        <div style={{ height: 1, background: 'var(--border)' }} />
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="w-full flex items-center gap-2 px-3 py-3 text-sm text-left active:opacity-70"
          style={{ color: '#f87171' }}
        >
          <TrashGlyph size={15} color="currentColor" />
          Delete
        </button>
      </motion.div>
    </>
  )
}

const SUB_BAR_H = 52
const BOTTOM_PAD = 0           // no bottom barrier — bubbles reach the bottom edge
// Just clear the + button itself: button is 56px (radius 28) + a small ~8px margin.
// TEMP (swipe performance investigation): timing for the swipe handler, the page-change
// commit, and the per-render page layout. Set false to silence, or delete the marked
// blocks. Note the app runs under StrictMode, so in dev every render body — including
// the layout below — executes TWICE per commit; halve the layout figures accordingly.
const DEBUG_SWIPE_PERF = true

const PLUS_BTN_EXCL_R = 36    // no-go radius around the floating + button

// Keep an item clear of the round + button (bottom-right), blocking overlap from ANY
// direction. Every item — note card and category bubble alike — is measured by its real
// rendered box against the button's exclusion circle, and pushed radially out of it.
// (Bubbles used to get a circle-vs-circle test, which reserved a fat invisible moat on
// the axes their box doesn't actually reach.) Mutates p.cx / p.cy in place.
function keepClearOfPlusButton(p, width, height, topLimit, botLimit) {
  const btnCx = width - 52, btnCy = height - 52
  const pen = circleBoxPen({ cx: btnCx, cy: btnCy, r: PLUS_BTN_EXCL_R }, p, BTN_ROW_PAD)
  if (pen <= 0) return
  const hw = halfWidthOf(p), hh = halfHeightOf(p)
  const dx = p.cx - btnCx, dy = p.cy - btnCy
  const d = Math.hypot(dx, dy) || 1
  p.cx = Math.max(hw + 12, Math.min(width - hw - 12, p.cx + (dx / d) * pen))
  p.cy = Math.max(topLimit + hh + 12, Math.min(botLimit - hh, p.cy + (dy / d) * pen))
}

// Clamp an item to screen bounds then push it clear of the + button (all sides).
// Items clamp by their real box half-extents, NOT a bounding circle — circle-clamping
// (r=40) forced note centers 17px further from the top edge than the even-spread grid
// places them, shoving the whole top row down into row 2 and re-creating tiny overlaps
// the layout had just resolved. Mutates p.cx / p.cy in place.
function clampToBounds(p, width, height) {
  const hw = halfWidthOf(p), hh = halfHeightOf(p)
  p.cx = Math.max(hw + 12, Math.min(width - hw - 12, p.cx))
  p.cy = Math.max(SUB_BAR_H + hh + 12, Math.min(height - BOTTOM_PAD - hh, p.cy))
  keepClearOfPlusButton(p, width, height, SUB_BAR_H, height - BOTTOM_PAD)
}

// Safety pass: after any data change / re-render, push apart any bubbles that
// overlap (e.g. a bubble grew, or saved positions no longer fit), leaving a small
// visual buffer so they never touch. Re-applies bounds + the + button barrier too.
//
// The + button is handled as a fixed circular OBSTACLE inside the loop — not via the
// keepClearOfPlusButton clamp. The clamp ran after the pair scan and outside the
// convergence check, so on the "converged" iteration it could slide a corner note
// straight onto its neighbour and ship that overlap to the screen (the "notes overlap
// a bit near the + button on mixed pages" bug). Here the barrier is a collision like
// any other, and any clamp displacement counts as movement, so the loop only stops
// when pairs, barrier, and bounds are ALL satisfied at once.
// pinBubbles (mixed pages): a bubble never moves to resolve a bubble-note overlap —
// only the note yields — so the centered bubble cluster stays anchored through this
// pass. Bubble-bubble overlaps still resolve symmetrically.
// ellipseOnlyIds: when given, the cluster-ellipse obstacle applies only to these notes
// (freshly arranged ones) — notes the user deliberately parked inside the cluster keep
// their spot instead of being ejected on load.
// Should the final safety pass pin the bubble cluster?
//
// On a fresh mixed page (nothing hand-placed) computeLayout has already settled the notes
// around a PINNED, centered bubble cluster. Running the safety pass unpinned lets a
// crowded page's notes shove that cluster back into itself — re-creating exactly the
// bubble-on-bubble overlap the pinned pass had just resolved. Once the user has placed
// items by hand there is no canonical cluster to protect, so everything moves freely.
function shouldPinBubbles(items, anchoredCount) {
  return anchoredCount === 0 &&
    items.some(i => i.type === 'note') && items.some(i => i.type !== 'note')
}

export function separateOverlaps(items, width, height, pinBubbles = false, ellipseOnlyIds = null) {
  const BUFFER = 3 // px gap so items never visually touch
  const EPS = 0.25 // sub-pixel tolerance so float noise doesn't spin the loop forever
  const pos = items.map(i => ({ ...i }))
  const btnCx = width - 52, btnCy = height - 52
  // Screen bounds only — box-aware, same insets as clampToBounds.
  const boundsClamp = (p) => {
    const hw = halfWidthOf(p), hh = halfHeightOf(p)
    p.cx = Math.max(hw + EDGE_INSET, Math.min(width - hw - EDGE_INSET, p.cx))
    p.cy = Math.max(SUB_BAR_H + hh + EDGE_INSET, Math.min(height - BOTTOM_PAD - hh, p.cy))
  }
  // How far outside the page an item hangs, 0 when fully inside — the same insets read as
  // a distance instead of a clamp, so a snapshot can be scored on it.
  const outOfBounds = (p) => {
    const hw = halfWidthOf(p), hh = halfHeightOf(p)
    return Math.max(0, hw + EDGE_INSET - p.cx) + Math.max(0, p.cx - (width - hw - EDGE_INSET))
      + Math.max(0, SUB_BAR_H + hh + EDGE_INSET - p.cy) + Math.max(0, p.cy - (height - BOTTOM_PAD - hh))
  }
  // Keep the BEST arrangement seen, not the last one.
  //
  // This relaxation does not always converge: on a crowded mixed page the pinned
  // bubble-note transfer above can fight the bubble-bubble separation, each undoing the
  // other every iteration. Returning `pos` after the iteration cap then ships whatever
  // half-resolved frame iteration 119 happened to leave — which is how a page could end
  // up MORE overlapped than an earlier iteration already had it. Scoring each iteration
  // by its total penetration and returning the best one makes the pass monotonic: extra
  // iterations can only ever help.
  let best = null
  let bestScore = Infinity
  for (let iter = 0; iter < 120; iter++) {
    let moved = false
    // How wrong the arrangement is at the START of this iteration, in px: pair penetration
    // (accumulated below) plus anything hanging off the page. Both are the same unit, so
    // they add — a snapshot with no overlaps but an item off-screen is not a good one.
    const snapshot = pos.map(p => ({ ...p }))
    let score = pos.reduce((s, p) => s + outOfBounds(p), 0)
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j]
        // Every pair separates by its real rendered box so items pack tight without the
        // fat circle spacing (which over-separated and, when dense, left them overlapping).
        //
        // On mixed pages the bubble cluster is pinned, so a bubble-note overlap is resolved
        // by the note alone: it absorbs the whole push (2x the symmetric half) and the
        // cluster stays centered. But a note can only yield while it has somewhere to go —
        // wedged against a page edge it would keep its overlap forever, which looks worse
        // than nudging the cluster. So whatever the note can't absorb transfers to the
        // bubble. Bubble-bubble pairs, and every pair on an unpinned page, split it evenly.
        const mixedPair = (a.type === 'note') !== (b.type === 'note')
        const yielder = (pinBubbles && mixedPair) ? (a.type === 'note' ? a : b) : null
        // Both branches must leave (b - a) separated by 2p on the push axis. The transfer
        // to the bubble is DAMPED: at full strength it fights the bubble-bubble separation
        // above — a bubble gets pushed off its neighbour, then a wedged note shoves it
        // straight back, and the two never settle. Damped, the tug-of-war has a fixed
        // point, so the cluster gives ground gradually instead of oscillating.
        const TRANSFER_DAMPING = 0.4
        const pinnedPush = (axis) => (p) => {
          const want = yielder === a ? -2 * p : 2 * p
          const before = yielder[axis]
          yielder[axis] += want
          boundsClamp(yielder)
          const rest = (want - (yielder[axis] - before)) * TRANSFER_DAMPING
          if (yielder === a) b[axis] -= rest
          else a[axis] -= rest
        }
        const depth = separateBoxPair(
          b.cx - a.cx, b.cy - a.cy,
          halfWidthOf(a), halfHeightOf(a), halfWidthOf(b), halfHeightOf(b),
          pairGapX(a, b, BUFFER) - EPS, pairGapY(a, b, BUFFER) - EPS,
          yielder ? pinnedPush('cx') : (p) => { a.cx -= p; b.cx += p },
          yielder ? pinnedPush('cy') : (p) => { a.cy -= p; b.cy += p },
        )
        if (depth) { moved = true; score += depth }
      }
    }
    // + button obstacle: every item measures by its real box against the button's
    // exclusion circle (matching the grid's row capacity), then gets pushed radially
    // out — a circle test would shove aside cells the grid legitimately placed beside it.
    for (const p of pos) {
      const pen = circleBoxPen({ cx: btnCx, cy: btnCy, r: PLUS_BTN_EXCL_R }, p, BTN_ROW_PAD - EPS)
      if (pen > 0) {
        const dx = p.cx - btnCx, dy = p.cy - btnCy
        const d = Math.sqrt(dx * dx + dy * dy) || 0.001
        p.cx += (dx / d) * pen
        p.cy += (dy / d) * pen
        moved = true
      }
    }
    // Pinned mode: the bubble cluster's ellipse is an obstacle for notes, so the
    // converged state can never leave a note in a pocket between bubbles — while
    // still letting notes crowd right up against the cluster's silhouette.
    if (pinBubbles) {
      const bubs = pos.filter(p => p.type !== 'note')
      if (bubs.length > 0) {
        const eCl = clusterEllipse(bubs)
        for (const p of pos) {
          if (p.type !== 'note') continue
          if (ellipseOnlyIds && !ellipseOnlyIds.has(p.id)) continue
          if (projectOutOfEllipse(p, eCl, p.r * NOTE_HW + BUFFER - EPS, p.r * NOTE_HH + BUFFER - EPS)) moved = true
        }
      }
    }
    for (const p of pos) {
      const px = p.cx, py = p.cy
      boundsClamp(p)
      if (Math.abs(p.cx - px) > EPS || Math.abs(p.cy - py) > EPS) moved = true
    }
    if (score < bestScore) { bestScore = score; best = snapshot }
    // Nothing moved: `pos` satisfies every pair, the barrier and the bounds at once —
    // strictly better than any scored snapshot, which are all pre-resolution states.
    if (!moved) return pos
  }
  return best ?? pos
}

// ─── Settle new (unplaced) items away from anchored (saved-position) items ─────
// anchoredIds = Set of item IDs that are fixed in place; new items are free to move.
function settleItems(items, anchoredIds, width, height) {
  const GAP = 16

  const pos = items.map(i => ({ ...i }))
  for (let iter = 0; iter < 40; iter++) {
    let moved = false
    for (let i = 0; i < pos.length; i++) {
      const a = pos[i]
      if (anchoredIds.has(a.id)) continue // anchored: never moves
      for (let j = 0; j < pos.length; j++) {
        if (i === j) continue
        const b = pos[j]
        const dx = a.cx - b.cx, dy = a.cy - b.cy
        // Box separation: push `a` off `b` along the axis of least penetration, measuring
        // every item by its real rendered rectangle (bubbles included) rather than a
        // bounding circle. An anchored `b` doesn't move, so `a` absorbs the whole overlap.
        const ox = halfWidthOf(a) + halfWidthOf(b) + pairGapX(a, b, GAP) - Math.abs(dx)
        const oy = halfHeightOf(a) + halfHeightOf(b) + pairGapY(a, b, GAP) - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue
        const bFree = !anchoredIds.has(b.id)
        if (ox < oy) {
          const s = dx < 0 ? -1 : 1
          if (bFree) { a.cx += s * ox / 2; b.cx -= s * ox / 2; clampToBounds(b, width, height) }
          else a.cx += s * ox
        } else {
          const s = dy < 0 ? -1 : 1
          if (bFree) { a.cy += s * oy / 2; b.cy -= s * oy / 2; clampToBounds(b, width, height) }
          else a.cy += s * oy
        }
        clampToBounds(a, width, height)
        moved = true
      }
    }
    if (!moved) break
  }
  return pos
}

// ─── Collision resolution ─────────────────────────────────────────────────────

// Iterative rigid-body collision resolution.
// Returns a new positions array with no overlaps and boundary violations resolved.
// The dragged item starts at desiredCx/desiredCy; if blocked by cornered bubbles
// it gets pushed back, giving a "hits a wall" feel.
function resolveCollisions(items, draggedId, desiredCx, desiredCy, width, height) {
  const GAP = 16

  const pos = items.map(item => ({
    id: item.id,
    cx: item.id === draggedId ? desiredCx : item.cx,
    cy: item.id === draggedId ? desiredCy : item.cy,
    r: item.r,
    type: item.type,
    isDragged: item.id === draggedId,
  }))

  // Clamp dragged item to screen boundaries (incl. + button exclusion) first
  const dp = pos.find(p => p.isDragged)
  if (dp) clampToBounds(dp, width, height)

  for (let iter = 0; iter < 30; iter++) {
    let anyOverlap = false

    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j]
        const dx = b.cx - a.cx
        const dy = b.cy - a.cy

        // Every pair collides by its real box + per-axis gaps — the circular model needed
        // ~94px between note centers, so dragging on a dense grid (67px pitch) would shove
        // every neighbour apart and then pin the blown-up layout on drop. Box collision
        // keeps drag physics consistent with layout, and it's what makes a dragged
        // rounded rectangle stop where its corner actually lands rather than where a
        // bounding circle would.
        const bothNotes = a.type === 'note' && b.type === 'note'
        const bothBubbles = a.type !== 'note' && b.type !== 'note'
        // Gaps by pair type: notes keep the grid's per-axis gaps; bubble-bubble keeps the
        // roomy GAP so a dragged bubble shoves its neighbours convincingly; a mixed pair
        // uses a tight 6px so a note dragged past a bubble doesn't feel like it's hitting
        // an invisible moat. Vertical always adds the float-bob clearance.
        const gapX = bothNotes ? NOTE_GAP_X : bothBubbles ? GAP : 6
        const gapY = bothNotes ? NOTE_GAP_Y : gapX + BUB_FLOAT_PAD
        const ox = halfWidthOf(a) + halfWidthOf(b) + gapX - Math.abs(dx)
        const oy = halfHeightOf(a) + halfHeightOf(b) + gapY - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue
        anyOverlap = true
        const axisX = ox < oy
        const ov = axisX ? ox : oy
        const sgn = (axisX ? dx : dy) < 0 ? -1 : 1 // a→b direction on the push axis
        if (!a.isDragged && !b.isDragged) {
          if (axisX) { a.cx -= sgn * ov / 2; b.cx += sgn * ov / 2 }
          else { a.cy -= sgn * ov / 2; b.cy += sgn * ov / 2 }
          clampToBounds(a, width, height)
          clampToBounds(b, width, height)
        } else {
          const dragged = a.isDragged ? a : b
          const other = a.isDragged ? b : a
          const dir = a.isDragged ? sgn : -sgn // push the other away from the dragged
          const bx = other.cx, by = other.cy
          if (axisX) other.cx += dir * ov; else other.cy += dir * ov
          clampToBounds(other, width, height)
          // Whatever the other item couldn't absorb (it hit a wall) pushes the dragged
          // item back instead — the "hits a wall" feel.
          const movedDist = Math.abs(axisX ? other.cx - bx : other.cy - by)
          const remaining = ov - movedDist
          if (remaining > 0.5) {
            if (axisX) dragged.cx -= dir * remaining; else dragged.cy -= dir * remaining
            clampToBounds(dragged, width, height)
          }
        }
      }
    }

    if (!anyOverlap) break
  }

  return pos
}

// ─── BubbleVisualization ──────────────────────────────────────────────────────

export default function BubbleVisualization({
  project,
  onSelectNote,
  onDeleteItems,
  onSetNoteLocked,
  onSetBubbleLocked,
  viewMode,
  onSetViewMode,
  onCurrentBubbleChange,
  navigateToBubbleId,
  placeBubbleId,
  onRefresh,
}) {
  const containerRef = useRef(null)
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const { noteSize } = usePreferences()
  const noteScale = NOTE_SIZE_SCALE[noteSize] ?? 1
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [navStack, setNavStack] = useState([])
  const [navDir, setNavDir] = useState('in')
  // ── Multi-select ──────────────────────────────────────────────────────────────
  // Selected ids can be notes OR bubbles; the item's own type tells them apart at
  // delete time. selectModeRef mirrors state so the pointer handlers (whose long-press
  // timers capture at press time) can gate dragging without a stale closure.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The single item queued for deletion from its long-press menu (null when none).
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null)
  const selectModeRef = useRef(false)
  selectModeRef.current = selectMode
  function toggleSelectItem(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function exitSelect() {
    setSelectMode(false)
    setSelectedIds(new Set())
    setConfirmDelete(false)
  }
  // Changing project or navigating to another bubble level clears the selection — the
  // selected items may no longer be on screen. (Page swipes keep it: same level.)
  useEffect(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
    setConfirmDelete(false)
    setConfirmDeleteItem(null)
  }, [project.id, navStack])

  // ── Locking ───────────────────────────────────────────────────────────────────
  // lockMenu: null | { item, x, y } — the long-press menu (see handlePointerDown).
  const [lockMenu, setLockMenu] = useState(null)
  const { unlockedIds, ensurePassword, requestUnlock, relockIds } = useLock()
  const lockIndex = useMemo(
    () => buildLockIndex(project.bubbles, project.notes, unlockedIds),
    [project.bubbles, project.notes, unlockedIds]
  )
  // Kept in a ref because the pointer handlers run outside the render closure.
  const lockIndexRef = useRef(lockIndex)
  lockIndexRef.current = lockIndex

  // Tapping a locked item prompts for the password instead of opening/entering it.
  // Returns true when the tap was consumed by the prompt.
  function gateTap(item) {
    if (!lockIndexRef.current.isGated(item)) return false
    requestUnlock(lockIndexRef.current.gatingIdsFor(item))
    return true
  }

  // Delete one item from its long-press menu. A locked item asks for the password first:
  // the lock exists to keep content out of reach, and deleting it from a menu one hold
  // away would be a way around that, not a shortcut through it.
  function requestDeleteItem(item) {
    if (lockIndexRef.current.isGated(item)) {
      requestUnlock(lockIndexRef.current.gatingIdsFor(item))
      return
    }
    setConfirmDeleteItem(item)
  }

  function toggleItemLock(item) {
    const setLocked = item.type === 'note' ? onSetNoteLocked : onSetBubbleLocked
    // Hidden right now (own lock or inherited) → password prompt; visible but locked
    // → drop the lock; otherwise → lock it.
    if (lockIndexRef.current.isGated(item)) {
      requestUnlock(lockIndexRef.current.gatingIdsFor(item))
      return
    }
    if (item.locked) { setLocked?.(item.id, false); return }
    ensurePassword(() => { relockIds(item.id); setLocked?.(item.id, true) })
  }

  // expandAnim: null | { phase: 'in'|'out', id, cx, cy, r, color }
  const [expandAnim, setExpandAnim] = useState(null)
  const [swipeOffset, setSwipeOffset] = useState(0)
  const swipeRef = useRef({ active: false, startX: 0, currentX: 0 })
  const navTimerRef = useRef(null)
  // Refs kept current every render so native event listeners avoid stale closures
  const navStackRef = useRef(navStack)
  const expandAnimRef = useRef(expandAnim)
  const zoomOutRef = useRef(null)
  navStackRef.current = navStack
  expandAnimRef.current = expandAnim

  // ── Drag state ────────────────────────────────────────────────────────────────
  const [draggingId, setDraggingId] = useState(null)
  const [savedPositions, setSavedPositions] = useState({})
  // Mutable refs — no React state updates during drag movement
  const dragInfoRef = useRef(null)        // { id, type, cx, cy, r } — pointer's desired position
  const resolvedDragPosRef = useRef(null) // { cx, cy } — actual resolved drag position (may differ if blocked)
  const resolvedAllPosRef = useRef([])    // full resolved positions array from last RAF frame
  const dragRafRef = useRef(null)         // RAF handle
  const laidWithOverridesRef = useRef([]) // kept current each render
  const savedPositionsRef = useRef({})
  const currentIdRef = useRef(null)
  const sizeRef = useRef(size)
  const longPressTimerRef = useRef(null)
  const pendingPointerRef = useRef(null) // { item, startClientX, startClientY }
  const dragActivatedRef = useRef(false)
  const menuTimerRef = useRef(null)      // long-press → item menu
  const menuOpenedRef = useRef(false)    // swallow the pointer-up that opened the menu
  // ── Paged mode state ──────────────────────────────────────────────────────────
  const [pageIndex, setPageIndex] = useState(0)
  const pageIndexRef = useRef(0)
  pageIndexRef.current = pageIndex
  // TEMP (swipe perf)
  const swipeSamplesRef = useRef({ n: 0, total: 0, max: 0 })
  const pageChangeTimingRef = useRef(false)
  // True from the moment a press turns into a page swipe until the settle spring stops.
  // Every float on every mounted page holds still for that window — the bob is a dozen
  // independent framer springs writing transforms each frame, and the swipe wants those
  // frames. swipeSettleRef tokenises the settle so a stale completion can't un-pause a
  // gesture that has already started (see animateToPage).
  const [swiping, setSwiping] = useState(false)
  const swipeSettleRef = useRef(0)
  const pageX = useMotionValue(0)
  const [savedPages, setSavedPages] = useState({}) // { [posKey]: pageIndex }
  const savedPagesRef = useRef({})
  savedPagesRef.current = savedPages
  const pagesRef = useRef([])         // current pages (arrays of laid items)
  // Layout memo (see the pagination block). pageIndex → { key, geom: [{id,cx,cy,r}] },
  // and the id→page assignment behind it. Both are pure caches: a miss only costs the
  // work that used to run unconditionally, so nothing has to invalidate them by hand.
  const pageLayoutCacheRef = useRef(new Map())
  const assignCacheRef = useRef({ key: null, pageOf: {} })
  const perPageRef = useRef(1)
  const paginatedRef = useRef(false)
  const pagedRef = useRef(null)       // active paged gesture state
  // Briefly true after a re-layout (a cross-page move, a reorganize, a note-size
  // change) so items ease to their new size and position instead of snapping.
  const [layoutAnim, setLayoutAnim] = useState(false)
  const layoutAnimTimerRef = useRef(null)
  const LAYOUT_ANIM_MS = 420
  function pulseLayoutAnim() {
    if (layoutAnimTimerRef.current) clearTimeout(layoutAnimTimerRef.current)
    setLayoutAnim(true)
    layoutAnimTimerRef.current = setTimeout(() => setLayoutAnim(false), LAYOUT_ANIM_MS)
  }
  // The note-size change is the one re-layout that CANNOT be flagged from an effect:
  // every note's width/height/left/top changes on the render that first sees the new
  // scale, and a CSS transition only carries a change it is present for. An effect runs
  // after that commit, so the resize would already have snapped and the transition would
  // have nothing left to animate. Flipping the flag during render instead puts the
  // transition and the new geometry in the same commit, which is what the browser needs.
  // animScale holds the scale currently being animated to (null when settled) rather
  // than a plain flag, so flipping through the sizes in quick succession restarts the
  // window on each change instead of letting the first one's timer cut the last short.
  const noteScaleRef = useRef(noteScale)
  const [animScale, setAnimScale] = useState(null)
  if (noteScaleRef.current !== noteScale) {
    noteScaleRef.current = noteScale
    setAnimScale(noteScale)
  }
  useEffect(() => {
    if (animScale === null) return
    const t = setTimeout(() => setAnimScale(null), LAYOUT_ANIM_MS)
    return () => clearTimeout(t)
  }, [animScale]) // eslint-disable-line react-hooks/exhaustive-deps
  const animatingLayout = layoutAnim || animScale !== null
  // Highlights the edge a dragged bubble is hovering over (will move to that page on drop).
  const [edgeGlow, setEdgeGlow] = useState(null) // 'left' | 'right' | null

  // Keep refs current each render
  savedPositionsRef.current = savedPositions
  sizeRef.current = size

  useEffect(() => {
    if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null }
    setNavStack([])
    setExpandAnim(null)
    setSavedPositions(loadSavedPositions(project.id))
    setSavedPages(loadSavedPages(project.id))
    setPageIndex(0)
    setDraggingId(null)
    dragInfoRef.current = null
    resolvedDragPosRef.current = null
    resolvedAllPosRef.current = []
    dragActivatedRef.current = false
    pendingPointerRef.current = null
    pagedRef.current = null
    if (layoutAnimTimerRef.current) { clearTimeout(layoutAnimTimerRef.current); layoutAnimTimerRef.current = null }
    setLayoutAnim(false)
    setEdgeGlow(null)
  }, [project.id])

  useEffect(() => {
    if (!navigateToBubbleId) return
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current)
      navTimerRef.current = null
    }
    setExpandAnim(null)
    // Root sentinel — navigate back to the top level
    if (navigateToBubbleId.startsWith?.('root:')) {
      setNavDir('out')
      setNavStack([])
      return
    }
    // Build path from root down to the target bubble
    const path = []
    let id = navigateToBubbleId
    while (id !== null && id !== undefined) {
      const bubble = project.bubbles.find(b => b.id === id)
      if (!bubble) break
      path.unshift({ id: bubble.id, name: bubble.name, color: bubble.color })
      id = bubble.parent_id
    }
    setNavDir('in')
    setNavStack(path)
  }, [navigateToBubbleId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const currentId = navStack.length > 0 ? navStack[navStack.length - 1].id : null
    onCurrentBubbleChange?.(currentId)
    setPageIndex(0) // start each level on its first page
  }, [navStack, onCurrentBubbleChange])

  useEffect(() => {
    return () => {
      if (navTimerRef.current) clearTimeout(navTimerRef.current)
      if (layoutAnimTimerRef.current) clearTimeout(layoutAnimTimerRef.current)
      if (menuTimerRef.current) clearTimeout(menuTimerRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    // clientHeight includes the safe-area paddingBottom (border-box); subtract it so
    // bubbles lay out in the visible area while the gradient still paints the safe area.
    const update = () => {
      const padBottom = parseFloat(getComputedStyle(el).paddingBottom) || 0
      setSize({ width: el.clientWidth, height: el.clientHeight - padBottom })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // iOS fires orientationchange before the viewport dimensions update;
    // resize fires after the layout settles, so we handle both.
    const onOrientationChange = () => setTimeout(update, 150)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', onOrientationChange)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', onOrientationChange)
    }
  }, [])

  // Native touch handler on container: swipe-to-go-back navigation
  // Must be native (not React synthetic) to call preventDefault on touchmove
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    function onTouchStart(e) {
      if (e.touches.length > 1 || expandAnimRef.current || dragActivatedRef.current) return
      const touch = e.touches[0]
      swipeRef.current = {
        active: touch.clientX < 28 && navStackRef.current.length > 0,
        startX: touch.clientX,
        currentX: touch.clientX,
      }
    }

    function onTouchMove(e) {
      if (e.touches.length > 1 || !swipeRef.current.active) return
      e.preventDefault()
      const dx = e.touches[0].clientX - swipeRef.current.startX
      swipeRef.current.currentX = e.touches[0].clientX
      if (dx > 0) setSwipeOffset(dx)
    }

    function onTouchEnd() {
      if (!swipeRef.current.active) return
      swipeRef.current.active = false
      const dx = swipeRef.current.currentX - swipeRef.current.startX
      if (dx > window.innerWidth * 0.3) zoomOutRef.current?.()
      else setSwipeOffset(0)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, []) // empty deps — all mutable values via refs

  // Block upward page scroll (rubber-band showing empty space below) while
  // allowing downward overscroll so the browser's native pull-to-refresh works.
  // Sidebar is excluded so it can scroll normally.
  useEffect(() => {
    let startY = 0
    function onTouchStart(e) { startY = e.touches[0].clientY }
    function onTouchMove(e) {
      if (e.target.closest('aside') || e.target.closest('[data-modal]')) return
      if (e.touches[0].clientY - startY < 0) e.preventDefault()
    }
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  // ── Derived state ─────────────────────────────────────────────────────────────

  const currentBubble = navStack.length > 0
    ? project.bubbles.find(b => b.id === navStack[navStack.length - 1].id) ?? null
    : null
  const currentId = currentBubble?.id ?? null

  const visibleBubbles = project.bubbles.filter(b => b.parent_id === currentId)
  // Every bubble at this level, mounted or not — the shared name size is scoped to the
  // level, and page windowing means the scope can no longer infer that from what is
  // mounted. Rebuilt only when the membership itself changes.
  const levelBubbleIdSig = visibleBubbles.map(b => b.id).join(',')
  const levelBubbleIds = useMemo(
    () => new Set(levelBubbleIdSig ? levelBubbleIdSig.split(',') : []),
    [levelBubbleIdSig],
  )

  const directNotes = currentId
    ? project.notes.filter(n => n.bubble_ids.includes(currentId))
    : project.notes.filter(n => n.bubble_ids.length === 0 || n.bubble_ids.includes(ROOT_BUBBLE_ID))

  const layoutItems = [
    ...visibleBubbles.map(b => {
      const noteCount = getNoteCountForBubble(project.notes, b.id, project.bubbles)
      const childBubbleCount = project.bubbles.filter(c => c.parent_id === b.id).length
      const descendantBubbleCount = getBubbleDescendantIds(project.bubbles, b.id).length - 1
      return {
        ...b, type: 'bubble', noteCount, childBubbleCount,
        contentCount: noteCount + descendantBubbleCount,
        // `locked` is the item's own flag (spread from b); `gated` is the effective
        // state including inherited locks and this session's unlocks.
        gated: lockIndex.gatedBubbleIds.has(b.id),
      }
    }),
    ...directNotes.map(n => ({
      ...n,
      type: 'note',
      color: '#a5b4fc',
      gated: lockIndex.gatedNoteIds.has(n.id),
    })),
  ]

  // Pagination trigger (computed before the single-page layout so it can be skipped
  // when paged). More items than fit one screen at the minimum size → paginate.
  const noteN = layoutItems.filter(i => i.type === 'note').length
  const bubbleN = layoutItems.length - noteN
  // Pure function of five numbers, and it runs two grid searches to get there — so it is
  // memoized on exactly those numbers rather than re-solved on every render.
  const {
    pageLoad, perPage, notesPerPage, bubblesPerPage, rawNotesPerPage, rawBubblesPerPage,
    usableW, noteCols, noteRows,
  } = useMemo(
    () => pageLoadFor(bubbleN, noteN, size.width, size.height, noteScale),
    [bubbleN, noteN, size.width, size.height, noteScale],
  )
  const paginated = size.width > 0 && pageLoad > 1

  // Single-page organic layout (skipped when paginated — each page lays out its own).
  const laid = (!paginated && size.width > 0)
    ? computeLayout(layoutItems, size.width, size.height, SUB_BAR_H, BOTTOM_PAD, noteScale, layoutSeed(currentId))
    : []

  // Apply saved positions on top of auto-layout
  const laidMapped = laid.map(item => {
    const key = posKey(project.id, currentId, item.id)
    const saved = savedPositions[key]
    if (saved && size.width > 0) {
      return { ...item, cx: saved.xFrac * size.width, cy: saved.yFrac * size.height }
    }
    return item
  })

  // If some items have saved positions and others don't, settle the new ones
  // into empty spots so they don't overlap existing placed items.
  const anchoredIds = new Set(
    laidMapped.filter(item => savedPositions[posKey(project.id, currentId, item.id)]).map(i => i.id)
  )
  // Mixed page with saved positions: flow the free notes around the bubbles' actual
  // (loaded) locations instead of just settling them off the phantom fresh layout.
  const arrangedAroundBubbles = (anchoredIds.size > 0 && size.width > 0)
    ? arrangeNotesAroundBubbles(laidMapped, anchoredIds, size.width, size.height)
    : null

  const laidSettled = (anchoredIds.size > 0 && anchoredIds.size < laidMapped.length && size.width > 0)
    ? settleItems(laidMapped, anchoredIds, size.width, size.height)
    : laidMapped

  // Final safety pass every render: separate any overlapping bubbles (with a small
  // buffer so they never touch) and re-apply the + button barrier and bounds.
  const laidWithOverrides = arrangedAroundBubbles ?? (size.width > 0
    ? separateOverlaps(laidSettled, size.width, size.height, shouldPinBubbles(laidSettled, anchoredIds.size))
    : laidSettled)

  // ── Pagination ────────────────────────────────────────────────────────────────
  // Each page keeps the SAME free-form organic layout + physics as the single-page
  // view — pagination only decides which page a bubble is on.
  let pages = []
  if (paginated) {
    // TEMP (swipe perf): performance.now rather than console.time — StrictMode runs this
    // body twice per commit and a repeated console.time label warns instead of timing.
    const t0 = DEBUG_SWIPE_PERF ? performance.now() : 0
    // Page ASSIGNMENT is a pure function of the item ids/types, the saved assignments and
    // the capacity — none of which a page change touches — so it is memoized on a
    // signature of exactly those. Only the id→page map is kept: the groups themselves are
    // rebuilt from the live item objects below, so nothing stale is ever rendered.
    let assignKey = `${project.id}|${currentId ?? 'root'}|${perPage}`
    for (const it of layoutItems) {
      assignKey += `|${it.id}:${it.type === 'note' ? 'n' : 'b'}`
      const p = savedPages[posKey(project.id, currentId, it.id)]
      if (Number.isInteger(p)) assignKey += `=${p}`
    }
    if (assignCacheRef.current.key !== assignKey) {
      assignCacheRef.current = {
        key: assignKey,
        pageOf: assignPages(layoutItems, savedPages, project.id, currentId, perPage),
      }
    }
    const pageOf = assignCacheRef.current.pageOf
    const numPages = Math.max(
      Math.ceil(layoutItems.length / perPage),
      ...layoutItems.map(it => (pageOf[it.id] ?? 0) + 1),
      1,
    )
    const groups = Array.from({ length: numPages }, () => [])
    for (const it of layoutItems) groups[pageOf[it.id] ?? 0].push(it)

    // Per-page layout cache. A page change re-runs this render body, but only the pages
    // whose own inputs moved need computeLayout / lloydSpread / separateOverlaps again —
    // and on a page change that is none of them. See pageLayoutKey for what counts as an
    // input; everything else about an item is re-merged onto the cached coordinates, so a
    // rename, a lock, an edited note body or a theme change costs nothing here.
    const cache = pageLayoutCacheRef.current
    let recomputed = 0
    pages = groups.map((group, pi) => {
      const key = pageLayoutKey(
        group, savedPositions, project.id, currentId,
        size.width, size.height, noteScale, layoutSeed(currentId, pi),
      )
      const hit = cache.get(pi)
      if (hit && hit.key === key) {
        // Same ids in the same order (the key says so), so this is a straight zip of the
        // live items onto their cached geometry — and it preserves the order layoutPage
        // returned, which is what `index` (float phase) and the drag loop both read.
        const byId = new Map(group.map(it => [it.id, it]))
        return hit.geom.map(g => ({ ...byId.get(g.id), cx: g.cx, cy: g.cy, r: g.r }))
      }
      recomputed++
      const laidPage = layoutPage(
        group, savedPositions, project.id, currentId,
        size.width, size.height, noteScale, layoutSeed(currentId, pi),
      )
      cache.set(pi, { key, geom: laidPage.map(p => ({ id: p.id, cx: p.cx, cy: p.cy, r: p.r })) })
      return laidPage
    })
    // Drop entries for pages that no longer exist, so a level that shrinks doesn't keep
    // paying for the pages it used to have.
    for (const pi of cache.keys()) if (pi >= groups.length) cache.delete(pi)
    if (DEBUG_SWIPE_PERF) {
      console.log(
        `[perf] layoutPages ${(performance.now() - t0).toFixed(1)}ms — ` +
        `${pages.length} pages, ${layoutItems.length} items ` +
        `(${bubbleN} bubbles + ${noteN} notes), ` +
        `${recomputed} recomputed / ${pages.length - recomputed} from cache`
      )
    }
  }
  const clampedPageIndex = pages.length > 0 ? Math.min(pageIndex, pages.length - 1) : 0

  // ── Capacity log ──────────────────────────────────────────────────────────────
  // Reports what each page was allowed to hold vs what it actually got, so the fill
  // target can be checked against a real device. Keyed on a signature so it prints
  // once per layout change rather than on every render (drag, theme, selection…).
  const pageFillSig = size.width > 0
    ? `${project.id}|${currentId ?? 'root'}|${size.width}x${size.height}|${noteScale}|` +
      (paginated ? pages.map(p => p.length).join(',') : `single:${layoutItems.length}`)
    : ''
  const lastFillLogRef = useRef('')
  useEffect(() => {
    if (!pageFillSig || lastFillLogRef.current === pageFillSig) return
    lastFillLogRef.current = pageFillSig
    const noteR = noteRFor(noteScale)
    const cap =
      `note size ${noteSize} (${noteScale}× → card ${Math.round(noteR * 2 * NOTE_HW)}×` +
      `${Math.round(noteR * 2 * NOTE_HH)}px, bubble floor r ${Math.round(minBubbleRFor(noteScale))}px) · ` +
      `usable ${Math.round(usableW ?? 0)}px wide → ${noteCols} across × ${noteRows} down = ` +
      `${(noteCols ?? 0) * (noteRows ?? 0)} cells · ` +
      `notes ${notesPerPage}/page (max ${rawNotesPerPage}), bubbles ${bubblesPerPage}/page ` +
      `(max ${rawBubblesPerPage}), blended perPage ${perPage}`
    if (!paginated) {
      console.log(
        `[bubble-pages] ${currentBubble?.name ?? 'root'}: 1 page (unpaginated), ` +
        `${layoutItems.length} items (${bubbleN} bubbles + ${noteN} notes) · ${cap} · fill target ${Math.round(PAGE_FILL * 100)}%`
      )
      return
    }
    const rows = pages.map((p, i) => {
      const b = p.filter(it => it.type !== 'note').length
      const nts = p.length - b
      // Share of the page's real (unfilled) capacity this page is using.
      const used = rawNotesPerPage > 0 && rawBubblesPerPage > 0
        ? nts / rawNotesPerPage + b / rawBubblesPerPage
        : 0
      return `page ${i}: ${p.length} items (${b} bubbles + ${nts} notes) = ${Math.round(used * 100)}% of max`
    })
    console.log(
      `[bubble-pages] ${currentBubble?.name ?? 'root'}: ${pages.length} pages, ` +
      `${layoutItems.length} items · ${cap} · fill target ${Math.round(PAGE_FILL * 100)}%\n  ` +
      rows.join('\n  ')
    )
  }, [pageFillSig]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Note-size repagination ────────────────────────────────────────────────────
  // Page capacity is derived from the user's note size, so changing that setting
  // changes how much fits on a page — immediately, for every level of the project,
  // not just the one on screen. Levels with no saved page assignments re-flow for
  // free (assignPages packs them against the new perPage on the render that follows
  // this one); the levels handled here are the ones the user has hand-arranged, whose
  // saved assignments would otherwise pin items to pages that no longer fit them.
  // See reflowSavedPages for the two rules. Items that land on a different page lose
  // their saved position too, so they settle into the new page's layout rather than
  // keeping coordinates chosen on the old one.
  const reflowedScaleRef = useRef(noteScale)
  useEffect(() => {
    if (reflowedScaleRef.current === noteScale) return
    reflowedScaleRef.current = noteScale
    const { width: W, height: H } = sizeRef.current
    if (W <= 0) return
    // Group this project's saved assignments by level.
    const levels = new Map() // contextKey → [ [itemId, page], … ]
    for (const [key, page] of Object.entries(savedPagesRef.current)) {
      if (!Number.isInteger(page)) continue
      const parts = splitPosKey(key, project.id)
      if (!parts) continue
      if (!levels.has(parts.contextKey)) levels.set(parts.contextKey, [])
      levels.get(parts.contextKey).push([parts.itemId, page])
    }
    const nextPages = { ...savedPagesRef.current }
    const nextPositions = { ...savedPositionsRef.current }
    let changed = false
    for (const [contextKey, entries] of levels) {
      const { bubbleN, noteN } = levelItemCounts(project, contextKey)
      const total = bubbleN + noteN
      if (total === 0) continue
      const { pageLoad: lvlLoad, perPage: lvlPerPage } =
        pageLoadFor(bubbleN, noteN, W, H, noteScale)
      // Unpaginated at this size: the level renders as a single page and its saved
      // assignments are dormant. Left as they are — if a later size brings pagination
      // back, this same pass re-flows them then.
      if (lvlLoad <= 1) continue
      const reflowed = reflowSavedPages(entries, lvlPerPage, total)
      for (const [itemId, oldPage] of entries) {
        if (reflowed[itemId] === oldPage) continue
        const key = posKey(project.id, contextKey === 'root' ? null : contextKey, itemId)
        nextPages[key] = reflowed[itemId]
        delete nextPositions[key]
        changed = true
      }
    }
    if (!changed) return
    // Batched with the assignment change, so the items this pass shuffles get their new
    // positions and the transition in one commit. (The resize itself is already covered
    // by scaleAnim — this only extends the window to cover the re-flow.)
    pulseLayoutAnim()
    setSavedPages(nextPages)
    setSavedPositions(nextPositions)
    saveSavedPagesMap(project.id, nextPages)
    saveSavedPositions(project.id, nextPositions)
  }, [noteScale]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep refs current (used in pointer handlers and RAF loop). In paged mode the
  // "current layout" is the visible page's items (drag physics operate on these).
  laidWithOverridesRef.current = paginated ? (pages[clampedPageIndex] || []) : laidWithOverrides
  currentIdRef.current = currentId
  pagesRef.current = pages
  perPageRef.current = perPage
  paginatedRef.current = paginated

  // Snap the page track on structural changes (resize, page count, entering paged mode).
  useLayoutEffect(() => {
    pageX.set(-pageIndexRef.current * size.width)
  }, [size.width, pages.length, paginated]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clamp the current page if the number of pages shrinks.
  useEffect(() => {
    if (pages.length > 0 && pageIndex > pages.length - 1) setPageIndex(pages.length - 1)
  }, [pages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // TEMP (swipe perf): closes the timer animateToPage opened, once the commit it caused
  // has been applied to the DOM.
  useLayoutEffect(() => {
    if (!DEBUG_SWIPE_PERF || !pageChangeTimingRef.current) return
    pageChangeTimingRef.current = false
    console.timeEnd('[perf] pageChange→commit')
  }, [pageIndex])

  // ── Placing a just-created bubble ─────────────────────────────────────────────
  //
  // A bubble made from the + button should land where the user is looking. Without an
  // assignment it is packed onto the first page with room, which on a multi-page level
  // is rarely the page on screen — so pin it to the current page, or to the next one
  // when this page is full, and follow it there so the thing they just named is what
  // they see. Nothing is written for an unpaginated level: there is only one page, and
  // the layout already settles a position-less item into a free spot without overlap.
  //
  // Runs before paint, so the bubble is never seen on the wrong page first. Guarded by
  // id, since the command prop stays set until the next bubble is created.
  //
  // Assigning and following are two passes: a page that doesn't exist yet is only
  // brought into being by the assignment, and animateToPage clamps to the pages that
  // exist when it is called. So the target is parked here and taken on the re-render
  // the assignment causes — which React runs before paint, this being a layout effect.
  const placedRef = useRef(null)
  const followPageRef = useRef(null)
  useLayoutEffect(() => {
    if (followPageRef.current != null && followPageRef.current <= pages.length - 1) {
      const target = followPageRef.current
      followPageRef.current = null
      animateToPage(target)
      return
    }
    if (!placeBubbleId || placedRef.current === placeBubbleId) return
    // Not on this level (they navigated away as it was created) — leave it alone.
    if (!layoutItems.some(it => it.id === placeBubbleId)) return
    placedRef.current = placeBubbleId
    if (!paginated) return

    const from = Math.min(pageIndexRef.current, Math.max(pages.length - 1, 0))
    // At capacity by the same measure the packer uses for a page's items. Counting
    // everything, not just bubbles, is the stricter reading: it won't drop a bubble
    // onto a page already filled edge to edge with notes.
    const full = (pages[from]?.length ?? 0) >= perPage
    const target = full ? from + 1 : from

    const nextPages = { ...savedPagesRef.current, [posKey(project.id, currentId, placeBubbleId)]: target }
    setSavedPages(nextPages)
    saveSavedPagesMap(project.id, nextPages)
    if (target !== from) followPageRef.current = target
  }, [placeBubbleId, layoutItems, paginated, pages, perPage, currentId, project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigation ────────────────────────────────────────────────────────────────

  function handleBubbleClick(item) {
    if (expandAnim || navTimerRef.current) return
    // Use laidWithOverridesRef so click origin reflects current display position
    const laidItem = laidWithOverridesRef.current.find(l => l.id === item.id)
    if (!laidItem) return

    setNavDir('in')

    // Hide original bubble and start expanding it to fill screen
    setExpandAnim({
      phase: 'in',
      id: item.id,
      cx: laidItem.cx,
      cy: laidItem.cy,
      r: laidItem.r,
      color: laidItem.color,
    })

    // Navigate midway through the expand animation; store position for zoom-out later
    const pendingItem = {
      id: item.id,
      name: item.name,
      color: item.color,
      cx: laidItem.cx,
      cy: laidItem.cy,
      r: laidItem.r,
    }
    navTimerRef.current = setTimeout(() => {
      setNavStack(s => [...s, pendingItem])
      navTimerRef.current = null
    }, 200)
  }

  function handleExpandDone() {
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current)
      navTimerRef.current = null
    }
    setExpandAnim(null)
  }

  // Navigate back to `depth` levels of nesting (0 = the project root) with the
  // standard zoom-out. The panel shrinks into navStack[depth] — the bubble that was
  // opened FROM the destination level — whose stored position belongs to that
  // level's layout. That makes one back step and a multi-level breadcrumb jump the
  // same animation: the deeper levels in between are simply never drawn.
  function zoomOutTo(depth) {
    if (expandAnim || navTimerRef.current) return
    // depth >= navStack.length means the current level (or deeper) — nothing to do.
    if (depth < 0 || depth >= navStack.length) return

    const exiting = navStack[depth]
    setNavDir('out')
    // Pop navStack immediately — parent view renders with bubble hidden
    setNavStack(s => s.slice(0, depth))
    setSwipeOffset(0)

    // Shrink the full-screen view back to the bubble's stored position. Levels opened
    // from the sidebar have no recorded geometry, so those fall back to the plain
    // directional page transition.
    if (exiting.cx !== undefined) {
      setExpandAnim({
        phase: 'out',
        id: exiting.id,
        cx: exiting.cx,
        cy: exiting.cy,
        r: exiting.r,
        color: exiting.color,
      })
    }
  }

  // The back arrow and the edge-swipe gesture: exactly one level up.
  function zoomOut() {
    zoomOutTo(navStack.length - 1)
  }
  // Keep ref current so the native touch handler can call the latest zoomOut
  zoomOutRef.current = zoomOut

  // Escape inside a nested bubble goes up one level with the same zoom-out. It only
  // registers while there IS a level to leave, so at the root the press falls through
  // to whatever else is open (or does nothing).
  useEscapeLayer(navStack.length > 0, zoomOut, ESC_LEVEL.base)
  // The long-press menu is drawn over the canvas, so it takes the press first.
  useEscapeLayer(!!lockMenu, closeLockMenu, ESC_LEVEL.popup)

  // ── Reorganize the current level ────────────────────────────────────────────
  // Drop the saved manual positions + page assignments for THIS level only, so it
  // re-flows from scratch with the auto-layout at the current note size (bigger notes
  // cram a hand-arranged page — this un-crams it without touching other levels).
  function reorganizeLevel() {
    const cId = currentIdRef.current
    const prefix = `${project.id}:${cId ?? 'root'}:`
    const keep = (obj) => Object.fromEntries(
      Object.entries(obj).filter(([k]) => !k.startsWith(prefix))
    )
    const newPositions = keep(savedPositionsRef.current)
    const newPages = keep(savedPagesRef.current)
    setSavedPositions(newPositions)
    setSavedPages(newPages)
    setPageIndex(0)
    pageIndexRef.current = 0
    pageX.set(0)
    saveSavedPositions(project.id, newPositions)
    saveSavedPagesMap(project.id, newPages)
    pulseLayoutAnim()
  }
  // Only meaningful when this level has a hand-arranged layout to reset.
  const levelPrefix = `${project.id}:${currentId ?? 'root'}:`
  const hasManualLayout =
    Object.keys(savedPositions).some(k => k.startsWith(levelPrefix)) ||
    Object.keys(savedPages).some(k => k.startsWith(levelPrefix))

  // ── Paged interactions (swipe between pages + drag with cross-page move) ───────
  function animateToPage(idx) {
    const clamped = Math.max(0, Math.min(idx, pagesRef.current.length - 1))
    // TEMP (swipe perf): opened here and closed in the layout effect below, so it spans
    // the state change AND the render + commit it causes — which is where the page
    // layout is recomputed.
    if (DEBUG_SWIPE_PERF && clamped !== pageIndexRef.current) {
      console.time('[perf] pageChange→commit')
      pageChangeTimingRef.current = true
    }
    pageIndexRef.current = clamped
    setPageIndex(clamped)
    // Floats resume once the track has actually come to rest, not the moment the finger
    // lifts — the settle spring is the tail of the swipe and wants the frames too. The
    // token guards against a stale completion (a new gesture started mid-settle) clearing
    // the pause the new gesture has just set.
    const token = ++swipeSettleRef.current
    animate(pageX, -clamped * sizeRef.current.width, {
      type: 'spring', stiffness: 320, damping: 34,
      onComplete: () => { if (swipeSettleRef.current === token) setSwiping(false) },
    })
  }

  const clearAllDragTransforms = () => {
    containerRef.current?.querySelectorAll('[data-item-id]').forEach(el => {
      el.style.transition = ''; el.style.transform = ''; el.style.zIndex = ''
    })
  }

  // Abandon an in-flight drag without saving. Safe because the menu only opens when
  // the pointer never moved, so the item is still exactly where it started.
  function cancelActiveDrag() {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
    if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null }
    dragActivatedRef.current = false
    pendingPointerRef.current = null
    dragInfoRef.current = null
    resolvedDragPosRef.current = null
    resolvedAllPosRef.current = []
    clearAllDragTransforms()
    setDraggingId(null)
  }

  function openLockMenu(item, clientX, clientY) {
    cancelActiveDrag()
    menuOpenedRef.current = true
    navigator.vibrate?.(15)
    const rect = containerRef.current?.getBoundingClientRect()
    setLockMenu({
      item,
      x: clientX - (rect?.left ?? 0),
      y: clientY - (rect?.top ?? 0),
    })
  }

  function closeLockMenu() { setLockMenu(null) }

  // The menu shows a stale snapshot of the item after a lock toggle, so it always
  // closes on action. Navigating or switching project drops it too.
  useEffect(() => { setLockMenu(null) }, [project.id, navStack, selectMode])

  function onPagedPointerDown(e) {
    if (!paginatedRef.current || expandAnim || navTimerRef.current) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const localX = e.clientX - rect.left
    const localY = e.clientY - rect.top
    if (localX < 28 && navStackRef.current.length > 0) return // leave edge for back-swipe
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const pageItems = pagesRef.current[pageIndexRef.current] || []
    // Box hit test — every item, note card and bubble alike, is a rectangle on screen.
    const hit = pageItems.find(item =>
      Math.abs(localX - item.cx) <= halfWidthOf(item) &&
      Math.abs(localY - item.cy) <= halfHeightOf(item))
    const st = { mode: 'pending', startX: e.clientX, startY: e.clientY, itemId: hit?.id ?? null, lpTimer: null }
    pagedRef.current = st
    if (DEBUG_SWIPE_PERF) {
      // TEMP (swipe perf): what is actually on screen when the gesture starts. Counts the
      // whole container — which now holds only the mounted window of pages, so the item
      // count should track the visible page rather than the whole level.
      swipeSamplesRef.current = { n: 0, total: 0, max: 0 }
      const root = containerRef.current
      const total = pagesRef.current.length
      const mounted = Math.min(total, pageIndexRef.current === 0 || pageIndexRef.current === total - 1 ? 2 : 3)
      console.log(
        `[perf] swipe start — ${root?.querySelectorAll('*').length ?? 0} DOM nodes in the ` +
        `bubble container, ${root?.querySelectorAll('[data-item-id]').length ?? 0} items ` +
        `across ${mounted} mounted of ${total} pages ` +
        `(page ${pageIndexRef.current} visible, ${(pagesRef.current[pageIndexRef.current] || []).length} items on it)`
      )
    }
    pageX.stop()
    if (hit && !selectModeRef.current) {
      // Press-and-hold to pick a bubble up — it then drags with the SAME free-form
      // physics (collision resolution, pushing, saving) as the single-page view.
      st.lpTimer = setTimeout(() => {
        if (pagedRef.current !== st || st.mode !== 'pending') return
        st.mode = 'drag'
        navigator.vibrate?.(40)
        const slot = (pagesRef.current[pageIndexRef.current] || []).find(it => it.id === hit.id) || hit
        dragInfoRef.current = { id: slot.id, type: slot.type, cx: slot.cx, cy: slot.cy, r: slot.r }
        setDraggingId(hit.id)
        dragRafRef.current = requestAnimationFrame(runDragFrame)
      }, 220)

      // Keep holding without moving and the pick-up gives way to the item's menu.
      const menuX = e.clientX, menuY = e.clientY
      st.menuTimer = setTimeout(() => {
        if (pagedRef.current !== st) return
        st.menuTimer = null
        if (st.lpTimer) { clearTimeout(st.lpTimer); st.lpTimer = null }
        st.mode = 'menu'
        if (st.edgeSide) { st.edgeSide = null; setEdgeGlow(null) }
        const slot = (pagesRef.current[pageIndexRef.current] || []).find(it => it.id === hit.id) || hit
        openLockMenu(slot, menuX, menuY)
      }, LONG_PRESS_MENU_MS)
    }
  }

  function onPagedPointerMove(e) {
    const st = pagedRef.current
    if (!st) return
    if (st.mode === 'menu') return
    // TEMP (swipe perf): times this handler only. Per-move logging would flood a 120Hz
    // touch stream, so the samples are accumulated and reported once on release.
    const tMove = DEBUG_SWIPE_PERF ? performance.now() : 0
    try {
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    // Moved at all → this press is a swipe or a drag, never a menu.
    if (st.menuTimer && Math.hypot(dx, dy) > 8) {
      clearTimeout(st.menuTimer)
      st.menuTimer = null
    }
    const { width: W, height: H } = sizeRef.current
    if (st.mode === 'pending') {
      if (Math.hypot(dx, dy) <= 8) return
      if (st.lpTimer) { clearTimeout(st.lpTimer); st.lpTimer = null }
      st.mode = 'swipe' // moved before the long-press fired → treat as a page swipe
      // Hold every float still for the duration of the gesture (see `swiping`).
      swipeSettleRef.current++
      setSwiping(true)
    }
    if (st.mode === 'swipe') {
      let base = -pageIndexRef.current * W + dx
      const min = -(pagesRef.current.length - 1) * W, max = 0
      if (base > max) base = max + (base - max) * 0.35
      if (base < min) base = min + (base - min) * 0.35
      pageX.set(base)
    } else if (st.mode === 'drag') {
      // Feed the pointer into the RAF physics loop (same as single-page dragging).
      const drag = dragInfoRef.current
      if (!drag) return
      // The container rect is read HERE, not at the top of the handler: it is a forced
      // layout read, and only this branch (and the edge glow below it) needs local
      // coordinates. On the swipe path — the one that has to keep up with a 120Hz touch
      // stream — the handler now touches no layout at all.
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      const dhw = halfWidthOf(drag), dhh = halfHeightOf(drag)
      dragInfoRef.current = {
        ...drag,
        cx: Math.max(dhw + 12, Math.min(W - dhw - 12, localX)),
        cy: Math.max(SUB_BAR_H + dhh + 12, Math.min(H - BOTTOM_PAD - dhh, localY)),
      }
      // Highlight the edge when hovering over one that has an adjacent page to move to.
      const cur = pageIndexRef.current
      const side = (localX < 44 && cur > 0) ? 'left'
        : (localX > W - 44 && cur < pagesRef.current.length - 1) ? 'right' : null
      if (side !== st.edgeSide) { st.edgeSide = side; setEdgeGlow(side) } // only re-render on change
    }
    } finally {
      if (DEBUG_SWIPE_PERF) {
        const ms = performance.now() - tMove
        const s = swipeSamplesRef.current
        s.n++
        s.total += ms
        if (ms > s.max) s.max = ms
      }
    }
  }

  function onPagedPointerUp(e) {
    const st = pagedRef.current
    if (!st) return
    if (DEBUG_SWIPE_PERF) {
      const s = swipeSamplesRef.current
      if (s.n) {
        console.log(
          `[perf] swipe handler — ${s.n} moves, ${s.total.toFixed(1)}ms total, ` +
          `${(s.total / s.n).toFixed(2)}ms avg, ${s.max.toFixed(2)}ms worst ` +
          `(handler only; excludes the paint/composite each move triggers)`
        )
      }
    }
    pagedRef.current = null
    // Anything that isn't a swipe releases the float pause here: only the swipe path
    // ends in animateToPage, whose settle completion is what normally resumes them.
    if (st.mode !== 'swipe') { swipeSettleRef.current++; setSwiping(false) }
    if (st.lpTimer) { clearTimeout(st.lpTimer); st.lpTimer = null }
    if (st.menuTimer) { clearTimeout(st.menuTimer); st.menuTimer = null }
    if (st.edgeSide) setEdgeGlow(null)
    // The menu already consumed this press (the drag was cancelled when it opened).
    if (st.mode === 'menu') { menuOpenedRef.current = false; return }
    const rect = containerRef.current?.getBoundingClientRect()
    const localX = rect ? e.clientX - rect.left : 0
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    const { width: W, height: H } = sizeRef.current

    if (st.mode === 'drag') {
      if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null }
      const draggedId = st.itemId
      const curPage = pageIndexRef.current
      let targetPage = curPage
      if (localX < 44 && curPage > 0) targetPage = curPage - 1
      else if (localX > W - 44 && curPage < pagesRef.current.length - 1) targetPage = curPage + 1
      const lastResolved = resolvedAllPosRef.current
      const cId = currentIdRef.current

      if (targetPage !== curPage && W > 0) {
        // Cross-page move: reassign the bubble's page, then clear the saved positions
        // of both the source and destination pages so each recalculates from scratch.
        const key = posKey(project.id, cId, draggedId)
        const newPages = { ...savedPagesRef.current, [key]: targetPage }
        const newPositions = { ...savedPositionsRef.current }
        delete newPositions[key]
        for (const it of (pagesRef.current[curPage] || [])) if (it.id !== draggedId) delete newPositions[posKey(project.id, cId, it.id)]
        for (const it of (pagesRef.current[targetPage] || [])) delete newPositions[posKey(project.id, cId, it.id)]
        if (layoutAnimTimerRef.current) clearTimeout(layoutAnimTimerRef.current)
        flushSync(() => {
          setSavedPages(newPages)
          setSavedPositions(newPositions)
          setDraggingId(null)
          setLayoutAnim(true)
        })
        containerRef.current?.querySelectorAll('[data-item-id]').forEach(el => { el.style.transform = ''; el.style.zIndex = '' })
        saveSavedPagesMap(project.id, newPages)
        saveSavedPositions(project.id, newPositions)
        animateToPage(targetPage)
        layoutAnimTimerRef.current = setTimeout(() => setLayoutAnim(false), 420)
      } else if (W > 0 && lastResolved.length) {
        // Same-page drop: save every current-page item where it settled (jump-free).
        const final = resolveCollisions(lastResolved, '__none__', 0, 0, W, H)
        const newPositions = { ...savedPositionsRef.current }
        final.forEach(p => { newPositions[posKey(project.id, cId, p.id)] = { xFrac: p.cx / W, yFrac: p.cy / H } })
        flushSync(() => { setSavedPositions(newPositions); setDraggingId(null); setLayoutAnim(false) })
        clearAllDragTransforms()
        saveSavedPositions(project.id, newPositions)
      } else {
        clearAllDragTransforms()
        setDraggingId(null)
      }
      dragInfoRef.current = null
      resolvedDragPosRef.current = null
      resolvedAllPosRef.current = []
      return
    }
    if (st.mode === 'swipe') {
      if (dx < -0.3 * W) animateToPage(pageIndexRef.current + 1)
      else if (dx > 0.3 * W) animateToPage(pageIndexRef.current - 1)
      else animateToPage(pageIndexRef.current)
      return
    }
    // Tap (no significant move) → toggle in select mode, else navigate / open.
    if (st.itemId != null && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const item = (pagesRef.current[pageIndexRef.current] || []).find(it => it.id === st.itemId)
      if (item) {
        if (selectModeRef.current) toggleSelectItem(item.id)
        else if (gateTap(item)) { /* locked — password prompt opened instead */ }
        else item.type === 'bubble' ? handleBubbleClick(item) : onSelectNote(item)
      }
    }
  }

  // ── RAF drag loop — mutates DOM directly, zero React re-renders per frame ──────

  function runDragFrame() {
    const drag = dragInfoRef.current
    if (!drag || !containerRef.current) return

    const { width, height } = sizeRef.current
    const laid = laidWithOverridesRef.current

    // Full iterative collision resolution — no overlaps, chain reactions, boundary blocking
    const resolved = resolveCollisions(laid, drag.id, drag.cx, drag.cy, width, height)

    // Track all resolved positions (for saving on drop) and dragged item's final position
    resolvedAllPosRef.current = resolved
    const rdp = resolved.find(p => p.isDragged)
    if (rdp) resolvedDragPosRef.current = { cx: rdp.cx, cy: rdp.cy }

    // Build element map in one DOM walk
    const nodeList = containerRef.current.querySelectorAll('[data-item-id]')
    const elMap = {}
    nodeList.forEach(el => { elMap[el.dataset.itemId] = el })

    laid.forEach((item, i) => {
      const el = elMap[item.id]
      if (!el) return
      const rp = resolved[i]
      if (!rp) return

      const tx = rp.cx - item.cx
      const ty = rp.cy - item.cy

      if (item.id === drag.id) {
        // Dragged item follows pointer (or wall) — no CSS transition
        el.style.transition = 'none'
      } else {
        // Non-dragged items animate smoothly into their pushed positions
        el.style.transition = 'transform 80ms linear'
      }
      el.style.transform = (tx !== 0 || ty !== 0) ? `translate(${tx}px,${ty}px)` : ''
    })

    dragRafRef.current = requestAnimationFrame(runDragFrame)
  }

  // ── Drag pointer handlers ─────────────────────────────────────────────────────

  function handlePointerDown(e) {
    if (e.pointerType === 'touch' && e.isPrimary === false) return
    if (expandAnim || navTimerRef.current) return
    if (paginatedRef.current) return // paged mode uses its own pointer handlers

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    // Hit test against current layout positions — every item is a rectangle on screen.
    const hit = laidWithOverridesRef.current.find(item =>
      Math.abs(x - item.cx) <= halfWidthOf(item) &&
      Math.abs(y - item.cy) <= halfHeightOf(item))
    if (!hit) return

    // Drop any menu timer left over from a previous press (e.g. a second finger).
    if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null }

    pendingPointerRef.current = { item: hit, startClientX: e.clientX, startClientY: e.clientY }
    dragActivatedRef.current = false

    // In select mode a press never becomes a drag — pointer-up toggles the item instead.
    if (selectModeRef.current) return

    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      dragActivatedRef.current = true
      navigator.vibrate?.(40)
      const currentHit = laidWithOverridesRef.current.find(i => i.id === hit.id) || hit
      dragInfoRef.current = { id: currentHit.id, type: currentHit.type, cx: currentHit.cx, cy: currentHit.cy, r: currentHit.r }
      setDraggingId(currentHit.id)
      dragRafRef.current = requestAnimationFrame(runDragFrame)
    }, 100)

    // Held in place (never moved) → give up the drag and open the item's menu.
    const menuX = e.clientX, menuY = e.clientY
    menuTimerRef.current = setTimeout(() => {
      menuTimerRef.current = null
      const currentHit = laidWithOverridesRef.current.find(i => i.id === hit.id) || hit
      openLockMenu(currentHit, menuX, menuY)
    }, LONG_PRESS_MENU_MS)
  }

  function handlePointerMove(e) {
    // Any real movement means the press is a drag, not a menu.
    if (menuTimerRef.current && pendingPointerRef.current) {
      const mdx = e.clientX - pendingPointerRef.current.startClientX
      const mdy = e.clientY - pendingPointerRef.current.startClientY
      if (Math.hypot(mdx, mdy) > 9) {
        clearTimeout(menuTimerRef.current)
        menuTimerRef.current = null
      }
    }
    // Cancel long press if finger moved significantly before threshold
    if (pendingPointerRef.current && !dragActivatedRef.current) {
      const dx = e.clientX - pendingPointerRef.current.startClientX
      const dy = e.clientY - pendingPointerRef.current.startClientY
      if (Math.hypot(dx, dy) > 9) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
        pendingPointerRef.current = null
        return
      }
    }
    if (!dragActivatedRef.current) return

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const drag = dragInfoRef.current
    if (!drag) return
    const { width, height } = sizeRef.current

    // Update mutable ref only — RAF loop will pick it up next frame
    const dhw = halfWidthOf(drag), dhh = halfHeightOf(drag)
    dragInfoRef.current = {
      ...drag,
      cx: Math.max(dhw + 12, Math.min(width - dhw - 12, e.clientX - rect.left)),
      cy: Math.max(SUB_BAR_H + dhh + 12, Math.min(height - BOTTOM_PAD - dhh, e.clientY - rect.top)),
    }
  }

  function handlePointerUp() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    if (menuTimerRef.current) {
      clearTimeout(menuTimerRef.current)
      menuTimerRef.current = null
    }
    // The press that opened the menu must not also count as a tap.
    if (menuOpenedRef.current) {
      menuOpenedRef.current = false
      pendingPointerRef.current = null
      dragActivatedRef.current = false
      return
    }

    const wasDrag = dragActivatedRef.current
    const pending = pendingPointerRef.current
    dragActivatedRef.current = false
    pendingPointerRef.current = null

    if (wasDrag) {
      // Stop RAF loop
      if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null }

      const { width, height } = sizeRef.current
      const lastResolved = resolvedAllPosRef.current

      if (width > 0 && lastResolved.length > 0) {
        // Post-drop: run one final collision pass with ALL items free (no dragged item)
        // so any remaining overlaps from the drop are cleaned up.
        const finalResolved = resolveCollisions(lastResolved, '__none__', 0, 0, width, height)

        // Save positions of ALL items — non-dragged bubbles stay exactly where they were pushed
        const newPositions = { ...savedPositionsRef.current }
        finalResolved.forEach(p => {
          newPositions[posKey(project.id, currentIdRef.current, p.id)] = {
            xFrac: p.cx / width,
            yFrac: p.cy / height,
          }
        })

        // Force React to update left/top synchronously BEFORE we clear transforms,
        // so the visual position never changes (new left/top = old left/top + old transform).
        flushSync(() => {
          setSavedPositions(newPositions)
          setDraggingId(null)
        })

        // Now safe to clear: React has already moved left/top to the resolved positions
        if (containerRef.current) {
          containerRef.current.querySelectorAll('[data-item-id]').forEach(el => {
            el.style.transition = ''
            el.style.transform = ''
          })
        }

        saveSavedPositions(project.id, newPositions)
      } else {
        // Fallback (no RAF frames ran): save only the dragged item's position
        const drag = dragInfoRef.current
        const finalPos = resolvedDragPosRef.current || (drag ? { cx: drag.cx, cy: drag.cy } : null)
        if (drag && finalPos && width > 0) {
          const newPositions = {
            ...savedPositionsRef.current,
            [posKey(project.id, currentIdRef.current, drag.id)]: {
              xFrac: finalPos.cx / width, yFrac: finalPos.cy / height,
            },
          }
          flushSync(() => { setSavedPositions(newPositions); setDraggingId(null) })
          if (containerRef.current) {
            containerRef.current.querySelectorAll('[data-item-id]').forEach(el => { el.style.transition = ''; el.style.transform = '' })
          }
          saveSavedPositions(project.id, newPositions)
        } else {
          if (containerRef.current) {
            containerRef.current.querySelectorAll('[data-item-id]').forEach(el => { el.style.transition = ''; el.style.transform = '' })
          }
          setDraggingId(null)
        }
      }

      dragInfoRef.current = null
      resolvedDragPosRef.current = null
      resolvedAllPosRef.current = []
    } else if (pending) {
      // Was a tap — toggle selection in select mode, otherwise open/navigate.
      const { item } = pending
      if (selectModeRef.current) {
        toggleSelectItem(item.id)
      } else if (gateTap(item)) {
        // Locked — the password prompt takes the tap.
      } else if (item.type === 'bubble') {
        handleBubbleClick(item)
      } else {
        onSelectNote(item)
      }
    }
  }

  const rgb = currentBubble ? hexToRgb(currentBubble.color) : '99,102,241'
  const navKey = navStack.map(n => n.id).join('/') || 'root'

  const swipeTransition = swipeRef.current.active
    ? 'none'
    : 'transform 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94)'

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        // Background bleeds through the bottom safe area (border-box padding);
        // the layout subtracts this padding so bubbles stay above the home indicator.
        paddingBottom: 'env(safe-area-inset-bottom)',
        overflow: 'hidden',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        background: isLight
          ? `radial-gradient(ellipse at 50% 30%, rgba(${rgb},0.10) 0%, #F5F5F0 40%, #E8E8E2 100%)`
          : `radial-gradient(ellipse at 55% 30%, rgba(${rgb},0.18) 0%, #141414 45%, #1C1C1E 100%)`,
        transition: 'background 0.6s ease-in-out',
      }}
    >
      {/* ── Sub-bar: breadcrumb (left) + view toggle (right) ─────────────────── */}
      <div
        className="absolute top-0 left-0 right-0 z-10"
        style={{ height: SUB_BAR_H }}
      >
        <div className="px-4 md:px-6 h-full flex items-center justify-between">
        {selectMode ? (
          <>
            <span className="text-sm font-semibold text-white/90">
              {selectedIds.size} selected
            </span>
            <button
              onClick={exitSelect}
              className="text-sm font-medium text-white/50 hover:text-white/90 transition-colors flex-shrink-0"
            >
              Cancel
            </button>
          </>
        ) : (
        <>
        {/* Breadcrumb — back arrow + text sit tight to the left edge */}
        <div className="flex items-center gap-0.5 min-w-0 flex-1 mr-3">
          <button
            onClick={navStack.length > 0 ? zoomOut : undefined}
            className="flex-shrink-0 p-1 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors"
            style={{ visibility: navStack.length > 0 ? 'visible' : 'hidden' }}
            aria-label="Go back"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          {/* Every breadcrumb segment goes through zoomOutTo, so tapping the parent
              level animates exactly like the back arrow. The root segment is depth 0;
              segment i sits at depth i + 1. */}
          <button
            onClick={() => zoomOutTo(0)}
            className={`text-sm transition-colors flex-shrink-0 truncate ${
              navStack.length === 0 ? 'text-white/80 font-semibold' : 'text-white/40 hover:text-white/70'
            }`}
            style={{ maxWidth: 120 }}
          >
            {project.name}
          </button>
          {navStack.map((item, i) => (
            <span key={item.id} className="flex items-center gap-0.5 min-w-0">
              <span className="text-white/25 text-xs flex-shrink-0 px-0.5">›</span>
              <button
                onClick={() => zoomOutTo(i + 1)}
                className={`text-sm transition-colors truncate ${
                  i === navStack.length - 1
                    ? 'text-white/80 font-semibold'
                    : 'text-white/40 hover:text-white/65'
                }`}
                style={{ maxWidth: i === navStack.length - 1 ? 140 : 72 }}
              >
                {item.name}
              </button>
            </span>
          ))}
        </div>

        {/* Right cluster: reorganize + select + view toggle */}
        <div className="flex items-center gap-2 flex-shrink-0">
        {hasManualLayout && layoutItems.length > 1 && (
          <button
            onClick={reorganizeLevel}
            className="p-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors"
            aria-label="Reorganize layout"
            title="Reorganize layout"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="4" y="4" width="7" height="7" rx="1.5" strokeWidth={2} />
              <rect x="13" y="4" width="7" height="7" rx="1.5" strokeWidth={2} />
              <rect x="4" y="13" width="7" height="7" rx="1.5" strokeWidth={2} />
              <rect x="13" y="13" width="7" height="7" rx="1.5" strokeWidth={2} />
            </svg>
          </button>
        )}
        <button
          onClick={() => setSelectMode(true)}
          className="p-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors"
          aria-label="Select items"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
        </button>
        {/* View toggle */}
        <div
          className="flex rounded-xl overflow-hidden"
          style={{ background: 'var(--hover)', border: '1px solid var(--border)' }}
        >
          {[
            {
              id: 'bubble',
              icon: (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <circle cx="12" cy="12" r="4" strokeWidth={2} />
                  <circle cx="12" cy="12" r="9" strokeWidth={1.5} strokeDasharray="3 2" />
                </svg>
              ),
            },
            {
              id: 'chronological',
              icon: (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              ),
            },
          ].map(m => (
            <button
              key={m.id}
              onClick={() => onSetViewMode(m.id)}
              className={`px-3 py-1.5 transition-colors ${
                viewMode === m.id ? 'bg-white/20 text-white' : 'text-white/45 hover:text-white/80'
              }`}
            >
              {m.icon}
            </button>
          ))}
        </div>
        </div>{/* end right cluster */}
        </>
        )}
        </div>{/* end sub-bar row */}
      </div>

      {/* ── Swipe offset wrapper ──────────────────────────────────────────────── */}
      <div
        className="absolute inset-0"
        style={{ transform: `translateX(${swipeOffset}px)`, transition: swipeTransition }}
      >
        {/* ── Directional page transitions ──────────────────────────────────── */}
        <AnimatePresence mode="sync" custom={navDir}>
          <motion.div
            key={navKey}
            className="absolute inset-0"
            custom={navDir}
            variants={pageVariants}
            // Skip entry/exit scale animation during zoom — ZoomExpand handles it visually
            initial={expandAnim ? false : 'initial'}
            animate="animate"
            exit={expandAnim ? { opacity: 1, transition: { duration: 0 } } : 'exit'}
            transition={{ type: 'spring', stiffness: 300, damping: 30, restDelta: 0.001 }}
          >
            <div className="absolute inset-0">
              {/* Subtle level label */}
              {currentBubble && (
                <div
                  className="absolute left-0 right-0 text-center pointer-events-none select-none"
                  style={{ top: SUB_BAR_H + 10 }}
                >
                  <span
                    className="text-xs font-semibold uppercase tracking-widest"
                    style={{ color: isLight ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.15)' }}
                  >
                    {currentBubble.name}
                  </span>
                </div>
              )}

              {/* Empty state (paged mode always has items) */}
              {!paginated && laid.length === 0 && !expandAnim && (
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ paddingTop: SUB_BAR_H }}
                >
                  <motion.div
                    className="text-center"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <div className="text-4xl mb-3 opacity-20">○</div>
                    <p className="text-white/25 text-sm font-medium">Nothing here yet</p>
                    <p className="text-white/15 text-xs mt-1">
                      {currentId ? 'Tap + to add a note' : 'Open the sidebar to add a bubble'}
                    </p>
                  </motion.div>
                </div>
              )}

              {paginated ? (
                /* ── Paged bubbles: horizontal swipe between full pages ────────── */
                <div
                  className="absolute inset-0"
                  style={{ overflow: 'hidden', touchAction: 'none' }}
                  onPointerDown={onPagedPointerDown}
                  onPointerMove={onPagedPointerMove}
                  onPointerUp={onPagedPointerUp}
                  onPointerCancel={onPagedPointerUp}
                >
                  {/* Only the current page and its immediate neighbours are mounted.
                      A swipe moves exactly one page (animateToPage clamps to ±1 from
                      the release), so those three are all a gesture can ever bring into
                      view — and the neighbour is already mounted when the finger lands,
                      which is what keeps the incoming page from flashing in blank.
                      Everything further out unmounts, so the DOM now costs what the
                      visible page holds rather than what the whole level does.

                      Pages are positioned by index instead of flowed in a flex row:
                      an unmounted page must not shift the ones after it, and the track's
                      x-translation is -pageIndex * width, which assumes page `pi` sits at
                      exactly pi * width. */}
                  <motion.div style={{ x: pageX, position: 'relative', height: '100%', width: pages.length * size.width }}>
                    <BubbleNameFontScope liveIds={levelBubbleIds}>
                    {pages.map((pageItems, pi) => {
                      if (Math.abs(pi - clampedPageIndex) > 1) return null
                      // The idle bob runs on the current page only, and stops on every
                      // page for the length of a swipe.
                      const floating = pi === clampedPageIndex && !swiping
                      return (
                      <div key={pi} style={{ position: 'absolute', left: pi * size.width, top: 0, width: size.width, height: '100%' }}>
                        {pageItems.map((item, i) =>
                          item.type === 'note' ? (
                            <NoteCard
                              key={`${item.id}-${theme}`}
                              item={item}
                              index={i % 6}
                              customTagColors={project.customTagColors || {}}
                              isDragging={draggingId === item.id}
                              animateLayout={animatingLayout && draggingId !== item.id}
                              floating={floating}
                              selectable={selectMode}
                              selected={selectedIds.has(item.id)}
                            />
                          ) : (
                            <BubbleCircle
                              key={`${item.id}-${theme}`}
                              item={item}
                              index={i % 6}
                              hidden={expandAnim?.id === item.id}
                              isDragging={draggingId === item.id}
                              animateLayout={animatingLayout && draggingId !== item.id}
                              floating={floating}
                              selectable={selectMode}
                              selected={selectedIds.has(item.id)}
                            />
                          )
                        )}
                      </div>
                      )
                    })}
                    </BubbleNameFontScope>
                  </motion.div>
                </div>
              ) : (
                /* ── Single-page organic layout (free drag + saved positions) ──── */
                /* The scope wraps AnimatePresence rather than sitting inside it: its
                   children have to stay the motion elements for exit to be tracked. */
                <BubbleNameFontScope liveIds={levelBubbleIds}>
                <AnimatePresence>
                  {laidWithOverrides.map((item, i) =>
                    item.type === 'note' ? (
                      <NoteCard
                        key={`${item.id}-${theme}`}
                        item={item}
                        index={i}
                        customTagColors={project.customTagColors || {}}
                        isDragging={draggingId === item.id}
                        animateLayout={animatingLayout && draggingId !== item.id}
                        selectable={selectMode}
                        selected={selectedIds.has(item.id)}
                      />
                    ) : (
                      <BubbleCircle
                        key={`${item.id}-${theme}`}
                        item={item}
                        index={i}
                        hidden={expandAnim?.id === item.id}
                        isDragging={draggingId === item.id}
                        animateLayout={animatingLayout && draggingId !== item.id}
                        selectable={selectMode}
                        selected={selectedIds.has(item.id)}
                      />
                    )
                  )}
                </AnimatePresence>
                </BubbleNameFontScope>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Page indicator dots — fixed, above the + button ───────────────────── */}
      {paginated && pages.length > 1 && !selectMode && (
        <div
          className="absolute left-0 right-0 flex items-center justify-center gap-2 pointer-events-none z-10"
          style={{ bottom: 'calc(20px + env(safe-area-inset-bottom))' }}
        >
          {pages.map((_, i) => (
            <span
              key={i}
              style={{
                width: i === clampedPageIndex ? 9 : 6,
                height: i === clampedPageIndex ? 9 : 6,
                borderRadius: '50%',
                background: i === clampedPageIndex
                  ? (isLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)')
                  : (isLight ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.3)'),
                transition: 'width 0.2s, height 0.2s, background 0.2s',
              }}
            />
          ))}
        </div>
      )}

      {/* ── Edge highlight while dragging a bubble toward an adjacent page ─────── */}
      {edgeGlow && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none z-40"
          style={{
            [edgeGlow]: 0,
            width: 64,
            background: `linear-gradient(to ${edgeGlow === 'left' ? 'right' : 'left'}, rgba(99,102,241,0.45), rgba(99,102,241,0))`,
          }}
        />
      )}

      {/* ── Long-press item menu (lock / unlock) ──────────────────────────────── */}
      {lockMenu && (
          <LockMenu
            menu={lockMenu}
            gated={lockIndex.isGated(lockMenu.item)}
            width={size.width}
            height={size.height}
            onClose={closeLockMenu}
            onLock={() => { closeLockMenu(); toggleItemLock(lockMenu.item) }}
            onDelete={() => { closeLockMenu(); requestDeleteItem(lockMenu.item) }}
          />
      )}

      {/* ── ZoomExpand — outside swipe wrapper so it covers the header too ───── */}
      <ZoomExpand anim={expandAnim} size={size} onDone={handleExpandDone} />

      {/* ── Selection delete bar — centered, clear of the + button ────────────── */}
      {selectMode && (
        <div
          className="absolute left-0 right-0 flex justify-center pointer-events-none z-40"
          style={{ bottom: 'calc(18px + env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={selectedIds.size === 0}
            className="pointer-events-auto flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-lg transition-opacity disabled:opacity-40"
            style={{ background: '#dc2626' }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete{selectedIds.size > 0 ? ` ${selectedIds.size}` : ''}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${selectedIds.size} item${selectedIds.size === 1 ? '' : 's'}?`}
        message="Selected bubbles delete their sub-bubbles too. Notes inside move back to the top level. This can't be undone."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          const noteIds = []
          const bubbleIds = []
          for (const it of layoutItems) {
            if (!selectedIds.has(it.id)) continue
            if (it.type === 'note') noteIds.push(it.id)
            else bubbleIds.push(it.id)
          }
          onDeleteItems?.({ noteIds, bubbleIds })
          exitSelect()
        }}
      />

      <ConfirmDialog
        open={!!confirmDeleteItem}
        title={confirmDeleteItem?.type === 'note' ? 'Delete note?' : 'Delete bubble?'}
        // Accurate to what deleteItems actually does: sub-bubbles are removed with the
        // parent, but its notes are only detached — they reappear at the top level.
        message={confirmDeleteItem?.type === 'note'
          ? "This can't be undone."
          : "Sub-bubbles are deleted too. Notes inside move back to the top level. This can't be undone."}
        confirmLabel="Delete"
        onCancel={() => setConfirmDeleteItem(null)}
        onConfirm={() => {
          const it = confirmDeleteItem
          if (it) {
            onDeleteItems?.(it.type === 'note'
              ? { noteIds: [it.id], bubbleIds: [] }
              : { noteIds: [], bubbleIds: [it.id] })
          }
          setConfirmDeleteItem(null)
        }}
      />
    </div>
  )
}
