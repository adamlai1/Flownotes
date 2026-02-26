import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getNoteCountForBubble, formatDate, getPreview } from '../utils/helpers'

// ─── Utilities ───────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  if (!hex || hex[0] !== '#') return '99,102,241'
  const h = hex.length === 4
    ? hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex.slice(1)
  const n = parseInt(h, 16)
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}

function computeLayout(items, width, height, headerH = 56) {
  const n = items.length
  if (n === 0) return []

  const availH = height - headerH
  const cx0 = width / 2
  const cy0 = headerH + availH / 2

  if (n === 1) {
    const r = Math.min(width, availH) * 0.27
    return [{ ...items[0], cx: cx0, cy: cy0, r }]
  }

  const maxNotes = Math.max(...items.map(i => i.noteCount), 1)
  const base = Math.min(width, availH) * 0.4
  const minR = Math.max(base * 0.13, 34)
  const maxR = Math.min(base * 0.30, 98)

  const radii = items.map(item =>
    minR + (maxR - minR) * Math.sqrt(item.noteCount / maxNotes)
  )

  // Phyllotaxis placement from origin
  const GA = Math.PI * (3 - Math.sqrt(5))
  let pos = items.map((item, i) => {
    const angle = i * GA
    const dist = base * 0.46 * Math.sqrt(i / (n - 1 || 1))
    return { ...item, x: dist * Math.cos(angle), y: dist * Math.sin(angle), r: radii[i] }
  })

  // Force-separate overlapping circles
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

  // Scale and center to fit viewport
  const pad = 28
  const xs = pos.flatMap(p => [p.x - p.r, p.x + p.r])
  const ys = pos.flatMap(p => [p.y - p.r, p.y + p.r])
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const bw = maxX - minX || 1, bh = maxY - minY || 1
  const scale = Math.min((width - pad * 2) / bw, (availH - pad * 2) / bh, 1.4)
  const lcx = (minX + maxX) / 2, lcy = (minY + maxY) / 2

  return pos.map(p => ({
    ...p,
    cx: cx0 + (p.x - lcx) * scale,
    cy: cy0 + (p.y - lcy) * scale,
    r: p.r * scale,
  }))
}

// ─── BubbleCircle ─────────────────────────────────────────────────────────────

function BubbleCircle({ item, index, onClick }) {
  const rgb = hexToRgb(item.color)
  const fontSize = Math.max(Math.min(item.r * 0.22, 17), 10)
  const subSize = Math.max(Math.min(item.r * 0.17, 12), 9)
  const floatAmt = 5 + (index % 3) * 3

  return (
    <motion.div
      style={{
        position: 'absolute',
        left: item.cx - item.r,
        top: item.cy - item.r,
        width: item.r * 2,
        height: item.r * 2,
        borderRadius: '50%',
        background: `radial-gradient(135deg, rgba(255,255,255,0.24) 0%, rgba(${rgb},0.22) 55%, rgba(${rgb},0.07) 100%)`,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1.5px solid rgba(255,255,255,0.28)',
        boxShadow: `0 8px 40px rgba(${rgb},0.42), 0 2px 12px rgba(0,0,0,0.3), inset 0 1.5px 0 rgba(255,255,255,0.42)`,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        overflow: 'hidden',
      }}
      initial={{ scale: 0, opacity: 0 }}
      animate={{
        scale: 1,
        opacity: 1,
        y: [0, -floatAmt, 0],
      }}
      exit={{ scale: 0, opacity: 0 }}
      transition={{
        scale: { type: 'spring', stiffness: 280, damping: 24, delay: index * 0.06 },
        opacity: { duration: 0.25, delay: index * 0.06 },
        y: {
          duration: 2.6 + (index % 4) * 0.45,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: index * 0.22,
        },
      }}
      whileTap={{ scale: 0.92 }}
      onClick={onClick}
    >
      <span style={{
        fontSize,
        fontWeight: 600,
        color: 'rgba(255,255,255,0.93)',
        textAlign: 'center',
        textShadow: '0 1px 4px rgba(0,0,0,0.55)',
        padding: '0 10px',
        lineHeight: 1.25,
        maxWidth: '90%',
        wordBreak: 'break-word',
        pointerEvents: 'none',
      }}>
        {item.name}
      </span>
      {item.noteCount > 0 && (
        <span style={{
          fontSize: subSize,
          color: 'rgba(255,255,255,0.48)',
          marginTop: 4,
          fontWeight: 500,
          pointerEvents: 'none',
        }}>
          {item.noteCount} {item.noteCount === 1 ? 'note' : 'notes'}
        </span>
      )}
    </motion.div>
  )
}

// ─── GlassNoteCard ────────────────────────────────────────────────────────────

function GlassNoteCard({ note, index, onClick }) {
  const preview = getPreview(note.content, 2)
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.045, type: 'spring', stiffness: 280, damping: 28 }}
      onClick={onClick}
      whileTap={{ scale: 0.97 }}
      style={{
        background: 'rgba(255,255,255,0.09)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.18)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.2)',
        borderRadius: 16,
        padding: '14px 16px',
        cursor: 'pointer',
      }}
    >
      {preview ? (
        <p className="line-clamp-3" style={{ color: 'rgba(255,255,255,0.82)', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
          {preview}
        </p>
      ) : (
        <p style={{ color: 'rgba(255,255,255,0.28)', fontSize: 13, fontStyle: 'italic' }}>Empty note</p>
      )}
      <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, marginTop: 8 }}>
        {formatDate(note.created_at)}
      </p>
    </motion.div>
  )
}

// ─── BubbleVisualization ──────────────────────────────────────────────────────

const HEADER_H = 54

export default function BubbleVisualization({ project, onSelectNote, viewMode, onSetViewMode }) {
  const containerRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [navStack, setNavStack] = useState([])
  // Zoom-in overlay: expands from clicked bubble to fill screen
  const [zoomOverlay, setZoomOverlay] = useState(null) // {color, cx, cy, r}
  const pendingNavRef = useRef(null)
  const touchRef = useRef({ x: 0, y: 0 })

  // Reset nav when project changes
  useEffect(() => { setNavStack([]) }, [project.id])

  // Measure container
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Prevent browser pinch-zoom — capture multi-touch on this element
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const block = (e) => { if (e.touches.length > 1) e.preventDefault() }
    el.addEventListener('touchmove', block, { passive: false })
    return () => el.removeEventListener('touchmove', block)
  }, [])

  // Derived state
  const currentBubble = navStack.length > 0
    ? project.bubbles.find(b => b.id === navStack[navStack.length - 1].id)
    : null
  const currentId = currentBubble?.id ?? null
  const children = project.bubbles.filter(b => b.parent_id === currentId)
  const directNotes = currentId
    ? project.notes.filter(n => n.bubble_ids.includes(currentId))
    : []
  const isLeaf = children.length === 0 && currentId !== null

  const layoutItems = isLeaf ? [] : children.map(b => ({
    ...b,
    noteCount: getNoteCountForBubble(project.notes, b.id, project.bubbles),
  }))
  const laid = size.width > 0 ? computeLayout(layoutItems, size.width, size.height, HEADER_H) : []

  // ── Navigation ──────────────────────────────────────────────────────────────

  function zoomIn(item) {
    // Store the nav destination
    pendingNavRef.current = { id: item.id, name: item.name, color: item.color }
    // Show expanding overlay from the bubble's position
    setZoomOverlay({ color: item.color, cx: item.cx, cy: item.cy, r: item.r })
    // Commit the nav change partway through so new bubbles render under the fading overlay
    setTimeout(() => {
      if (pendingNavRef.current) {
        setNavStack(s => [...s, pendingNavRef.current])
        pendingNavRef.current = null
      }
    }, 260)
    // Remove overlay after animation finishes
    setTimeout(() => setZoomOverlay(null), 480)
  }

  function zoomOut() {
    setNavStack(s => s.slice(0, -1))
  }

  // ── Touch gestures ───────────────────────────────────────────────────────────

  function handleTouchStart(e) {
    if (e.touches.length === 1) {
      touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    }
  }
  function handleTouchEnd(e) {
    if (e.changedTouches.length === 1 && navStack.length > 0) {
      const dx = e.changedTouches[0].clientX - touchRef.current.x
      const dy = Math.abs(e.changedTouches[0].clientY - touchRef.current.y)
      if (dx > 60 && dy < 50) zoomOut()
    }
  }

  const rgb = currentBubble ? hexToRgb(currentBubble.color) : '99,102,241'
  const navKey = navStack.map(n => n.id).join('-') || 'root'

  return (
    <div
      ref={containerRef}
      className="relative flex-1"
      style={{
        overflow: 'hidden',
        touchAction: 'none',
        background: `radial-gradient(ellipse at 55% 40%, rgba(${rgb},0.28) 0%, #15122a 55%, #0c0a1a 100%)`,
        transition: 'background 0.7s ease-in-out',
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Ambient drifting orbs */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <motion.div
          className="absolute rounded-full"
          style={{
            width: '45%', height: '45%',
            background: `radial-gradient(circle, rgba(${rgb},0.14) 0%, transparent 70%)`,
            left: '5%', top: '5%',
          }}
          animate={{ x: [0, 40, 0], y: [0, -25, 0] }}
          transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute rounded-full"
          style={{
            width: '35%', height: '35%',
            background: `radial-gradient(circle, rgba(${rgb},0.1) 0%, transparent 70%)`,
            right: '8%', bottom: '15%',
          }}
          animate={{ x: [0, -30, 0], y: [0, 20, 0] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
        />
      </div>

      {/* ── Header: breadcrumb + mode toggle ── */}
      <div
        className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3"
        style={{
          minHeight: HEADER_H,
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, transparent 100%)',
        }}
      >
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 flex-1 min-w-0 mr-3">
          {navStack.length > 0 && (
            <button
              onClick={zoomOut}
              className="p-1 mr-0.5 text-white/50 hover:text-white/90 flex-shrink-0 transition-colors"
              aria-label="Go back"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setNavStack([])}
            className="text-xs text-white/50 hover:text-white/80 transition-colors flex-shrink-0 max-w-[90px] truncate"
          >
            {project.name}
          </button>
          {navStack.map((item, i) => (
            <span key={item.id} className="flex items-center gap-0.5 min-w-0">
              <span className="text-white/30 text-xs flex-shrink-0 px-0.5">›</span>
              <button
                onClick={() => setNavStack(prev => prev.slice(0, i + 1))}
                className={`text-xs transition-colors truncate ${
                  i === navStack.length - 1
                    ? 'text-white/90 font-semibold'
                    : 'text-white/50 hover:text-white/75'
                }`}
                style={{ maxWidth: i === navStack.length - 1 ? 130 : 72 }}
              >
                {item.name}
              </button>
            </span>
          ))}
        </div>

        {/* Glass mode toggle — Bubble + Chrono only */}
        <div
          className="flex-shrink-0 flex rounded-xl overflow-hidden"
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.14)',
          }}
        >
          {[
            { id: 'bubble', label: '◉' },
            { id: 'chronological', label: 'All' },
          ].map(m => (
            <button
              key={m.id}
              onClick={() => onSetViewMode(m.id)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === m.id ? 'bg-white/20 text-white' : 'text-white/45 hover:text-white/80'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main canvas — key-based re-mount per zoom level ── */}
      <AnimatePresence mode="sync">
        <motion.div
          key={navKey}
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {isLeaf ? (
            // ── Leaf: glass note cards ──────────────────────────────────────
            <div
              className="absolute inset-0 overflow-y-auto"
              style={{ paddingTop: HEADER_H + 4, paddingBottom: 96 }}
            >
              <div className="text-center pt-5 pb-4 px-4">
                <div
                  className="inline-block px-4 py-1.5 rounded-full text-sm font-semibold text-white/90 mb-1"
                  style={{
                    background: `rgba(${hexToRgb(currentBubble.color)},0.25)`,
                    border: `1px solid rgba(${hexToRgb(currentBubble.color)},0.45)`,
                    backdropFilter: 'blur(12px)',
                  }}
                >
                  {currentBubble.name}
                </div>
                <p className="text-white/38 text-xs mt-1">
                  {directNotes.length} {directNotes.length === 1 ? 'note' : 'notes'}
                </p>
              </div>
              {directNotes.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-white/25 text-sm">No notes in this bubble</p>
                  <p className="text-white/15 text-xs mt-1">Press + to add one</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-4 max-w-2xl mx-auto">
                  {directNotes.map((note, i) => (
                    <GlassNoteCard
                      key={note.id}
                      note={note}
                      index={i}
                      onClick={() => onSelectNote(note)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            // ── Non-leaf: floating bubble circles ───────────────────────────
            <div className="absolute inset-0">
              {currentBubble && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 text-center pointer-events-none select-none"
                  style={{ top: HEADER_H + 8 }}
                >
                  <span className="text-white/18 text-xs font-semibold uppercase tracking-widest">
                    {currentBubble.name}
                  </span>
                </div>
              )}
              {laid.map((item, i) => (
                <BubbleCircle
                  key={item.id}
                  item={item}
                  index={i}
                  onClick={() => zoomIn(item)}
                />
              ))}
              {laid.length === 0 && (
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ paddingTop: HEADER_H }}
                >
                  <div className="text-center">
                    <p className="text-white/25 text-sm">No bubbles in this project</p>
                    <p className="text-white/15 text-xs mt-1">Add bubbles from the sidebar</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* ── Zoom-in overlay: ripples from clicked bubble to fill screen ── */}
      <AnimatePresence>
        {zoomOverlay && (
          <motion.div
            className="absolute z-30 pointer-events-none"
            initial={{
              borderRadius: '50%',
              left: zoomOverlay.cx - zoomOverlay.r,
              top: zoomOverlay.cy - zoomOverlay.r,
              width: zoomOverlay.r * 2,
              height: zoomOverlay.r * 2,
              opacity: 0.85,
            }}
            animate={{
              borderRadius: '4%',
              left: 0,
              top: 0,
              width: size.width,
              height: size.height,
              opacity: 0,
            }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.46, ease: [0.25, 0.46, 0.45, 0.94] }}
            style={{
              background: `radial-gradient(circle, rgba(${hexToRgb(zoomOverlay.color)},0.6) 0%, rgba(${hexToRgb(zoomOverlay.color)},0.2) 100%)`,
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
