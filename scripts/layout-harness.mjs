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
//   LAYOUT_FILLS=0.5,0.55 node scripts/layout-harness.mjs        # sweep the area fill
//   LAYOUT_ONLY=add,remove node scripts/layout-harness.mjs       # skip the anchor variants
//   LAYOUT_MIXED_GROWTH=0 ...                                    # bubbles stay at floor on mixed pages
//
// AREA MODEL (2026-09-04): capacity is one area budget per page (pageBudget) against
// one charge per item (chargeOf at floorRFor); see the "area model" block in the
// component. The sweeps report, per step, the distribution measures too (see
// distribution below): a page that packs without overlap can still be a corner clump
// or a grid, and those pass an overlap check.
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
export const W = +(process.env.LAYOUT_W || 390), H = +(process.env.LAYOUT_H || 844), SAFE = +(process.env.LAYOUT_SAFE || 34), SCALE = +(process.env.LAYOUT_SCALE || 1), PID = 'p', CTX = null

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

// ── Distribution measures ────────────────────────────────────────────────────
// A page that packs without overlap can still be wrong: everything in one corner, or
// everything on a grid, passes an overlap check. These are the measures that catch it.
const SUB_BAR_H = 40, EDGE_INSET = 12
export function distribution(BV, laid) {
  const n = laid.length
  if (n === 0) return null
  const usableArea = BV.pageBudget(W, H, SAFE) / BV.LAYOUT_TUNING.areaFill
  const mixed = laid.some(p => p.type === 'note') && laid.some(p => p.type !== 'note')
  const charges = laid.map(p => BV.chargeOf(p.type, p.r, mixed))
  const totalCharge = charges.reduce((a, b) => a + b, 0)
  const chargeShare = totalCharge / usableArea
  // Area-weighted centroid offset from the page centre, as a fraction of the half-diagonal.
  const cx0 = W / 2, cy0 = (SUB_BAR_H + H + SAFE) / 2
  const mx = laid.reduce((a, p, k) => a + p.cx * charges[k], 0) / totalCharge
  const my = laid.reduce((a, p, k) => a + p.cy * charges[k], 0) / totalCharge
  const centroidOffset = Math.hypot(mx - cx0, my - cy0) / Math.hypot(W / 2, (H + SAFE - SUB_BAR_H) / 2)
  // Spread: the items' bounding box over the usable area, relative to their charge share.
  // ~1 means the items sit in a box no bigger than themselves (a clump); larger is spread.
  const minX = Math.min(...laid.map(p => p.cx - hw(p))), maxX = Math.max(...laid.map(p => p.cx + hw(p)))
  const minY = Math.min(...laid.map(p => p.cy - hh(p))), maxY = Math.max(...laid.map(p => p.cy + hh(p)))
  const bboxFill = ((maxX - minX) * (maxY - minY)) / usableArea
  const spread = bboxFill / Math.max(chargeShare, 1e-6)
  // Nearest-neighbour edge gap per item; the fraction sitting at the minimum gap is
  // what makes a page read as a grid.
  const gaps = laid.map((a, i) => {
    let best = Infinity
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const b = laid[j]
      const gx = Math.abs(a.cx - b.cx) - hw(a) - hw(b)
      const gy = Math.abs(a.cy - b.cy) - hh(a) - hh(b)
      best = Math.min(best, Math.max(gx, gy))
    }
    return best
  }).filter(g => isFinite(g))
  const sorted = gaps.slice().sort((a, b) => a - b)
  const medianGap = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const atMinGap = gaps.length ? gaps.filter(g => g <= 12).length / gaps.length : 0
  // Size-to-centre: Spearman rank correlation between charge and distance from the
  // centre. Negative means bigger items sit nearer the middle. Only meaningful with
  // more than one size on the page.
  let sizeCentreCorr = null
  const dists = laid.map(p => Math.hypot(p.cx - cx0, p.cy - cy0))
  if (n >= 3 && new Set(charges.map(c => Math.round(c))).size > 1) {
    const rank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => { r[i] = k }); return r }
    const rc = rank(charges), rd = rank(dists)
    const mc = (n - 1) / 2
    let num = 0, dc = 0, dd = 0
    for (let k = 0; k < n; k++) { num += (rc[k] - mc) * (rd[k] - mc); dc += (rc[k] - mc) ** 2; dd += (rd[k] - mc) ** 2 }
    sizeCentreCorr = dc && dd ? num / Math.sqrt(dc * dd) : 0
  }
  return { chargeShare, centroidOffset, spread, medianGap, atMinGap, sizeCentreCorr }
}

function summariseDist(list) {
  const mean = (k) => { const v = list.map(d => d[k]).filter(x => x !== null && x !== undefined && isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
  const f = (x, d = 2) => x === null ? '-' : x.toFixed(d)
  return {
    share: f(mean('chargeShare')), offset: f(mean('centroidOffset')), spread: f(mean('spread'), 1),
    medGap: f(mean('medianGap'), 0), atMin: f(mean('atMinGap')), sizeCorr: f(mean('sizeCentreCorr')),
  }
}

// One run: start with nBubbles + n0 notes, converge, anchor per `anchorMode`, then add
// notes one at a time through the real pipeline until the page would paginate.
// `onStep(items, saved, laid)` lets a caller capture a specific step's inputs.
// Every step also re-packs the level (assignPages) and counts already-placed items that
// changed page — the displacement check — which continues past pagination for a few
// steps so the packer is exercised where it matters.
export function run(BV, { seed, nBubbles, n0, anchorMode, verbose, onStep, anchorAt }) {
  const rand = rng(seed)
  const nAnchor = anchorAt ?? n0
  let items = makeItems(nBubbles, nAnchor, rand)
  let laid = BV.layoutPage(items, {}, PID, CTX, W, H, SCALE, seed, SAFE)
  const saved = toSaved(BV, laid, anchorSet(laid, anchorMode))
  items = makeItems(nBubbles, n0, rng(seed))
  const rows = []
  let k = n0
  let prevPageOf = null
  let pastPagination = 0
  const geom = { width: W, height: H, noteScale: SCALE, safeBottom: SAFE }
  for (;;) {
    const noteN = items.filter(i => i.type === 'note').length
    const { pageLoad } = BV.pageLoadFor(items, W, H, SCALE, SAFE)
    const pageOf = BV.assignPages(items, {}, PID, CTX, geom)
    let moved = 0
    if (prevPageOf) for (const [id, p] of Object.entries(prevPageOf)) if (pageOf[id] !== undefined && pageOf[id] !== p) moved++
    prevPageOf = pageOf
    if (pageLoad > 1) {
      if (pastPagination === 0) rows.push({ step: 'n=' + noteN, note: 'paginates - stop', moved })
      else rows.push({ step: 'n=' + noteN, note: 'paginated', moved })
      if (++pastPagination > 6) break
      items = [...items, { id: 'n' + (k++), type: 'note', content: 'new', created_at: new Date(2000000000000 + k * 1000).toISOString() }]
      continue
    }
    laid = BV.layoutPage(items, saved, PID, CTX, W, H, SCALE, seed, SAFE)
    const bad = overlaps(laid)
    onStep?.({ noteN, items, saved, laid, bad })
    rows.push({
      step: 'n=' + noteN, anchored: Object.keys(saved).length, overlaps: bad.length,
      worst: bad.length ? Math.max(...bad.map(b => b.depth)) : 0,
      pairs: verbose && bad.length ? fmtBad(bad) : '',
      extraPasses: bad.length ? extraPassesToClear(BV, laid, saved, items) : 0,
      dist: distribution(BV, laid),
      moved,
    })
    items = [...items, { id: 'n' + (k++), type: 'note', content: 'new', created_at: new Date(2000000000000 + k * 1000).toISOString() }]
    if (noteN > 60) break
  }
  return rows
}

function extraPassesToClear(BV, laid, saved, items) {
  const anchored = new Set(items.filter(it => saved[BV.posKey(PID, CTX, it.id)]).map(it => it.id))
  const mixed = items.some(i => i.type === 'note') && items.some(i => i.type !== 'note')
  const pin = mixed
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
  let n = 4
  for (;;) {
    const { pageLoad } = BV.pageLoadFor(makeItems(nBubbles, n + 1, rng(seed)), W, H, SCALE, SAFE)
    if (pageLoad > 1) break
    n++
  }
  let items = makeItems(nBubbles, n, rand)
  let laid = BV.layoutPage(items, {}, PID, CTX, W, H, SCALE, seed, SAFE)
  const saved = toSaved(BV, laid, anchorSet(laid, anchorMode))
  const rows = []
  while (items.filter(i => i.type === 'note').length > 2) {
    const notes = items.filter(i => i.type === 'note')
    const victim = notes[Math.floor(rand() * notes.length)].id
    items = items.filter(i => i.id !== victim)
    laid = BV.layoutPage(items, saved, PID, CTX, W, H, SCALE, seed, SAFE)
    const bad = overlaps(laid)
    const noteN = items.filter(i => i.type === 'note').length
    rows.push({ step: 'n=' + noteN, overlaps: bad.length, worst: bad.length ? Math.max(...bad.map(b => b.depth)) : 0, pairs: verbose && bad.length ? fmtBad(bad) : '', dist: distribution(BV, laid), extraPasses: bad.length ? extraPassesToClear(BV, laid, saved, items) : 0 })
  }
  return rows
}

export function sweep(BV, { seeds = [1, 2, 3, 4, 5], bubbleCounts = [0, 3, 5], modes = ['none', 'bubbles', 'bubbles+half', 'all'], n0 = 4, runner = run, anchorAt } = {}) {
  const summary = {}
  let totalSteps = 0, badSteps = 0, displaced = 0
  const depths = { '<=1': 0, '<=3': 0, '<=8': 0, '>8': 0 }
  const extra = { '1': 0, '2-3': 0, '4-10': 0, stuck: 0 }
  const allDist = []
  for (const seed of seeds) for (const nBubbles of bubbleCounts) for (const anchorMode of modes) {
    const rows = runner(BV, { seed, nBubbles, n0, anchorMode, anchorAt })
    const key = nBubbles + 'b/' + anchorMode
    summary[key] ??= { steps: 0, bad: 0, firstBadAt: [], paginatesAt: [], dist: [], moved: 0 }
    let first = null
    for (const r of rows) {
      if (r.moved) { displaced += r.moved; summary[key].moved += r.moved }
      if (r.note && r.note.startsWith('paginates')) { summary[key].paginatesAt.push(r.step); continue }
      if (r.overlaps === undefined) continue
      totalSteps++; summary[key].steps++
      if (r.dist) { summary[key].dist.push(r.dist); allDist.push(r.dist) }
      if (r.overlaps > 0) {
        badSteps++; summary[key].bad++; if (first === null) first = r.step
        depths[r.worst <= 1 ? '<=1' : r.worst <= 3 ? '<=3' : r.worst <= 8 ? '<=8' : '>8']++
        if (r.extraPasses !== undefined) extra[r.extraPasses === 'stuck' ? 'stuck' : r.extraPasses === 1 ? '1' : r.extraPasses <= 3 ? '2-3' : '4-10']++
      }
    }
    summary[key].firstBadAt.push(first ?? '-')
  }
  return { summary, totalSteps, badSteps, depths, extra, displaced, dist: summariseDist(allDist) }
}

export function printSweep(label, res, withPaginates = true) {
  console.log(`${label}: ${res.totalSteps} steps, ${res.badSteps} with residual overlap, ${res.displaced} placed items moved to another page by an add`)
  console.log('  worst depth of bad steps:', JSON.stringify(res.depths), withPaginates ? ' extra passes to clear: ' + JSON.stringify(res.extra) : '')
  console.log('  distribution (means): ' + JSON.stringify(res.dist))
  console.table(Object.entries(res.summary).map(([k, v]) => {
    const d = summariseDist(v.dist)
    const row = { scenario: k, steps: v.steps, bad: v.bad, firstOverlapAt: v.firstBadAt.join(' ') }
    if (withPaginates) { row.paginatesAt = v.paginatesAt.join(' '); row.moved = v.moved }
    return { ...row, share: d.share, offset: d.offset, spread: d.spread, medGap: d.medGap, atMin: d.atMin, sizeCorr: d.sizeCorr }
  }))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const BV = await loadLayout()
  const fills = (process.env.LAYOUT_FILLS || String(BV.LAYOUT_TUNING.areaFill)).split(',').map(Number)
  if (process.env.LAYOUT_MIXED_GROWTH) BV.LAYOUT_TUNING.mixedGrowth = process.env.LAYOUT_MIXED_GROWTH !== '0'
  if (process.env.LAYOUT_NOTE_WASTE) BV.LAYOUT_TUNING.noteMixedWaste = Number(process.env.LAYOUT_NOTE_WASTE)
  const only = process.env.LAYOUT_ONLY || 'add,remove,anchors'
  for (const fill of fills) {
    BV.LAYOUT_TUNING.areaFill = fill
    console.log(`\n══════ AREA_FILL ${fill} ══════`)
    console.log(`  (mixedGrowth ${BV.LAYOUT_TUNING.mixedGrowth}, bubbleConvexity ${BV.LAYOUT_TUNING.bubbleConvexity}, noteMixedWaste ${BV.LAYOUT_TUNING.noteMixedWaste}, floorContentMin ${BV.LAYOUT_TUNING.floorContentMin})`)
    if (only.includes('add')) printSweep('ADD sweep', sweep(BV))
    if (only.includes('remove')) printSweep('REMOVE sweep', sweep(BV, { runner: runRemove }), true)
    if (!only.includes('anchors')) continue
    // Varied anchor capture at 5 bubbles (see the testing lesson in the header).
    for (const anchorAt of [4, 12, 20]) {
      const r = sweep(BV, { bubbleCounts: [5], anchorAt })
      console.log(`  anchors captured at ${anchorAt} notes, 5 bubbles: ${r.badSteps} bad of ${r.totalSteps}, distribution ${JSON.stringify(r.dist)}`)
    }
  }
}
