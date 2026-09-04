// Sparse mixed pages: many bubbles, very few notes. Guards the bubbles-only → mixed
// transition: adding ONE note to a level that fits one page must not multiply its
// page count, and whatever does stay on one page must not overlap.
//   node scripts/layout-sparse-exp.mjs
//   LAYOUT_ENTRY=<variant.jsx> node scripts/layout-sparse-exp.mjs
import { loadLayout, overlaps, rng, makeItems, W, H, SAFE, SCALE, PID, CTX } from './layout-harness.mjs'
const BV = await loadLayout()

const rows = []
let cliffs = 0, badSingles = 0, singles = 0
for (const nB of [8, 12, 16, 20, 30]) {
  let prevPages = null
  const cells = []
  for (let n = 0; n <= 8; n++) {
    const { pageLoad } = BV.pageLoadFor(nB, n, W, H, SCALE, SAFE)
    const pages = Math.max(1, Math.ceil(pageLoad - 1e-9))
    let ov = ''
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
      ov = (a || b) ? ` ov${a}/${b}` : ''
    }
    if (prevPages !== null && pages > prevPages + 1) cliffs++
    prevPages = pages
    cells.push(`${n}:${pages}p${ov}`)
  }
  rows.push({ bubbles: nB, 'notes → pages (ov = overlapping pairs, fresh/anchored)': cells.join('  ') })
}
console.table(rows)
console.log(`page-count jumps of more than one on a single added note: ${cliffs};  single pages with overlap: ${badSingles} of ${singles}`)
