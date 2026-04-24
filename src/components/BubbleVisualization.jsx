import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
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

function computeLayout(items, width, height, headerH = 56, bottomPad = 12) {
  const n = items.length
  if (n === 0) return []

  // availH excludes the header and the bottom clearance needed for the + button
  const availH = height - headerH - bottomPad
  const cx0 = width / 2
  // Center the cluster in the usable band between header and bottom clearance
  const cy0 = headerH + availH / 2
  const base = Math.min(width, availH) * 0.4

  if (n === 1) {
    const r = items[0].type === 'note'
      ? Math.max(base * 0.14, 36)
      : Math.min(width, availH) * 0.27
    return [{ ...items[0], cx: cx0, cy: cy0, r }]
  }

  const bubbleItems = items.filter(i => i.type !== 'note')
  // Log-scale bubble sizes by total nested content (notes + descendant bubbles)
  const maxContent = Math.max(...bubbleItems.map(i => i.contentCount || 0), 1)
  const minR = Math.max(base * 0.15, 36)
  const maxR = Math.min(base * 0.42, 124)
  // Note cards are a fixed consistent size — only category bubbles scale
  const noteR = Math.max(base * 0.14, 36)

  const radii = items.map(item => {
    if (item.type === 'note') return noteR
    const content = item.contentCount || 0
    const t = Math.log(content + 1) / Math.log(maxContent + 1)
    return minR + (maxR - minR) * t
  })

  const GA = Math.PI * (3 - Math.sqrt(5))
  let pos = items.map((item, i) => {
    const angle = i * GA
    const dist = base * 0.46 * Math.sqrt(i / (n - 1 || 1))
    return { ...item, x: dist * Math.cos(angle), y: dist * Math.sin(angle), r: radii[i] }
  })

  for (let iter = 0; iter < 200; iter++) {
    let any = false
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j]
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 0.001
        const gap = a.r + b.r + 16
        if (d < gap) {
          const push = (gap - d) / 2
          const nx = dx / d, ny = dy / d
          pos[i] = { ...a, x: a.x - nx * push, y: a.y - ny * push }
          pos[j] = { ...b, x: b.x + nx * push, y: b.y + ny * push }
          any = true
        }
      }
    }
    if (!any) break
  }

  const pad = 28
  const xs = pos.flatMap(p => [p.x - p.r, p.x + p.r])
  const ys = pos.flatMap(p => [p.y - p.r, p.y + p.r])
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const bw = maxX - minX || 1, bh = maxY - minY || 1
  const scale = Math.min((width - pad * 2) / bw, (availH - pad * 2) / bh, 1.4)
  const lcx = (minX + maxX) / 2, lcy = (minY + maxY) / 2

  const result = pos.map(p => ({
    ...p,
    cx: cx0 + (p.x - lcx) * scale,
    cy: cy0 + (p.y - lcy) * scale,
    r: p.r * scale,
  }))

  // Push any item that landed inside the + button exclusion zone clear of it
  const btnCx = width - 52, btnCy = height - 52
  result.forEach(item => {
    const dx = item.cx - btnCx, dy = item.cy - btnCy
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.001
    const minDist = PLUS_BTN_EXCL_R + item.r
    if (dist < minDist) {
      const nx = dx / dist, ny = dy / dist
      item.cx = Math.max(item.r + 12, Math.min(width - item.r - 12, item.cx + nx * (minDist - dist)))
      item.cy = Math.max(headerH + item.r + 12, Math.min(height - bottomPad - item.r - 12, item.cy + ny * (minDist - dist)))
    }
  })

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

function BubbleCircle({ item, index, hidden, isDragging }) {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const rgb = hexToRgb(item.color)
  const solidBg = isLight ? solidMutedColor(item.color) : null
  const solidText = isLight ? contrastColor(solidBg) : null
  const fontSize = Math.max(Math.min(item.r * 0.22, 17), 10)
  const subSize = Math.max(Math.min(item.r * 0.17, 12), 9)
  const floatAmt = 5 + (index % 3) * 3
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
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, delay: index * 0.04 }}
    >
      {/* Inner: framer owns transform here (scale mount + scale+y float/drag) */}
      <motion.div
        style={{
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
        <span style={{
          fontSize,
          fontWeight: 600,
          color: isLight ? solidText : 'rgba(255,255,255,0.93)',
          textAlign: 'center',
          textShadow: isLight ? 'none' : '0 1px 4px rgba(0,0,0,0.55)',
          padding: '0 10px',
          lineHeight: 1.25,
          maxWidth: '90%',
          wordBreak: 'break-word',
          pointerEvents: 'none',
        }}>
          {item.name}
        </span>
        {(item.childBubbleCount > 0 || item.noteCount > 0) && (
          <span style={{
            fontSize: subSize,
            color: isLight ? (solidText === '#ffffff' ? 'rgba(255,255,255,0.65)' : 'rgba(31,41,55,0.55)') : 'rgba(255,255,255,0.48)',
            marginTop: 4,
            fontWeight: 500,
            pointerEvents: 'none',
            textAlign: 'center',
            padding: '0 8px',
          }}>
            {[
              item.childBubbleCount > 0 && `${item.childBubbleCount} ${item.childBubbleCount === 1 ? 'bubble' : 'bubbles'}`,
              item.noteCount > 0 && `${item.noteCount} ${item.noteCount === 1 ? 'note' : 'notes'}`,
            ].filter(Boolean).join(', ')}
          </span>
        )}
      </motion.div>
    </motion.div>
  )
}

// ─── NoteCard ─────────────────────────────────────────────────────────────────

function NoteCard({ item, index, customTagColors = {}, isDragging }) {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const rgb = hexToRgb(item.color)
  const solidBg = isLight ? solidMutedColor(item.color) : null
  const solidText = isLight ? contrastColor(solidBg) : null
  const r = item.r
  const W = Math.round(r * 1.55)
  const H = Math.round(r * 1.15)
  const tagDots = (item.tags || []).map(t => TAG_COLORS[t] || customTagColors[t]).filter(Boolean)

  const floatAmt      = 5 + (index % 3) * 3
  const floatDuration = 2.6 + (index % 4) * 0.45
  const floatDelay    = (index * 0.22) % 3

  const label    = getNoteTitle(item.content) || 'New note'
  const lines    = (item.content || '').split('\n').filter(l => l.trim())
  const hasBody  = lines.length > 1 || (lines[0]?.length > label.length)
  const fontSize = Math.max(Math.min(r * 0.17, 13), 8)
  const subSize  = Math.max(Math.min(r * 0.13, 10), 7)
  const iconSize = Math.max(Math.min(r * 0.18, 12), 8)

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
        <span style={{
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
          WebkitLineClamp: hasBody ? 3 : 4,
          WebkitBoxOrient: 'vertical',
        }}>
          {label}
        </span>
        {hasBody && (
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
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            maxWidth: '92%',
          }}>
            {lines.slice(1).filter(Boolean).join(' ')}
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
const BOTTOM_PAD = 12          // small margin — + button is handled by exclusion zone
const PLUS_BTN_EXCL_R = 80    // no-go radius around the floating + button

// Effective collision radius (notes are rectangular; approximate as slightly smaller circle)
function cr(item) { return item.type === 'note' ? item.r * 0.97 : item.r }

// Clamp an item to screen bounds then push it clear of the + button exclusion zone.
// Mutates p.cx / p.cy in place.
function clampToBounds(p, width, height) {
  const r = p.r
  p.cx = Math.max(r + 12, Math.min(width - r - 12, p.cx))
  p.cy = Math.max(SUB_BAR_H + r + 12, Math.min(height - BOTTOM_PAD - r - 12, p.cy))
  // + button sits at bottom-6 right-6 (24px each edge), w-14 h-14 (56px) → center 52px from each edge
  const btnCx = width - 52
  const btnCy = height - 52
  const dx = p.cx - btnCx, dy = p.cy - btnCy
  const dist = Math.sqrt(dx * dx + dy * dy) || 0.001
  const minDist = PLUS_BTN_EXCL_R + r
  if (dist < minDist) {
    const nx = dx / dist, ny = dy / dist
    p.cx = Math.max(r + 12, Math.min(width - r - 12, p.cx + nx * (minDist - dist)))
    p.cy = Math.max(SUB_BAR_H + r + 12, Math.min(height - BOTTOM_PAD - r - 12, p.cy + ny * (minDist - dist)))
  }
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
  // Keep refs current each render
  savedPositionsRef.current = savedPositions
  sizeRef.current = size

  useEffect(() => {
    if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null }
    setNavStack([])
    setExpandAnim(null)
    setSavedPositions(loadSavedPositions(project.id))
    setDraggingId(null)
    dragInfoRef.current = null
    resolvedDragPosRef.current = null
    resolvedAllPosRef.current = []
    dragActivatedRef.current = false
    pendingPointerRef.current = null
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
  }, [navStack, onCurrentBubbleChange])

  useEffect(() => {
    return () => { if (navTimerRef.current) clearTimeout(navTimerRef.current) }
  }, [])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight })
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

  const laid = size.width > 0
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
  const laidWithOverrides = (anchoredIds.size > 0 && anchoredIds.size < laidMapped.length && size.width > 0)
    ? settleItems(laidMapped, anchoredIds, size.width, size.height)
    : laidMapped

  // Keep refs current (used in pointer handlers and RAF loop)
  laidWithOverridesRef.current = laidWithOverrides
  currentIdRef.current = currentId

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
      cy: Math.max(SUB_BAR_H + drag.r + 12, Math.min(height - BOTTOM_PAD - drag.r - 12, e.clientY - rect.top)),
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
        width: '100%',
        height: '100%',
        minHeight: '100dvh',
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

              {/* Empty state */}
              {laid.length === 0 && !expandAnim && (
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

              {/* Bubbles and note cards */}
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
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── ZoomExpand — outside swipe wrapper so it covers the header too ───── */}
      <ZoomExpand anim={expandAnim} size={size} onDone={handleExpandDone} />
    </div>
  )
}
