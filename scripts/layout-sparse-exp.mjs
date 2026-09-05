// Sparse mixed pages: many bubbles, very few notes. Guards the bubbles-only → mixed
// transition: adding ONE note to a level that fits one page must not multiply its
// page count, and whatever does stay on one page must not overlap.
//   node scripts/layout-sparse-exp.mjs
//   LAYOUT_ENTRY=<variant.jsx> node scripts/layout-sparse-exp.mjs
import { loadLayout, overlaps, rng, makeItems, W, H, SAFE, SCALE, PID, CTX } from './layout-harness.mjs'
const BV = await loadLayout()
if (process.env.LAYOUT_FILL) BV.LAYOUT_TUNING.areaFill = Number(process.env.LAYOUT_FILL)
if (process.env.LAYOUT_NOTE_WASTE) BV.LAYOUT_TUNING.noteMixedWaste = Number(process.env.LAYOUT_NOTE_WASTE)
const geom = { width: W, height: H, noteScale: SCALE, safeBottom: SAFE }

const rows = []
let cliffs = 0, badSingles = 0, singles = 0, displaced = 0
for (const nB of [8, 12, 16, 20, 30]) {
  let prevPages = null
  let prevPageOf = null
  const cells = []
  for (let n = 0; n <= 8; n++) {
    const itemsNow = makeItems(nB, n, rng(7))
    const { pageLoad } = BV.pageLoadFor(itemsNow, W, H, SCALE, SAFE)
    // Displacement: adding a note must not move any item that was already placed.
    // (No saved pages — the fresh-level case, which is where re-packing bites.)
    const pageOf = BV.assignPages(itemsNow, {}, PID, CTX, geom)
    const pages = Math.max(1, ...Object.values(pageOf).map(p => p + 1))
    let moved = 0
    if (prevPageOf && pageOf) for (const [id, p] of Object.entries(prevPageOf)) if (pageOf[id] !== undefined && pageOf[id] !== p) moved++
    displaced += moved
    prevPageOf = pageOf
    let ov = moved ? ` MOVED${moved}` : ''
    if (pages === 1) {
      // Un-anchored single page (fresh level), and one with the bubbles anchored from
      // the bubbles-only layout (the user placed them, then started adding notes).
      const items = makeItems(nB, n, rng(7))
      const laid = BV.layoutPage(items, {}, PID, CTX, W, H, SCALE, 7, SAFE)
      const bubblesOnly = BV.layoutPage(makeItems(nB, 0, rng(7)), {}, PID, CTX, W, H, SCALE, 7, SAFE)
      const saved = Object.fromEntries(bubblesOnly.map(p => [BV.posKey(PID, CTX, p.id), { xFrac: p.cx / W, yFrac: p.cy / H }]))
      const laidA = BV.layoutPage(items, saved, PID, CTX, W, H, SCALE, 7, SAFE)
      const a = overlaps(laid).length, b = overlaps(laidA).length
      singles++
      if (a || b) badSingles++
      ov += (a || b) ? ` ov${a}/${b}` : ''
    }
    if (prevPages !== null && pages > prevPages + 1) cliffs++
    prevPages = pages
    cells.push(`${n}:${pages}p${ov}`)
  }
  rows.push({ bubbles: nB, 'notes → pages (ov = overlapping pairs, fresh/anchored)': cells.join('  ') })
}
console.table(rows)
console.log(`page-count jumps of more than one on a single added note: ${cliffs};  single pages with overlap: ${badSingles} of ${singles};  already-placed items moved to another page by an add: ${displaced}`)
