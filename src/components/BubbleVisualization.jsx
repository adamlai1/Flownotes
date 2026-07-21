import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { motion, AnimatePresence, useMotionValue, animate } from 'framer-motion'
import { getNoteCountForBubble, getBubbleDescendantIds, getNoteTitle, contrastColor } from '../utils/helpers'
import { TAG_COLORS, ROOT_BUBBLE_ID } from '../data/defaultData'
import { useTheme } from '../contexts/ThemeContext'

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

// Lay out ONE page's items exactly like the single-page view: organic scatter from
// computeLayout, overridden by saved positions, new items settled, overlaps cleared.
function layoutPage(pageItems, savedPositions, projectId, contextId, width, height) {
  if (width <= 0) return []
  const laid = computeLayout(pageItems, width, height, SUB_BAR_H, BOTTOM_PAD)
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
  return separateOverlaps(settled, width, height)
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
// (16 was sized for the old 11px bob; kept as-is, so there's ~5px of slack — dropping it
// to ~11 would buy roughly one extra note row per page if density ever matters more.)
const NOTE_GAP_X = 5
const NOTE_GAP_Y = 16      // 5px base + 5.5px max float travel + slack

// Rectangle (AABB) separation for a pair when at least one is a note. Pushes the pair
// apart along the axis of least penetration so their boxes keep gapX/gapY px between
// edges. Mutates whichever endpoints the move callbacks set. Returns true if it pushed.
// halfW/halfH give each item's half-extent (box for notes, circle radius for bubbles).
function separateBoxPair(dx, dy, halfWa, halfHa, halfWb, halfHb, gapX, gapY, pushX, pushY) {
  const ox = halfWa + halfWb + gapX - Math.abs(dx)
  const oy = halfHa + halfHb + gapY - Math.abs(dy)
  if (ox <= 0 || oy <= 0) return false
  if (ox < oy) pushX((ox / 2) * (dx < 0 ? -1 : 1))
  else pushY((oy / 2) * (dy < 0 ? -1 : 1))
  return true
}
const halfWidthOf  = (p) => p.type === 'note' ? p.r * NOTE_HW : p.r
const halfHeightOf = (p) => p.type === 'note' ? p.r * NOTE_HH : p.r

// Circle(bubble) vs box(note) penetration: distance from the bubble center to the
// nearest point of the note's rectangle, versus bubble radius + gap. Returns the
// penetration depth (0 if clear); callers push along the center-to-center direction.
// Treating the note as its fat bounding circle (radius ~38.8) held cards ~19px of dead
// air off a bubble vertically — this measures to the card's real edge instead.
function circleBoxPen(bub, note, gap) {
  const hw = note.r * NOTE_HW, hh = note.r * NOTE_HH
  const px = Math.max(note.cx - hw, Math.min(bub.cx, note.cx + hw))
  const py = Math.max(note.cy - hh, Math.min(bub.cy, note.cy + hh))
  const d = Math.hypot(px - bub.cx, py - bub.cy)
  return Math.max(0, bub.r + gap - d)
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
function lloydSpread(items, width, height, headerH, bottomPad, pinnedNoteIds = null) {
  const pos = items.map(i => ({ ...i }))
  const step = 18
  const btnCx = width - 52, btnCy = height - 52
  // Effective claim radius: notes claim a bit less than their bounding circle so
  // bubbles (true circles) get proportionally more room.
  const rEff = (p) => p.type === 'note' ? p.r * 0.85 : p.r
  // The bubble cluster's ellipse is note-forbidden territory: samples inside it are
  // owned by nobody, so no note's centroid can pull it into the pockets between
  // bubbles. (Bubbles are pinned, so the ellipse is constant across passes.)
  const bubs = pos.filter(p => p.type !== 'note')
  const eCl = bubs.length > 0 ? clusterEllipse(bubs) : null
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
      // pinned too when pinnedNoteIds is given.
      if (pos[k].type !== 'note') continue
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
  const minX = Math.min(...bubs.map(b => b.cx - b.r)), maxX = Math.max(...bubs.map(b => b.cx + b.r))
  const minY = Math.min(...bubs.map(b => b.cy - b.r)), maxY = Math.max(...bubs.map(b => b.cy + b.r))
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
// spiral seed, pairwise circle relaxation, and the cluster centroid re-anchored to the
// center each pass. The notes around them are then distributed by lloydSpread (which
// pins bubbles), so mixed pages read as "bubbles in the middle, notes around them".
function recenterBubbles(items, width, height, headerH, bottomPad) {
  const pos = items.map(i => ({ ...i }))
  const bubs = pos.filter(p => p.type !== 'note')
  if (bubs.length === 0) return pos
  const cx0 = width / 2
  const cy0 = headerH + (height - headerH - bottomPad) / 2
  if (bubs.length === 1) {
    bubs[0].cx = cx0; bubs[0].cy = cy0
  } else if (bubs.length === 2) {
    // Pair: side by side, centered.
    const off = (bubs[0].r + bubs[1].r + 8) / 2
    bubs[0].cx = cx0 - off; bubs[0].cy = cy0
    bubs[1].cx = cx0 + off; bubs[1].cy = cy0
  } else {
    // Triangle core: the first three bubbles sit at the vertices of a point-up
    // triangle (not hub-and-spoke, which read as a lopsided "V" for 3 bubbles);
    // any further bubbles spiral snugly around that core and the relaxation
    // below packs everything to touching.
    const GA = Math.PI * (3 - Math.sqrt(5))
    const rCore = (bubs[0].r + bubs[1].r + bubs[2].r) / 3
    const Rt = (2 * rCore + 8) / Math.sqrt(3)
    for (let i = 0; i < 3; i++) {
      const ang = -Math.PI / 2 + i * (2 * Math.PI / 3)
      bubs[i].cx = cx0 + Math.cos(ang) * Rt
      bubs[i].cy = cy0 + Math.sin(ang) * Rt
    }
    for (let i = 3; i < bubs.length; i++) {
      const ang = (i - 3) * GA
      const dist = Rt + (rCore + bubs[i].r) * 0.5 + 4 * (i - 3)
      bubs[i].cx = cx0 + Math.cos(ang) * dist
      bubs[i].cy = cy0 + Math.sin(ang) * dist
    }
    for (let iter = 0; iter < 120; iter++) {
      let any = false
      for (let i = 0; i < bubs.length; i++) {
        for (let j = i + 1; j < bubs.length; j++) {
          const a = bubs[i], b = bubs[j]
          const dx = b.cx - a.cx, dy = b.cy - a.cy
          const d = Math.sqrt(dx * dx + dy * dy) || 0.001
          const need = a.r + b.r + 8
          if (d < need - 0.25) {
            const p = (need - d) / 2, nx = dx / d, ny = dy / d
            a.cx -= nx * p; a.cy -= ny * p
            b.cx += nx * p; b.cy += ny * p
            any = true
          }
        }
      }
      // Keep the cluster centroid anchored on the page center as it relaxes.
      const mx = bubs.reduce((s, b) => s + b.cx, 0) / bubs.length
      const my = bubs.reduce((s, b) => s + b.cy, 0) / bubs.length
      bubs.forEach(b => { b.cx += cx0 - mx; b.cy += cy0 - my })
      if (!any) break
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

// True notes-per-page capacity of the even-spread grid above: densest legal pitch
// (minimum per-axis gaps), summed per row with the + button losses — the bottom
// rows lose the cells the button zone covers. Mirrors the grid path's geometry
// exactly so pagination never assigns a page more notes than the grid can place.
function noteGridCapacity(width, height, headerH, bottomPad) {
  const MIN_R = 40
  const BOX_W = MIN_R * 2 * NOTE_HW, BOX_H = MIN_R * 2 * NOTE_HH
  // MUST mirror the grid path's margins (incl. reserved jitter) exactly.
  const mX = 14 + 12 + BOX_W / 2
  const mT = headerH + 10 + 10 + BOX_H / 2, mB = 10 + 10 + BOX_H / 2
  const spanW = width - mX * 2
  const spanH = (height - bottomPad) - mT - mB
  const cols = Math.max(1, Math.floor(spanW / (BOX_W + NOTE_GAP_X)) + 1)
  const rows = Math.max(1, Math.floor(spanH / (BOX_H + NOTE_GAP_Y)) + 1)
  const pitchX = cols > 1 ? spanW / (cols - 1) : 0
  const pitchY = rows > 1 ? spanH / (rows - 1) : 0
  let cap = 0
  for (let r = 0; r < rows; r++) {
    const cy = rows > 1 ? mT + r * pitchY : mT + spanH / 2
    const xMax = Math.min(width - mX, noteRowXMax(cy, width, height, BOX_W / 2, BOX_H / 2))
    const rs = xMax - mX
    cap += rs <= 0 ? 0 : Math.min(cols, Math.floor(rs / Math.max(pitchX, BOX_W + NOTE_GAP_X)) + 1)
  }
  return Math.max(1, cap)
}

function computeLayout(items, width, height, headerH = 56, bottomPad = 0) {
  const n = items.length
  if (n === 0) return []

  // availH excludes the header and the bottom clearance needed for the + button
  const availH = height - headerH - bottomPad
  const cx0 = width / 2
  // Center the cluster in the usable band between header and bottom clearance
  const cy0 = headerH + availH / 2
  const base = Math.min(width, availH) * 0.4

  // Minimum bubble size — every other size floor derives from this.
  const MIN_D = 80           // 80px minimum diameter
  const MIN_R = MIN_D / 2    // → 40px minimum radius

  if (n === 1) {
    const r = items[0].type === 'note'
      ? MIN_R
      : Math.max(Math.min(width, availH) * 0.27, MIN_R)
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
    const BOX_W = MIN_R * 2 * NOTE_HW, BOX_H = MIN_R * 2 * NOTE_HH   // 62 x 46 rendered box
    // Margins reserve the max jitter amplitude (±12 x, ±10 y) on top of the visible
    // margin, so a jittered edge note can never sit closer than ~14px to the screen edge.
    const mX = 14 + 12 + BOX_W / 2
    const mT = headerH + 10 + 10 + BOX_H / 2, mB = 10 + 10 + BOX_H / 2
    const spanW = width - mX * 2
    const spanH = (height - bottomPad) - mT - mB
    // Rows near the + button stop short of it: cells are never placed inside its
    // exclusion zone (shoving them out after placement broke the float clearance).
    const xMaxAt = (cy) =>
      Math.min(width - mX, noteRowXMax(cy, width, height, BOX_W / 2, BOX_H / 2))
    const rowCapAt = (cy, pitchX) => {
      const rs = xMaxAt(cy) - mX
      return rs <= 0 ? 0 : Math.floor(rs / Math.max(pitchX, BOX_W + NOTE_GAP_X)) + 1
    }
    // Gap ceiling: a few notes shouldn't be flung to the page corners — beyond this,
    // extra space stays as page margin around a centered cluster instead of gap.
    const GAP_X_MAX = 48, GAP_Y_MAX = 44
    // Pick the col/row split whose (capped) leftover gaps are closest to equal on both
    // axes, biased toward the page's aspect so sparse clusters take a fitting shape,
    // honouring the per-axis minimum gaps and the button-reduced row capacities.
    // Everything is evaluated at the CAPPED pitch — that's what actually gets placed.
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
          capTotal += Math.min(cols, rowCapAt(cy, pitchX))
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
      // Over true capacity: densest legal grid; the caller's separation passes
      // resolve whatever overlap the surplus items cause.
      const cols = Math.max(1, Math.floor(spanW / (BOX_W + NOTE_GAP_X)) + 1)
      const rows = Math.ceil(n / cols)
      best = { cols, rows, pitchX: spanW / Math.max(cols - 1, 1), pitchY: spanH / Math.max(rows - 1, 1) }
    }
    const { cols, rows, pitchX, pitchY } = best
    // Pitches are already gap-capped by the search; center the block vertically so
    // sparse pages read as a loose cluster, not a corner-to-corner stretch.
    const mT2 = rows > 1 ? mT + (spanH - (rows - 1) * pitchY) / 2 : mT
    const jx = Math.min(Math.max(((cols > 1 ? pitchX - BOX_W : spanW) - NOTE_GAP_X) / 2, 0), 12)
    const jy = Math.min(Math.max(((rows > 1 ? pitchY - BOX_H : spanH) - NOTE_GAP_Y) / 2, 0), 10)
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
      const x0 = k > 1 ? mX + (rowSpan - (k - 1) * pitch) / 2 : mX + rowSpan / 2
      for (let c = 0; c < k && placed < n; c++) {
        slots.push({ x: k > 1 ? x0 + c * pitch : x0, y: cy })
        placed++
      }
    }
    // True over-capacity leftovers (pagination normally prevents this): drop in and
    // let the caller's separation passes sort them out.
    while (placed < n) {
      slots.push({ x: mX + (placed % 3) * (BOX_W + NOTE_GAP_X), y: mT + spanH / 2 })
      placed++
    }
    // Cells are built row-major (top-left → bottom-right), but new notes are APPENDED
    // to the project — in item order the newest note always drew the bottom-right cell,
    // right beside the + button, so every fresh note "spawned" at the button. Assign
    // cells in reverse: the newest note takes the top-left cell (newest-first reading
    // order) and the button-adjacent cell goes to the oldest, stably placed note.
    return items.map((item, i) => {
      const s = slots[slots.length - 1 - i] ?? slots[slots.length - 1]
      // Deterministic per-index jitter so the layout is stable across renders.
      const hx = Math.sin(i * 127.1), hy = Math.sin(i * 311.7)
      return { ...item, cx: s.x + hx * jx, cy: s.y + hy * jy, r: MIN_R }
    })
  }

  const bubbleItems = items.filter(i => i.type !== 'note')
  // Log-scale bubble sizes by total nested content (notes + descendant bubbles),
  // relative to the busiest bubble in this view.
  const maxContent = Math.max(...bubbleItems.map(i => i.contentCount || 0), 1)
  const minR = Math.max(base * 0.15, MIN_R)
  const maxR = Math.max(Math.min(base * 0.42, 124), minR)
  // Note cards are always the fixed minimum size — only category bubbles scale.
  const noteR = MIN_R

  const radii = items.map(item => {
    if (item.type === 'note') return noteR
    const content = item.contentCount || 0
    const t = Math.log(content + 1) / Math.log(maxContent + 1)
    return minR + (maxR - minR) * t
  })

  // Tighter circle-packing when crowded: shrink the inter-bubble gap as the
  // count grows so many bubbles pack closer together.
  const packGap = n > 16 ? 4 : n > 10 ? 6 : 8
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
  let pos = items.map((item, i) => {
    const angle = i * GA
    const dist = base * 0.46 * Math.sqrt(i / (n - 1 || 1))
    return { ...item, x: dist * Math.cos(angle) * ellX, y: dist * Math.sin(angle) * ellY, r: radii[i] }
  })

  for (let iter = 0; iter < 240; iter++) {
    let any = false
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j]
        const dx = b.x - a.x, dy = b.y - a.y
        if (a.type === 'note' && b.type === 'note') {
          // Notes are rendered as rectangles (W = r*1.55, H = r*1.15), so pack them
          // by their actual box — not the much larger bounding circle, which is what
          // left the wide vertical gaps.
          const ox = (a.r + b.r) * NOTE_HW - Math.abs(dx) + NOTE_GAP_X
          const oy = (a.r + b.r) * NOTE_HH - Math.abs(dy) + NOTE_GAP_Y
          if (ox > 0 && oy > 0) {
            if (ox < oy) {
              const push = (ox / 2) * (dx < 0 ? -1 : 1)
              pos[i] = { ...a, x: a.x - push }
              pos[j] = { ...b, x: b.x + push }
            } else {
              const push = (oy / 2) * (dy < 0 ? -1 : 1)
              pos[i] = { ...a, y: a.y - push }
              pos[j] = { ...b, y: b.y + push }
            }
            any = true
          }
        } else {
          const d = Math.sqrt(dx * dx + dy * dy) || 0.001
          const gap = a.r + b.r + packGap
          if (d < gap) {
            const push = (gap - d) / 2
            const nx = dx / d, ny = dy / d
            pos[i] = { ...a, x: a.x - nx * push, y: a.y - ny * push }
            pos[j] = { ...b, x: b.x + nx * push, y: b.y + ny * push }
            any = true
          }
        }
      }
    }
    if (!any) break
  }

  // Tighter margin around the cluster when crowded so it can scale up to fill more.
  const pad = n > 10 ? 16 : 28
  const xs = pos.flatMap(p => [p.x - p.r, p.x + p.r])
  const ys = pos.flatMap(p => [p.y - p.r, p.y + p.r])
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
    // minimum ON SCREEN — scaled by the smaller axis factor so they stay circular (never
    // stretched) and never shrink below MIN_R.
    r: p.type === 'note' ? MIN_R : Math.max(p.r * Math.min(scaleX, scaleY), MIN_R),
  }))

  // Flooring the radius can re-introduce overlaps; relax in screen space with a
  // tight gap, clamping every bubble fully on-screen each pass so nothing ends up
  // off the viewport. (When bubbles can't all fit at the minimum size they will
  // pack tightly / overlap rather than shrink below it.)
  const clampXY = (p) => {
    p.cx = Math.max(p.r + 8, Math.min(width - p.r - 8, p.cx))
    p.cy = Math.max(headerH + p.r + 8, Math.min(height - bottomPad - p.r, p.cy))
  }
  const tightGap = Math.min(packGap, 5)
  for (let iter = 0; iter < 160; iter++) {
    let any = false
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i], b = result[j]
        const dx = b.cx - a.cx, dy = b.cy - a.cy
        if (a.type === 'note' && b.type === 'note') {
          // Rectangle separation for note squares (see packing pass above).
          const ox = (a.r + b.r) * NOTE_HW - Math.abs(dx) + NOTE_GAP_X
          const oy = (a.r + b.r) * NOTE_HH - Math.abs(dy) + NOTE_GAP_Y
          if (ox > 0 && oy > 0) {
            if (ox < oy) {
              const push = (ox / 2) * (dx < 0 ? -1 : 1)
              a.cx -= push; b.cx += push
            } else {
              const push = (oy / 2) * (dy < 0 ? -1 : 1)
              a.cy -= push; b.cy += push
            }
            any = true
          }
        } else {
          const d = Math.sqrt(dx * dx + dy * dy) || 0.001
          const need = a.r + b.r + tightGap
          if (d < need) {
            const push = (need - d) / 2
            const nx = dx / d, ny = dy / d
            a.cx -= nx * push; a.cy -= ny * push
            b.cx += nx * push; b.cy += ny * push
            any = true
          }
        }
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
      lloydSpread(recenterBubbles(result, width, height, headerH, bottomPad), width, height, headerH, bottomPad),
      width, height, true,
    )
  }

  return result
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

// ─── BubbleCircle ─────────────────────────────────────────────────────────────

function BubbleCircle({ item, index, hidden, isDragging, animateLayout }) {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const rgb = hexToRgb(item.color)
  const solidBg = isLight ? solidMutedColor(item.color) : null
  const solidText = isLight ? contrastColor(solidBg) : null
  const name = item.name || ''

  // Count lines ("N bubbles" / "N notes" on separate lines): shrink with the bubble
  // and hide entirely when it's tiny.
  const subSize = Math.max(Math.min(item.r * 0.15, 12), 8)
  const countLines = (item.childBubbleCount > 0 ? 1 : 0) + (item.noteCount > 0 ? 1 : 0)
  const showSub = countLines > 0 && item.r >= 34

  // Horizontal padding inside the bubble so text never touches the edges.
  const TEXT_PAD = 5 // px each side

  // Font auto-sizing: shrink the font until the WHOLE name fits inside the circle —
  // both the longest word on the widest (center) line and the total text across the
  // available lines — down to an 8px floor. Only if it still doesn't fit at 8px is it
  // truncated with an ellipsis. Never breaks mid-word.
  const CHAR_W = 0.62, LINE_H = 1.2 // conservative glyph width so words aren't clipped
  const longestWord = name.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 1)
  const chars = Math.max(name.length, 1)
  const centerW = Math.max(item.r * 2 - TEXT_PAD * 2 - 4, 1)   // widest usable line
  const avgW = Math.max(item.r * 2 * 0.8 - TEXT_PAD * 2, 1)    // average line width across the circle
  // Reserve room for the count lines (one per non-zero count), which sit directly
  // below the centered title.
  const availH = Math.max(item.r * 2 * 0.66 - (showSub ? countLines * subSize * 1.2 + 4 : 0), 1)
  const baseFont = Math.min(item.r * 0.34, 20)                 // upper bound (short names stay large)
  const wordFont = centerW / (CHAR_W * longestWord)            // longest word fits the center line
  const areaFont = Math.sqrt((avgW * availH) / (CHAR_W * LINE_H * chars * 1.2)) // whole name fits the area
  const fontSize = Math.max(Math.min(baseFont, wordFont, areaFont), 8)

  // Lines available at this font; text only overflows (→ ellipsis) at the 8px floor.
  const nameLines = Math.max(1, Math.floor(availH / (fontSize * LINE_H)))

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
        left: item.cx - item.r,
        top: item.cy - item.r,
        width: item.r * 2,
        height: item.r * 2,
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
          borderRadius: '50%',
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
        animate={isDragging ? { scale: 1.1, y: 0 } : { scale: 1, y: [0, -floatAmt, 0] }}
        transition={isDragging
          ? { duration: 0.18, ease: [0.34, 1.56, 0.64, 1] }
          : {
              scale: { type: 'spring', stiffness: 260, damping: 22, delay: index * 0.07 },
              y: { duration: floatDuration, repeat: Infinity, ease: 'easeInOut', delay: floatDelay },
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
          textAlign: 'center',
          width: '100%',
          padding: `0 ${TEXT_PAD}px`,
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }}>
          <span style={{
            fontSize,
            fontWeight: 600,
            color: isLight ? solidText : 'rgba(255,255,255,0.93)',
            textAlign: 'center',
            textShadow: isLight ? 'none' : '0 1px 4px rgba(0,0,0,0.55)',
            lineHeight: LINE_H,
            maxWidth: '100%',
            // Wrap at spaces first (and the font shrinks to fit whole words); if a
            // single word is still too long, break it onto the next line rather than
            // letting it overflow/clip. Ellipsis only if it still can't fit.
            wordBreak: 'normal',
            overflowWrap: 'anywhere',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: nameLines,
            WebkitBoxOrient: 'vertical',
          }}>
            {item.name}
          </span>
          {showSub && (
            <div style={{
              position: 'absolute',
              top: '100%',       // directly below the title text
              // Match the title's horizontal padding (aligns with the title content box).
              left: TEXT_PAD,
              right: TEXT_PAD,
              marginTop: 3,
              fontSize: subSize,
              color: isLight ? (solidText === '#ffffff' ? 'rgba(255,255,255,0.65)' : 'rgba(31,41,55,0.55)') : 'rgba(255,255,255,0.48)',
              fontWeight: 500,
              textAlign: 'center',
              lineHeight: 1.15,
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
    </motion.div>
  )
}

// ─── NoteCard ─────────────────────────────────────────────────────────────────

function NoteCard({ item, index, customTagColors = {}, isDragging, animateLayout }) {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const rgb = hexToRgb(item.color)
  const solidBg = isLight ? solidMutedColor(item.color) : null
  const solidText = isLight ? contrastColor(solidBg) : null
  const r = item.r
  const W = Math.round(r * 1.55)
  const H = Math.round(r * 1.15)
  const tagDots = (item.tags || []).map(t => TAG_COLORS[t] || customTagColors[t]).filter(Boolean)

  const floatAmt      = 2.5 + (index % 3) * 1.5
  const floatDuration = 2.6 + (index % 4) * 0.45
  const floatDelay    = (index * 0.22) % 3

  const label    = getNoteTitle(item.content) || 'New note'
  const lines    = (item.content || '').split('\n').filter(l => l.trim())
  const bodyText = lines.slice(1).join('\n').trim() // content after the first (title) line
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
          borderRadius: '22%',
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
        animate={isDragging ? { scale: 1.1, y: 0 } : { scale: 1, y: [0, -floatAmt, 0] }}
        transition={isDragging
          ? { duration: 0.18, ease: [0.34, 1.56, 0.64, 1] }
          : {
              scale: { type: 'spring', stiffness: 260, damping: 22, delay: index * 0.07 },
              y: { duration: floatDuration, repeat: Infinity, ease: 'easeInOut', delay: floatDelay },
            }
        }
      >
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

  const bubbleRect = { left: cx - r, top: cy - r, width: r * 2, height: r * 2, borderRadius: r }
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

const SUB_BAR_H = 52
const BOTTOM_PAD = 0           // no bottom barrier — bubbles reach the bottom edge
// Just clear the + button itself: button is 56px (radius 28) + a small ~8px margin.
const PLUS_BTN_EXCL_R = 36    // no-go radius around the floating + button

// Effective collision radius (notes are rectangular; approximate as slightly smaller circle)
function cr(item) { return item.type === 'note' ? item.r * 0.97 : item.r }

// Keep an item's center outside a FULL circle around the + button (bottom-right),
// blocking overlap from ANY direction. The button hugs the bottom-right corner, so
// the always-open escape directions are left and up: we slide the center to the
// nearest point on the exclusion circle along whichever axis fits in bounds. This
// works even when the bubble is dragged in from the side or from directly below.
// Mutates p.cx / p.cy in place.
function keepClearOfPlusButton(p, width, height, topLimit, botLimit) {
  const btnCx = width - 52, btnCy = height - 52
  // Notes clear the button by their real box (same rule as the grid's row capacity and
  // the separation pass); the circle test reserved ~45px of phantom horizontal room.
  if (p.type === 'note') {
    const pen = circleBoxPen({ cx: btnCx, cy: btnCy, r: PLUS_BTN_EXCL_R }, p, BTN_ROW_PAD)
    if (pen <= 0) return
    const hw = halfWidthOf(p), hh = halfHeightOf(p)
    const dx = p.cx - btnCx, dy = p.cy - btnCy
    const d = Math.hypot(dx, dy) || 1
    p.cx = Math.max(hw + 12, Math.min(width - hw - 12, p.cx + (dx / d) * pen))
    p.cy = Math.max(topLimit + hh + 12, Math.min(botLimit - hh, p.cy + (dy / d) * pen))
    return
  }
  const r = p.r
  const minDist = PLUS_BTN_EXCL_R + r
  const ddx = p.cx - btnCx, ddy = p.cy - btnCy
  const dist = Math.sqrt(ddx * ddx + ddy * ddy)
  if (dist >= minDist) return
  // Single-axis exits that land exactly on the exclusion circle.
  const leftX = btnCx - Math.sqrt(Math.max(minDist * minDist - ddy * ddy, 0))
  const upY = btnCy - Math.sqrt(Math.max(minDist * minDist - ddx * ddx, 0))
  const leftOk = leftX >= r + 12
  const upOk = upY >= topLimit + r + 12
  if (leftOk && (!upOk || (p.cx - leftX) <= (p.cy - upY))) {
    p.cx = leftX
  } else if (upOk) {
    p.cy = upY
  } else {
    // Extremely tight space — push radially toward the interior as a fallback.
    const nx = ddx / (dist || 1), ny = ddy / (dist || 1)
    p.cx = Math.max(r + 12, Math.min(width - r - 12, p.cx + nx * (minDist - dist)))
    p.cy = Math.max(topLimit + r + 12, Math.min(botLimit - r, p.cy + ny * (minDist - dist)))
  }
}

// Clamp an item to screen bounds then push it clear of the + button (all sides).
// Notes clamp by their real box half-extents, NOT the bounding circle — circle-clamping
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
function separateOverlaps(items, width, height, pinBubbles = false, ellipseOnlyIds = null) {
  const BUFFER = 3 // px gap so items never visually touch
  const EPS = 0.25 // sub-pixel tolerance so float noise doesn't spin the loop forever
  const pos = items.map(i => ({ ...i }))
  const btnCx = width - 52, btnCy = height - 52
  // Screen bounds only — box-aware for notes, same insets as clampToBounds.
  const boundsClamp = (p) => {
    const hw = halfWidthOf(p), hh = halfHeightOf(p)
    p.cx = Math.max(hw + 12, Math.min(width - hw - 12, p.cx))
    p.cy = Math.max(SUB_BAR_H + hh + 12, Math.min(height - BOTTOM_PAD - hh, p.cy))
  }
  for (let iter = 0; iter < 120; iter++) {
    let moved = false
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j]
        const dx = b.cx - a.cx, dy = b.cy - a.cy
        if (a.type === 'note' && b.type === 'note') {
          // Separate note squares by their real box so they pack tight without the fat
          // circle spacing (which over-separated and, when dense, left them overlapping).
          if (separateBoxPair(
            dx, dy,
            halfWidthOf(a), halfHeightOf(a), halfWidthOf(b), halfHeightOf(b),
            NOTE_GAP_X - EPS, NOTE_GAP_Y - EPS,
            (p) => { a.cx -= p; b.cx += p }, (p) => { a.cy -= p; b.cy += p },
          )) moved = true
        } else if (a.type === 'note' || b.type === 'note') {
          // Bubble-note: circle vs the note's REAL rectangle — the bounding-circle
          // model kept a fat invisible moat around every bubble.
          const bub = a.type === 'note' ? b : a
          const note = a.type === 'note' ? a : b
          const pen = circleBoxPen(bub, note, BUFFER - EPS)
          if (pen > 0) {
            const ddx = note.cx - bub.cx, ddy = note.cy - bub.cy
            const dd = Math.hypot(ddx, ddy) || 0.001
            const nx = ddx / dd, ny = ddy / dd
            if (pinBubbles) { note.cx += nx * pen; note.cy += ny * pen }
            else {
              note.cx += nx * pen / 2; note.cy += ny * pen / 2
              bub.cx -= nx * pen / 2; bub.cy -= ny * pen / 2
            }
            moved = true
          }
        } else {
          const d = Math.sqrt(dx * dx + dy * dy) || 0.001
          const need = cr(a) + cr(b) + BUFFER
          if (d < need - EPS) {
            const push = (need - d) / 2
            const nx = dx / d, ny = dy / d
            a.cx -= nx * push; a.cy -= ny * push
            b.cx += nx * push; b.cy += ny * push
            moved = true
          }
        }
      }
    }
    // + button obstacle: radial push out. Notes measure by their real box (matching the
    // grid's row capacity), bubbles by their circle — a circle test on notes would shove
    // the bottom-row cells the grid legitimately placed beside the button.
    for (const p of pos) {
      const dx = p.cx - btnCx, dy = p.cy - btnCy
      const d = Math.sqrt(dx * dx + dy * dy) || 0.001
      if (p.type === 'note') {
        const pen = circleBoxPen({ cx: btnCx, cy: btnCy, r: PLUS_BTN_EXCL_R }, p, BTN_ROW_PAD - EPS)
        if (pen > 0) {
          p.cx += (dx / d) * pen
          p.cy += (dy / d) * pen
          moved = true
        }
        continue
      }
      const need = PLUS_BTN_EXCL_R + p.r
      if (d < need - EPS) {
        p.cx = btnCx + (dx / d) * need
        p.cy = btnCy + (dy / d) * need
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
    if (!moved) break
  }
  return pos
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
        if (a.type === 'note' && b.type === 'note') {
          // Box separation: push `a` off `b` along the axis of least penetration so notes
          // settle by their real rectangle, not the fat bounding circle.
          const ox = halfWidthOf(a) + halfWidthOf(b) + NOTE_GAP_X - Math.abs(dx)
          const oy = halfHeightOf(a) + halfHeightOf(b) + NOTE_GAP_Y - Math.abs(dy)
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
          continue
        }
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001
        const minDist = cr(a) + cr(b) + GAP
        if (dist >= minDist) continue
        const overlap = minDist - dist
        const nx = dx / dist, ny = dy / dist
        if (anchoredIds.has(b.id)) {
          a.cx += nx * overlap; a.cy += ny * overlap // push a fully
        } else {
          a.cx += nx * overlap / 2; a.cy += ny * overlap / 2
          b.cx -= nx * overlap / 2; b.cy -= ny * overlap / 2
          clampToBounds(b, width, height)
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

        // Note-note pairs collide by their real box + the per-axis layout gaps — the
        // circular model needed ~94px between centers, so dragging on a dense grid
        // (67px pitch) would shove every neighbour apart and then pin the blown-up
        // layout on drop. Box collision keeps drag physics consistent with layout.
        if (a.type === 'note' && b.type === 'note') {
          const ox = halfWidthOf(a) + halfWidthOf(b) + NOTE_GAP_X - Math.abs(dx)
          const oy = halfHeightOf(a) + halfHeightOf(b) + NOTE_GAP_Y - Math.abs(dy)
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
            const movedDist = Math.abs(axisX ? other.cx - bx : other.cy - by)
            const remaining = ov - movedDist
            if (remaining > 0.5) {
              if (axisX) dragged.cx -= dir * remaining; else dragged.cy -= dir * remaining
              clampToBounds(dragged, width, height)
            }
          }
          continue
        }

        // Bubble-note pairs: circle vs the note's REAL rectangle with a small gap — the
        // bounding-circle model + 16px gap made bubbles carry an oversized invisible
        // moat that you could feel when dragging a note near one.
        if (a.type === 'note' || b.type === 'note') {
          const bub = a.type === 'note' ? b : a
          const note = a.type === 'note' ? a : b
          const pen = circleBoxPen(bub, note, 6)
          if (pen <= 0) continue
          anyOverlap = true
          const ddx = note.cx - bub.cx, ddy = note.cy - bub.cy
          const dd = Math.hypot(ddx, ddy) || 0.001
          const bnx = ddx / dd, bny = ddy / dd
          if (!a.isDragged && !b.isDragged) {
            note.cx += bnx * pen / 2; note.cy += bny * pen / 2; clampToBounds(note, width, height)
            bub.cx -= bnx * pen / 2; bub.cy -= bny * pen / 2; clampToBounds(bub, width, height)
          } else {
            const dragged = a.isDragged ? a : b
            const other = a.isDragged ? b : a
            // push direction on OTHER: away from the dragged item
            const pox = other === note ? bnx : -bnx
            const poy = other === note ? bny : -bny
            const bcx = other.cx, bcy = other.cy
            other.cx += pox * pen
            other.cy += poy * pen
            clampToBounds(other, width, height)
            const movedDist = Math.sqrt((other.cx - bcx) ** 2 + (other.cy - bcy) ** 2)
            const remaining = pen - movedDist
            if (remaining > 0.5) {
              dragged.cx -= pox * remaining
              dragged.cy -= poy * remaining
              clampToBounds(dragged, width, height)
            }
          }
          continue
        }

        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001
        const minDist = cr(a) + cr(b) + GAP
        if (dist >= minDist) continue

        anyOverlap = true
        const overlap = minDist - dist
        const nx = dx / dist, ny = dy / dist

        if (!a.isDragged && !b.isDragged) {
          a.cx -= nx * overlap / 2;  a.cy -= ny * overlap / 2;  clampToBounds(a, width, height)
          b.cx += nx * overlap / 2;  b.cy += ny * overlap / 2;  clampToBounds(b, width, height)
        } else {
          const dragged = a.isDragged ? a : b
          const other   = a.isDragged ? b : a
          const pnx = a.isDragged ? nx : -nx
          const pny = a.isDragged ? ny : -ny

          const bcx = other.cx, bcy = other.cy
          other.cx += pnx * overlap
          other.cy += pny * overlap
          clampToBounds(other, width, height)

          const movedDist = Math.sqrt((other.cx - bcx) ** 2 + (other.cy - bcy) ** 2)
          const remaining = overlap - movedDist

          if (remaining > 0.5) {
            dragged.cx -= pnx * remaining
            dragged.cy -= pny * remaining
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
  viewMode,
  onSetViewMode,
  onCurrentBubbleChange,
  navigateToBubbleId,
  onRefresh,
}) {
  const containerRef = useRef(null)
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [navStack, setNavStack] = useState([])
  const [navDir, setNavDir] = useState('in')
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
  // ── Paged mode state ──────────────────────────────────────────────────────────
  const [pageIndex, setPageIndex] = useState(0)
  const pageIndexRef = useRef(0)
  pageIndexRef.current = pageIndex
  const pageX = useMotionValue(0)
  const [savedPages, setSavedPages] = useState({}) // { [posKey]: pageIndex }
  const savedPagesRef = useRef({})
  savedPagesRef.current = savedPages
  const pagesRef = useRef([])         // current pages (arrays of laid items)
  const perPageRef = useRef(1)
  const paginatedRef = useRef(false)
  const pagedRef = useRef(null)       // active paged gesture state
  // Briefly true after a cross-page move so affected pages animate their re-layout.
  const [layoutAnim, setLayoutAnim] = useState(false)
  const layoutAnimTimerRef = useRef(null)
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

  const directNotes = currentId
    ? project.notes.filter(n => n.bubble_ids.includes(currentId))
    : project.notes.filter(n => n.bubble_ids.length === 0 || n.bubble_ids.includes(ROOT_BUBBLE_ID))

  const layoutItems = [
    ...visibleBubbles.map(b => {
      const noteCount = getNoteCountForBubble(project.notes, b.id, project.bubbles)
      const childBubbleCount = project.bubbles.filter(c => c.parent_id === b.id).length
      const descendantBubbleCount = getBubbleDescendantIds(project.bubbles, b.id).length - 1
      return { ...b, type: 'bubble', noteCount, childBubbleCount, contentCount: noteCount + descendantBubbleCount }
    }),
    ...directNotes.map(n => ({
      ...n,
      type: 'note',
      color: '#a5b4fc',
    })),
  ]

  // Pagination trigger (computed before the single-page layout so it can be skipped
  // when paged). More items than fit one screen at the minimum size → paginate.
  const PAGE_MIN_D = 80
  const pageAvailH = size.height - SUB_BAR_H - BOTTOM_PAD
  // Capacity from each type's REAL footprint, not a one-size bubble grid: notes render as
  // small rectangles (W = r*1.55 ≈ 62px, H = r*1.15 ≈ 46px) packed ~5px apart, so counting
  // them as 98px bubble cells paginated note pages long before they were visually full.
  // The packer keeps item centers (r + 12) inside each edge (see clampToBounds), so the
  // usable band is the screen minus that inset on both sides.
  const EDGE = PAGE_MIN_D / 2 + 12
  const usablePageW = Math.max(size.width - 2 * EDGE, 1)
  const usablePageH = Math.max(pageAvailH - 2 * EDGE, 1)
  const gridCap = (boxW, boxH) =>
    Math.max(1, Math.floor(usablePageW / boxW)) * Math.max(1, Math.floor(usablePageH / boxH))
  // Notes: the even-spread grid's true capacity (densest legal pitch incl. float-bob
  // clearance, minus the cells lost to the + button). No derate needed — the grid
  // places cells exactly, unlike the old organic packer this formula used to model.
  const notesPerPage = size.width > 0
    ? noteGridCapacity(size.width, size.height, SUB_BAR_H, BOTTOM_PAD)
    : 1
  // Bubbles pack organically (golden-angle spiral + relaxation) into a roughly HEXAGONAL
  // arrangement at the crowded gap — not the square 98px grid this used to assume, which
  // under-counted capacity by about 2x and spilled bubbles onto a new page long before
  // one was full. Estimate from the hex-packing area of the region the packer can place
  // centers in, bounded by the hex row/column count so narrow pages stay sane. Measured
  // saturation (first visible overlap) is ~37 bubbles on a 400x780 phone and ~100 on a
  // 1100x720 desktop; this lands ~20% below that, leaving headroom for the size
  // variation of content-scaled bubbles.
  const BUBBLE_PITCH = PAGE_MIN_D + 6
  const hexRowPitch = BUBBLE_PITCH * Math.sqrt(3) / 2
  const bubblesPerPage = Math.max(1, Math.min(
    Math.floor((usablePageW * usablePageH) / (BUBBLE_PITCH * hexRowPitch)),
    (Math.floor(usablePageW / BUBBLE_PITCH) + 1) * (Math.floor(usablePageH / hexRowPitch) + 1),
  ))
  // Blend the two capacities by the current item mix into one count (assignPages is
  // count-based): pageLoad = how many pages this mix needs; perPage = items per page
  // at that blended density.
  const noteN = layoutItems.filter(i => i.type === 'note').length
  const bubbleN = layoutItems.length - noteN
  const pageLoad = noteN / notesPerPage + bubbleN / bubblesPerPage
  const perPage = Math.max(1, Math.floor(layoutItems.length / Math.max(pageLoad, 0.001)))
  const paginated = size.width > 0 && pageLoad > 1

  // Single-page organic layout (skipped when paginated — each page lays out its own).
  const laid = (!paginated && size.width > 0)
    ? computeLayout(layoutItems, size.width, size.height, SUB_BAR_H, BOTTOM_PAD)
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
    ? separateOverlaps(laidSettled, size.width, size.height)
    : laidSettled)

  // ── Pagination ────────────────────────────────────────────────────────────────
  // Each page keeps the SAME free-form organic layout + physics as the single-page
  // view — pagination only decides which page a bubble is on.
  let pages = []
  if (paginated) {
    const pageOf = assignPages(layoutItems, savedPages, project.id, currentId, perPage)
    const numPages = Math.max(
      Math.ceil(layoutItems.length / perPage),
      ...layoutItems.map(it => (pageOf[it.id] ?? 0) + 1),
      1,
    )
    const groups = Array.from({ length: numPages }, () => [])
    for (const it of layoutItems) groups[pageOf[it.id] ?? 0].push(it)
    pages = groups.map(group => layoutPage(group, savedPositions, project.id, currentId, size.width, size.height))
  }
  const clampedPageIndex = pages.length > 0 ? Math.min(pageIndex, pages.length - 1) : 0

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

  function zoomOut() {
    if (expandAnim || navTimerRef.current) return
    if (navStack.length === 0) return

    const lastItem = navStack[navStack.length - 1]
    setNavDir('out')
    // Pop navStack immediately — parent view renders with bubble hidden
    setNavStack(s => s.slice(0, -1))
    setSwipeOffset(0)

    // Shrink the full-screen view back to the bubble's stored position
    if (lastItem.cx !== undefined) {
      setExpandAnim({
        phase: 'out',
        id: lastItem.id,
        cx: lastItem.cx,
        cy: lastItem.cy,
        r: lastItem.r,
        color: lastItem.color,
      })
    }
  }
  // Keep ref current so the native touch handler can call the latest zoomOut
  zoomOutRef.current = zoomOut

  // ── Paged interactions (swipe between pages + drag with cross-page move) ───────
  function animateToPage(idx) {
    const clamped = Math.max(0, Math.min(idx, pagesRef.current.length - 1))
    pageIndexRef.current = clamped
    setPageIndex(clamped)
    animate(pageX, -clamped * sizeRef.current.width, { type: 'spring', stiffness: 320, damping: 34 })
  }

  const clearAllDragTransforms = () => {
    containerRef.current?.querySelectorAll('[data-item-id]').forEach(el => {
      el.style.transition = ''; el.style.transform = ''; el.style.zIndex = ''
    })
  }

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
    const hit = pageItems.find(item => item.type === 'note'
      ? (Math.abs(localX - item.cx) <= item.r * 0.775 && Math.abs(localY - item.cy) <= item.r * 0.575)
      : Math.hypot(localX - item.cx, localY - item.cy) <= item.r)
    const st = { mode: 'pending', startX: e.clientX, startY: e.clientY, itemId: hit?.id ?? null, lpTimer: null }
    pagedRef.current = st
    pageX.stop()
    if (hit) {
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
    }
  }

  function onPagedPointerMove(e) {
    const st = pagedRef.current
    if (!st) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    const localX = e.clientX - rect.left
    const localY = e.clientY - rect.top
    const { width: W, height: H } = sizeRef.current
    if (st.mode === 'pending') {
      if (Math.hypot(dx, dy) <= 8) return
      if (st.lpTimer) { clearTimeout(st.lpTimer); st.lpTimer = null }
      st.mode = 'swipe' // moved before the long-press fired → treat as a page swipe
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
      dragInfoRef.current = {
        ...drag,
        cx: Math.max(drag.r + 12, Math.min(W - drag.r - 12, localX)),
        cy: Math.max(SUB_BAR_H + drag.r + 12, Math.min(H - BOTTOM_PAD - drag.r, localY)),
      }
      // Highlight the edge when hovering over one that has an adjacent page to move to.
      const cur = pageIndexRef.current
      const side = (localX < 44 && cur > 0) ? 'left'
        : (localX > W - 44 && cur < pagesRef.current.length - 1) ? 'right' : null
      if (side !== st.edgeSide) { st.edgeSide = side; setEdgeGlow(side) } // only re-render on change
    }
  }

  function onPagedPointerUp(e) {
    const st = pagedRef.current
    if (!st) return
    pagedRef.current = null
    if (st.lpTimer) { clearTimeout(st.lpTimer); st.lpTimer = null }
    if (st.edgeSide) setEdgeGlow(null)
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
    // Tap (no significant move) → navigate / open.
    if (st.itemId != null && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const item = (pagesRef.current[pageIndexRef.current] || []).find(it => it.id === st.itemId)
      if (item) { item.type === 'bubble' ? handleBubbleClick(item) : onSelectNote(item) }
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

    // Hit test against current layout positions
    const hit = laidWithOverridesRef.current.find(item => {
      if (item.type === 'note') {
        const r = item.r, W = Math.round(r * 1.55), H = Math.round(r * 1.15)
        return x >= item.cx - W / 2 && x <= item.cx + W / 2 &&
               y >= item.cy - H / 2 && y <= item.cy + H / 2
      }
      return Math.hypot(x - item.cx, y - item.cy) <= item.r
    })
    if (!hit) return

    pendingPointerRef.current = { item: hit, startClientX: e.clientX, startClientY: e.clientY }
    dragActivatedRef.current = false

    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      dragActivatedRef.current = true
      navigator.vibrate?.(40)
      const currentHit = laidWithOverridesRef.current.find(i => i.id === hit.id) || hit
      dragInfoRef.current = { id: currentHit.id, type: currentHit.type, cx: currentHit.cx, cy: currentHit.cy, r: currentHit.r }
      setDraggingId(currentHit.id)
      dragRafRef.current = requestAnimationFrame(runDragFrame)
    }, 100)
  }

  function handlePointerMove(e) {
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
    dragInfoRef.current = {
      ...drag,
      cx: Math.max(drag.r + 12, Math.min(width - drag.r - 12, e.clientX - rect.left)),
      cy: Math.max(SUB_BAR_H + drag.r + 12, Math.min(height - BOTTOM_PAD - drag.r, e.clientY - rect.top)),
    }
  }

  function handlePointerUp() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
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
      // Was a tap — fire the appropriate action
      const { item } = pending
      if (item.type === 'bubble') {
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
          <button
            onClick={() => { setNavDir('out'); setNavStack([]) }}
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
                onClick={() => { setNavDir('out'); setNavStack(prev => prev.slice(0, i + 1)) }}
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

        {/* View toggle */}
        <div
          className="flex-shrink-0 flex rounded-xl overflow-hidden"
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
        </div>{/* end max-w-2xl wrapper */}
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
                  <motion.div style={{ x: pageX, display: 'flex', height: '100%', width: pages.length * size.width }}>
                    {pages.map((pageItems, pi) => (
                      <div key={pi} style={{ position: 'relative', width: size.width, height: '100%', flexShrink: 0 }}>
                        {pageItems.map((item, i) =>
                          item.type === 'note' ? (
                            <NoteCard
                              key={`${item.id}-${theme}`}
                              item={item}
                              index={i % 6}
                              customTagColors={project.customTagColors || {}}
                              isDragging={draggingId === item.id}
                              animateLayout={layoutAnim && draggingId !== item.id}
                            />
                          ) : (
                            <BubbleCircle
                              key={`${item.id}-${theme}`}
                              item={item}
                              index={i % 6}
                              hidden={expandAnim?.id === item.id}
                              isDragging={draggingId === item.id}
                              animateLayout={layoutAnim && draggingId !== item.id}
                            />
                          )
                        )}
                      </div>
                    ))}
                  </motion.div>
                </div>
              ) : (
                /* ── Single-page organic layout (free drag + saved positions) ──── */
                <AnimatePresence>
                  {laidWithOverrides.map((item, i) =>
                    item.type === 'note' ? (
                      <NoteCard
                        key={`${item.id}-${theme}`}
                        item={item}
                        index={i}
                        customTagColors={project.customTagColors || {}}
                        isDragging={draggingId === item.id}
                      />
                    ) : (
                      <BubbleCircle
                        key={`${item.id}-${theme}`}
                        item={item}
                        index={i}
                        hidden={expandAnim?.id === item.id}
                        isDragging={draggingId === item.id}
                      />
                    )
                  )}
                </AnimatePresence>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Page indicator dots — fixed, above the + button ───────────────────── */}
      {paginated && pages.length > 1 && (
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

      {/* ── ZoomExpand — outside swipe wrapper so it covers the header too ───── */}
      <ZoomExpand anim={expandAnim} size={size} onDone={handleExpandDone} />
    </div>
  )
}
