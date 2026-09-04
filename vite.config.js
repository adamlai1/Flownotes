import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { SEED_BUBBLES } from './src/data/defaultData.js'

// Build identity, shown at the bottom of Settings. Answers "which web bundle is
// this device actually running?" from inside the app — the question behind
// every stale-bundle debugging session (ios/App/App/public is untracked, so
// the native shell can silently run JavaScript older than the Swift beside
// it). The commit is the truth; the date makes an uncommitted local build
// distinguishable from the last commit's.
function buildStamp() {
  let sha = 'nogit'
  try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch {}
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${sha} · ${date}`
}

// The version feedback rows are stamped with. Read from package.json at build time and
// substituted as a literal, so the client ships the string alone rather than importing
// package.json (which would bundle the whole dependency list to get one field).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// ── Splash seed bubbles ──────────────────────────────────────────────────────
// Renders the public splash's bubble cluster into index.html at build/serve
// time from the REAL seed bubbles (names + colors from SEED_BUBBLES), so a
// seed change can't drift the splash, while the served HTML stays fully
// static for crawlers. Card treatment mirrors the app's dark-theme bubble in
// BubbleVisualization.jsx: a 2 : 1.33 rounded rect, corner radius 22% of
// height (border-radius 14.6%/22% keeps that ratio at any scale), white 28%
// border, white→color radial fill, and the color glow box-shadow.
function splashSeedBubbles() {
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
  }
  // Splash-only geometry: size scalar r and center (x, y) on a 340×200 canvas,
  // one slot per top-level seed in list order. Extra future seeds beyond the
  // slots are simply not drawn.
  const SLOTS = [
    { r: 46, x: 62, y: 72 },
    { r: 34, x: 178, y: 44 },
    { r: 31, x: 159, y: 150 },
    { r: 38, x: 263, y: 103 },
  ]
  const cards = SEED_BUBBLES.filter(b => b.parent_id === null).map((b, i) => {
    const s = SLOTS[i]
    if (!s) return ''
    const rgb = hexToRgb(b.color)
    const w = s.r * 2, h = s.r * 1.33
    const pct = (v, base) => `${(v / base * 100).toFixed(1)}%`
    return `<div class="bub" style="` +
      `left:${pct(s.x - w / 2, 340)};top:${pct(s.y - h / 2, 200)};width:${pct(w, 340)};` +
      `background:radial-gradient(circle at 30% 30%, rgba(255,255,255,0.24) 0%, rgba(${rgb},0.22) 55%, rgba(${rgb},0.07) 100%);` +
      `box-shadow:0 8px 32px rgba(${rgb},0.42), 0 2px 10px rgba(0,0,0,0.3);` +
      `font-size:${Math.round(s.r * 0.33)}px;animation-delay:${(i * 0.9).toFixed(1)}s">` +
      `${b.name}</div>`
  }).join('')
  return {
    name: 'splash-seed-bubbles',
    transformIndexHtml: (html) => html.replace('<!--@splash-seed-bubbles@-->', cards),
  }
}

export default defineConfig({
  plugins: [react(), splashSeedBubbles()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_STAMP__: JSON.stringify(buildStamp()),
  },
  server: {
    host: true,
  },
})
