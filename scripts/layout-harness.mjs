// Layout harness: drives the REAL canvas layout pipeline (layoutPage → computeLayout →
// saved positions → arrange/settle → separateOverlaps) from Node, with generated pages,
// and measures residual overlap by box intersection — the same measure the on-device
// DOM check uses. Used to diagnose and validate post-mutation overlap without a device.
//
//   node scripts/layout-harness.mjs            # add + remove sweeps, with convergence stats
//   node scripts/layout-probe.mjs [seed nB mode n]   # stage-by-stage look at one step
//   node scripts/layout-shape-exp.mjs          # same anchors+count: add/remove/shuffled sets
//   node scripts/layout-anchor-exp.mjs         # does the anchors' capture density matter?
//   LAYOUT_ENTRY=<variant.jsx> node scripts/layout-harness.mjs   # A/B a modified copy
//
// TESTING LESSON (2026-09-04): the removal fix before this harness was validated from
// anchors captured on a COMPACT, dense layout, so its scenarios never reached the
// density band where the pass fails — "removal is clean" was an artefact of where the
// anchors came from, not a property of the removal path. Validate every layout change
// against BOTH sweeps AND vary where the anchors are captured (see anchorAt / the
// anchor experiment); report the table, not a verdict.
//
// Findings on 2026-09-04 (see the commit that added this): the pipeline is a pure
// function of (anchored positions, item count, seed) — add-shaped and remove-shaped
// note sets of the same count fail identically — so "overlap on add" is overlap at
// DENSITY, reached first by adding. Two mechanisms: the + button corner pocket stacked
// trapped items on one point (fixed: in-loop ejection), and near-capacity pinned/
// ellipse arrangements the pass cannot solve from a fresh-layout start (open; a
// capacity or placement question, not an iteration one — 3x iterations barely helps).
//
// Only layout functions are exercised; React, framer-motion, contexts and sibling
// components are stubbed at bundle time. Nothing here ships.
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STUBS = {
  'react-dom': "export const flushSync = (f) => f(); export const createPortal = (c) => c",
  'framer-motion': "export const motion = new Proxy({}, { get: () => () => null }); export const AnimatePresence = () => null; export const useMotionValue = (v) => ({ get: () => v, set() {} }); export const animate = () => ({ stop() {} });",
  '../contexts/ThemeContext': "export const useTheme = () => ({ theme: 'dark' })",
  '../contexts/PreferencesContext': "export const usePreferences = () => ({ noteSize: 'medium', bouncy: true }); export const NOTE_SIZE_SCALE = { small: 0.85, medium: 1, large: 1.2 }",
  '../contexts/LockContext': "export const useLock = () => ({})",
  '../contexts/ToastContext': "export const useToast = () => () => {}",
  '../lib/escapeStack': "export const useEscapeLayer = () => {}; export const ESC_LEVEL = {}",
  '../lib/dismiss': "export const useDismissOnOutside = () => {}",
  '../lib/bodyScrollLock': "export const useBodyScrollLock = () => {}",
  '../utils/noteShare': "export const canShareNotes = () => false; export const copyNoteText = () => {}; export const shareNoteText = () => {}",
  './ConfirmDialog': "export default () => null",
  './BubbleColorPicker': "export default () => null",
  './BubbleNameInput': "export default () => null",
  './BubblePickerTree': "export default () => null",
}
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, args => (STUBS[args.path] ? { path: args.path, namespace: 'stub' } : null))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: STUBS[args.path], loader: 'js' }))
  },
}

globalThis.window = globalThis
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }
try { Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'node' }, configurable: true }) } catch {}
globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: (t) => ({ width: t.length * 7 }) }) }) }
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

export async function loadLayout() {
  const out = await build({
    entryPoints: [process.env.LAYOUT_ENTRY || 'src/components/BubbleVisualization.jsx'],
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic',
    plugins: [stubPlugin], logLevel: 'silent',
  })
  const dir = mkdtempSync(join(tmpdir(), 'nubble-layout-'))
  const file = join(dir, 'bv.mjs')
  writeFileSync(file, out.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

// ── Geometry (mirrors the component's constants; box intersection, no gap) ─────
const NOTE_HW = 1.55 / 2, NOTE_HH = 1.15 / 2, BUB_HW = 1, BUB_HH = 1.33 / 2
const hw = p => p.type === 'note' ? p.r * NOTE_HW : p.r * BUB_HW
const hh = p => p.type === 'note' ? p.r * NOTE_HH : p.r * BUB_HH
export function overlaps(pos, tol = 0.5) {
  const bad = []
  for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
    const a = pos[i], b = pos[j]
    const ox = hw(a) + hw(b) - Math.abs(a.cx - b.cx)
    const oy = hh(a) + hh(b) - Math.abs(a.cy - b.cy)
    if (ox > tol && oy > tol) bad.push({ a: a.id, b: b.id, depth: +Math.min(ox, oy).toFixed(1), types: a.type[0] + b.type[0] })
  }
  return bad
}
export const fmtBad = bad => bad.map(b => b.a + '/' + b.b + '(' + b.types + ',' + b.depth + ')').join(' ')

// ── Scenario generator ────────────────────────────────────────────────────────
export function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }
export const W = 390, H = 844, SAFE = 34, SCALE = 1, PID = 'p', CTX = null

export function makeItems(nBubbles, nNotes, rand) {
  const items = []
  for (let i = 0; i < nBubbles; i++) items.push({ id: 'b' + i, type: 'bubble', contentCount: 1 + Math.floor(rand() * 12), name: 'B' + i })
  for (let i = 0; i < nNotes; i++) items.push({ id: 'n' + i, type: 'note', content: 'note ' + i })
  return items
}
export const toSaved = (BV, laid, ids) => Object.fromEntries(laid.filter(p => ids.has(p.id)).map(p => [BV.posKey(PID, CTX, p.id), { xFrac: p.cx / W, yFrac: p.cy / H }]))

export function anchorSet(laid, anchorMode) {
  if (anchorMode === 'all') return new Set(laid.map(p => p.id))
  if (anchorMode === 'bubbles+half') return new Set(laid.filter((p, i) => p.type !== 'note' || i % 2 === 0).map(p => p.id))
  if (anchorMode === 'bubbles') return new Set(laid.filter(p => p.type !== 'note').map(p => p.id))
  return new Set()
}

// One run: start with nBubbles + n0 notes, converge, anchor per `anchorMode`, then add
// notes one at a time through the real pipeline until the page would paginate.
// `onStep(items, saved, laid)` lets a caller capture a specific step's inputs.
export function run(BV, { seed, nBubbles, n0, anchorMode, verbose, onStep, anchorAt }) {
  const rand = rng(seed)
  // Anchors are captured from a converged layout at `anchorAt` notes (default n0):
  // a sparse capture spreads the bubbles across the page, a dense one clusters them.
  const nAnchor = anchorAt ?? n0
  let items = makeItems(nBubbles, nAnchor, rand)
  let laid = BV.layoutPage(items, {}, PID, CTX, W, H, SCALE, seed, SAFE)
  const saved = toSaved(BV, laid, anchorSet(laid, anchorMode))
  items = makeItems(nBubbles, n0, rng(seed))
  const rows = []
  let k = n0
  for (;;) {
    const bubbleN = items.filter(i => i.type !== 'note').length, noteN = items.filter(i => i.type === 'note').length
    const { pageLoad, perPage } = BV.pageLoadFor(bubbleN, noteN, W, H, SCALE, SAFE)
    if (pageLoad > 1) { rows.push({ step: 'n=' + noteN, note: 'paginates (perPage ' + perPage + ') - stop' }); break }
    laid = BV.layoutPage(items, saved, PID, CTX, W, H, SCALE, seed, SAFE)
    const bad = overlaps(laid)
    onStep?.({ noteN, items, saved, laid, bad })
    rows.push({
      step: 'n=' + noteN, anchored: Object.keys(saved).length, overlaps: bad.length,
      worst: bad.length ? Math.max(...bad.map(b => b.depth)) : 0,
      pairs: verbose && bad.length ? fmtBad(bad) : '',
      // Is a residual overlap slow convergence or a page the constraints can't satisfy?
      // Re-run the final pass (same mode the pipeline used) up to 10 more times.
      extraPasses: bad.length ? extraPassesToClear(BV, laid, saved, items) : 0,
    })
    // The app's createNote: a new id with no saved position.
    items = [...items, { id: 'n' + (k++), type: 'note', content: 'new' }]
    if (noteN > 60) break
  }
  return rows
}

// Same mode layoutPage's final pass used for these inputs (pinned when mixed; the
// free-note ellipse set when anything is anchored), applied again up to 10 times.
// Returns the number of extra passes that cleared it, or 'stuck'.
function extraPassesToClear(BV, laid, saved, items) {
  const anchored = new Set(items.filter(it => saved[BV.posKey(PID, CTX, it.id)]).map(it => it.id))
  const mixed = items.some(i => i.type === 'note') && items.some(i => i.type !== 'note')
  const pin = mixed && (anchored.size > 0 ? true : true)
  const freeIds = anchored.size > 0 ? new Set(items.filter(p => p.type === 'note' && !anchored.has(p.id)).map(p => p.id)) : null
  let pos = laid
  for (let k = 1; k <= 10; k++) {
    pos = BV.separateOverlaps(pos, W, H, pin, freeIds, SAFE)
    if (!overlaps(pos).length) return k
  }
  return 'stuck'
}

// Removal path: start at a dense, converged, anchored page and remove notes one at a
// time — the case the earlier jam-escape fix was validated on; must not regress.
export function runRemove(BV, { seed, nBubbles, anchorMode, verbose }) {
  const rand = rng(seed)
  // Start one below pagination.
  let n = 4
  for (;;) {
    const { pageLoad } = BV.pageLoadFor(nBubbles, n + 1, W, H, SCALE, SAFE)
    if (pageLoad > 1) break
    n++
  }
  let items = makeItems(nBubbles, n, rand)
  let laid = BV.layoutPage(items, {}, PID, CTX, W, H, SCALE, seed, SAFE)
  const saved = toSaved(BV, laid, anchorSet(laid, anchorMode))
  const rows = []
  while (items.filter(i => i.type === 'note').length > 2) {
    // Remove a note from the middle of the list (not always the newest).
    const notes = items.filter(i => i.type === 'note')
    const victim = notes[Math.floor(rand() * notes.length)].id
    items = items.filter(i => i.id !== victim)
    laid = BV.layoutPage(items, saved, PID, CTX, W, H, SCALE, seed, SAFE)
    const bad = overlaps(laid)
    const noteN = items.filter(i => i.type === 'note').length
    rows.push({ step: 'n=' + noteN, overlaps: bad.length, worst: bad.length ? Math.max(...bad.map(b => b.depth)) : 0, pairs: verbose && bad.length ? fmtBad(bad) : '' })
  }
  return rows
}

export function sweep(BV, { seeds = [1, 2, 3, 4, 5], bubbleCounts = [0, 3, 5], modes = ['none', 'bubbles', 'bubbles+half', 'all'], n0 = 4, runner = run, anchorAt } = {}) {
  const summary = {}
  let totalSteps = 0, badSteps = 0
  const depths = { '<=1': 0, '<=3': 0, '<=8': 0, '>8': 0 }
  const extra = { '1': 0, '2-3': 0, '4-10': 0, stuck: 0 }
  for (const seed of seeds) for (const nBubbles of bubbleCounts) for (const anchorMode of modes) {
    const rows = runner(BV, { seed, nBubbles, n0, anchorMode, anchorAt })
    const key = nBubbles + 'b/' + anchorMode
    summary[key] ??= { steps: 0, bad: 0, firstBadAt: [], paginatesAt: [] }
    let first = null
    for (const r of rows) {
      if (r.note && r.note.startsWith('paginates')) { summary[key].paginatesAt.push(r.step); continue }
      if (r.overlaps === undefined) continue
      totalSteps++; summary[key].steps++
      if (r.overlaps > 0) {
        badSteps++; summary[key].bad++; if (first === null) first = r.step
        depths[r.worst <= 1 ? '<=1' : r.worst <= 3 ? '<=3' : r.worst <= 8 ? '<=8' : '>8']++
        if (r.extraPasses !== undefined) extra[r.extraPasses === 'stuck' ? 'stuck' : r.extraPasses === 1 ? '1' : r.extraPasses <= 3 ? '2-3' : '4-10']++
      }
    }
    summary[key].firstBadAt.push(first ?? '-')
  }
  return { summary, totalSteps, badSteps, depths, extra }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const BV = await loadLayout()
  const add = sweep(BV)
  console.log('ADD sweep: ' + add.totalSteps + ' steps, ' + add.badSteps + ' with residual overlap')
  console.log('  worst depth of bad steps:', JSON.stringify(add.depths), ' extra passes to clear:', JSON.stringify(add.extra), '\n')
  console.table(Object.entries(add.summary).map(([k, v]) => ({ scenario: k, steps: v.steps, badSteps: v.bad, firstOverlapAt: v.firstBadAt.join(' '), paginatesAt: v.paginatesAt.join(' ') })))
  const rem = sweep(BV, { runner: runRemove })
  console.log('\nREMOVE sweep: ' + rem.totalSteps + ' steps, ' + rem.badSteps + ' with residual overlap')
  console.log('  worst depth of bad steps:', JSON.stringify(rem.depths), '\n')
  console.table(Object.entries(rem.summary).map(([k, v]) => ({ scenario: k, steps: v.steps, badSteps: v.bad, firstOverlapAt: v.firstBadAt.join(' ') })))
}
