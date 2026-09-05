// Stage-by-stage look at one failing add step (see layout-harness.mjs).
//   node scripts/layout-probe.mjs [seed] [nBubbles] [anchorMode] [noteN]
import { loadLayout, overlaps, fmtBad, run, W, H, SAFE } from './layout-harness.mjs'

const seed = +(process.argv[2] ?? 1), nBubbles = +(process.argv[3] ?? 5)
const anchorMode = process.argv[4] ?? 'all', wantN = +(process.argv[5] ?? 26)
const BV = await loadLayout()
if (process.env.LAYOUT_FILL) BV.LAYOUT_TUNING.areaFill = +process.env.LAYOUT_FILL

let cap = null
run(BV, { seed, nBubbles, n0: 4, anchorMode, onStep: s => { if (s.noteN === wantN) cap = s } })
if (!cap) { console.log('step not reached'); process.exit(0) }
const { items, saved, laid, bad } = cap
console.log(`seed ${seed}, ${nBubbles} bubbles, anchor=${anchorMode}, n=${wantN}: layoutPage → ${bad.length} overlap(s) ${fmtBad(bad)}`)

// Rebuild the stages layoutPage runs, from the same inputs.
const laid0 = BV.computeLayout(items, W, H, 40, 0, 1, seed, SAFE)
const laidMapped = laid0.map(it => {
  const s = saved[BV.posKey('p', null, it.id)]
  return s ? { ...it, cx: s.xFrac * W, cy: s.yFrac * H } : it
})
const anchored = new Set(laidMapped.filter(it => saved[BV.posKey('p', null, it.id)]).map(i => i.id))
const freeIds = new Set(laidMapped.filter(p => p.type === 'note' && !anchored.has(p.id)).map(p => p.id))
console.log(`items ${items.length} (${nBubbles} bubbles), anchored ${anchored.size}, free notes ${freeIds.size}`)
console.log('  computeLayout (fresh)            :', overlaps(laid0).length, 'overlaps')
console.log('  + saved positions (laidMapped)   :', overlaps(laidMapped).length, 'overlaps', fmtBad(overlaps(laidMapped)).slice(0, 160))

const bubs = laidMapped.filter(p => p.type !== 'note')
if (bubs.length && freeIds.size) {
  const e = BV.clusterEllipse(bubs)
  console.log('  cluster ellipse:', JSON.stringify(Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(0) : v]))), 'page', W + 'x' + H)
  const pinnedNotes = new Set(laidMapped.filter(p => p.type === 'note' && anchored.has(p.id)).map(p => p.id))
  const spread = BV.lloydSpread(laidMapped, W, H, 40, 0 - SAFE, pinnedNotes)
  console.log('  lloydSpread                      :', overlaps(spread).length, 'overlaps')
  const sep1 = BV.separateOverlaps(spread, W, H, true, freeIds, SAFE)
  console.log('  separateOverlaps pin+ellipse (1) :', overlaps(sep1).length, 'overlaps', fmtBad(overlaps(sep1)))
  let again = sep1
  for (let i = 2; i <= 4; i++) {
    again = BV.separateOverlaps(again, W, H, true, freeIds, SAFE)
    console.log(`  separateOverlaps pin+ellipse (${i}) :`, overlaps(again).length, 'overlaps', fmtBad(overlaps(again)))
  }
  const sepNoEll = BV.separateOverlaps(spread, W, H, true, new Set(), SAFE)
  console.log('  separateOverlaps pin, NO ellipse :', overlaps(sepNoEll).length, 'overlaps', fmtBad(overlaps(sepNoEll)))
  const sepUnpinned = BV.separateOverlaps(spread, W, H, false, null, SAFE)
  console.log('  separateOverlaps unpinned        :', overlaps(sepUnpinned).length, 'overlaps', fmtBad(overlaps(sepUnpinned)))
  // Where do the overlapping notes sit relative to the ellipse?
  for (const b of overlaps(sep1)) {
    for (const id of [b.a, b.b]) {
      const p = sep1.find(q => q.id === id)
      const dx = (p.cx - e.ex) / (e.rx || 1), dy = (p.cy - e.ey) / (e.ry || 1)
      console.log(`    ${id}: (${p.cx.toFixed(0)},${p.cy.toFixed(0)}) r=${p.r.toFixed(1)} free=${freeIds.has(id)} ellipseNorm=${Math.hypot(dx, dy).toFixed(2)}`)
    }
  }
} else {
  const settled = BV.settleItems(laidMapped, anchored, W, H, SAFE)
  console.log('  settleItems                      :', overlaps(settled).length, 'overlaps')
  const sep = BV.separateOverlaps(settled, W, H, false, null, SAFE)
  console.log('  separateOverlaps                 :', overlaps(sep).length, 'overlaps', fmtBad(overlaps(sep)))
}
