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
function assignPages(items, savedPages, projectId, contextId, perPage) {
  const pageOf = {}
  const counts = {}
  const unassigned = []
  for (const it of items) {
    const p = savedPages[posKey(projectId, contextId, it.id)]
    if (Number.isInteger(p) && p >= 0) { pageOf[it.id] = p; counts[p] = (counts[p] || 0) + 1 }
    else unassigned.push(it)
  }
  let cursor = 0
  for (const it of unassigned) {
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
      ? Math.max(base * 0.14, MIN_R)
      : Math.max(Math.min(width, availH) * 0.27, MIN_R)
    return [{ ...items[0], cx: cx0, cy: cy0, r }]
  }

  const bubbleItems = items.filter(i => i.type !== 'note')
  // Log-scale bubble sizes by total nested content (notes + descendant bubbles),
  // relative to the busiest bubble in this view.
  const maxContent = Math.max(...bubbleItems.map(i => i.contentCount || 0), 1)
  const minR = Math.max(base * 0.15, MIN_R)
  const maxR = Math.max(Math.min(base * 0.42, 124), minR)
  // Note cards are a fixed consistent size — only category bubbles scale
  const noteR = Math.max(base * 0.14, MIN_R)

  const radii = items.map(item => {
    if (item.type === 'note') return noteR
    const content = item.contentCount || 0
    const t = Math.log(content + 1) / Math.log(maxContent + 1)
    return minR + (maxR - minR) * t
  })

  // Tighter circle-packing when crowded: shrink the inter-bubble gap as the
  // count grows so many bubbles pack closer together.
  const packGap = n > 16 ? 8 : n > 10 ? 12 : 16

  const GA = Math.PI * (3 - Math.sqrt(5))
  let pos = items.map((item, i) => {
    const angle = i * GA
    const dist = base * 0.46 * Math.sqrt(i / (n - 1 || 1))
    return { ...item, x: dist * Math.cos(angle), y: dist * Math.sin(angle), r: radii[i] }
  })

  for (let iter = 0; iter < 240; iter++) {
    let any = false
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j]
        const dx = b.x - a.x, dy = b.y - a.y
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
    if (!any) break
  }

  // Tighter margin around the cluster when crowded so it can scale up to fill more.
  const pad = n > 10 ? 16 : 28
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
    // Enforce the minimum ON SCREEN — the fit-scale above must not shrink a
    // bubble below MIN_R, otherwise the minimum has no visible effect.
    r: Math.max(p.r * scale, MIN_R),
  }))

  // Flooring the radius can re-introduce overlaps; relax in screen space with a
  // tight gap, clamping every bubble fully on-screen each pass so nothing ends up
  // off the viewport. (When bubbles can't all fit at the minimum size they will
  // pack tightly / overlap rather than shrink below it.)
  const clampXY = (p) => {
    p.cx = Math.max(p.r + 8, Math.min(width - p.r - 8, p.cx))
    p.cy = Math.max(headerH + p.r + 8, Math.min(height - bottomPad - p.r, p.cy))
  }
  const tightGap = Math.min(packGap, 10)
  for (let iter = 0; iter < 160; iter++) {
    let any = false
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i], b = result[j]
        const dx = b.cx - a.cx, dy = b.cy - a.cy
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
    result.forEach(clampXY)
    if (!any) break
  }

  // Keep every bubble fully clear of the + button (full-circle barrier, all sides).
  result.forEach(item => keepClearOfPlusButton(item, width, height, headerH, height - bottomPad))

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

  const floatAmt      = 5 + (index % 3) * 3
  const floatDuration = 2.6 + (index % 4) * 0.45
  const floatDelay    = (index * 0.22) % 3

  const label    = getNoteTitle(item.content) || 'New note'
  const lines    = (item.content || '').split('\n').filter(l => l.trim())
  const bodyText = lines.slice(1).join(' ').trim() // content after the first (title) line
  const fontSize = Math.max(Math.min(r * 0.17, 13), 8)
  const subSize  = Math.max(Math.min(r * 0.13, 10), 7)
  const iconSize = Math.max(Math.min(r * 0.18, 12), 8)

  // The body preview (line 2+) is shown ONLY when the whole first line (the title) is
  // fully visible without truncation. We reserve room for the body, clamp the title to
  // that region, then MEASURE whether the title actually fits — if it's truncated, the
  // body is hidden entirely.
  const CHAR_W = 0.55
  const usableW = Math.max(W * 0.86, 1)
  const charsPerLine = Math.max(1, Math.floor(usableW / (fontSize * CHAR_W)))
  const totalLineCapacity = Math.max(1, Math.floor((H * 0.9) / (fontSize * 1.25)))
  const hasBodyText = bodyText.length > 0
  // Lines the title may use: full card when there's no body, else reserve up to 2 for it.
  const titleClamp = hasBodyText ? Math.max(1, totalLineCapacity - 2) : totalLineCapacity

  const titleRef = useRef(null)
  // Initial guess from the char estimate (avoids a first-frame flash); the measurement
  // below corrects it.
  const [titleTruncated, setTitleTruncated] = useState(
    () => hasBodyText && Math.ceil(label.length / charsPerLine) > titleClamp
  )
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    // With -webkit-line-clamp, the title is truncated iff its full content is taller
    // than the clamped box.
    setTitleTruncated(el.scrollHeight > el.clientHeight + 1)
  }, [label, W, H, fontSize, titleClamp])

  const showBody = hasBodyText && !titleTruncated
  const bodyLines = showBody ? Math.min(2, totalLineCapacity - titleClamp) : 0

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
          WebkitLineClamp: titleClamp,
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
  const r = p.r
  const btnCx = width - 52, btnCy = height - 52
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
// Mutates p.cx / p.cy in place.
function clampToBounds(p, width, height) {
  const r = p.r
  p.cx = Math.max(r + 12, Math.min(width - r - 12, p.cx))
  p.cy = Math.max(SUB_BAR_H + r + 12, Math.min(height - BOTTOM_PAD - r, p.cy))
  keepClearOfPlusButton(p, width, height, SUB_BAR_H, height - BOTTOM_PAD)
}

// Safety pass: after any data change / re-render, push apart any bubbles that
// overlap (e.g. a bubble grew, or saved positions no longer fit), leaving a small
// visual buffer so they never touch. Re-applies bounds + the + button barrier too.
function separateOverlaps(items, width, height) {
  const BUFFER = 3 // px gap so bubbles never visually touch
  const pos = items.map(i => ({ ...i }))
  for (let iter = 0; iter < 60; iter++) {
    let moved = false
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j]
        const dx = b.cx - a.cx, dy = b.cy - a.cy
        const d = Math.sqrt(dx * dx + dy * dy) || 0.001
        const need = cr(a) + cr(b) + BUFFER
        if (d < need) {
          const push = (need - d) / 2
          const nx = dx / d, ny = dy / d
          a.cx -= nx * push; a.cy -= ny * push
          b.cx += nx * push; b.cy += ny * push
          moved = true
        }
      }
    }
    pos.forEach(p => clampToBounds(p, width, height))
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
  const PAGE_GAP = 18
  const pageAvailH = size.height - SUB_BAR_H - BOTTOM_PAD
  const colsCap = Math.max(1, Math.floor(size.width / (PAGE_MIN_D + PAGE_GAP)))
  const rowsCap = Math.max(1, Math.floor(pageAvailH / (PAGE_MIN_D + PAGE_GAP)))
  const perPage = Math.max(1, colsCap * rowsCap)
  const paginated = size.width > 0 && layoutItems.length > perPage

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
  const laidSettled = (anchoredIds.size > 0 && anchoredIds.size < laidMapped.length && size.width > 0)
    ? settleItems(laidMapped, anchoredIds, size.width, size.height)
    : laidMapped

  // Final safety pass every render: separate any overlapping bubbles (with a small
  // buffer so they never touch) and re-apply the + button barrier and bounds.
  const laidWithOverrides = size.width > 0
    ? separateOverlaps(laidSettled, size.width, size.height)
    : laidSettled

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
