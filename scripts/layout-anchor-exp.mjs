import { loadLayout, sweep } from './layout-harness.mjs'
const BV = await loadLayout()
for (const anchorAt of [4, 12, 20]) {
  const r = sweep(BV, { bubbleCounts: [5], modes: ['bubbles', 'all'], anchorAt })
  console.log(`anchors captured at n=${anchorAt}: ${r.badSteps}/${r.totalSteps} bad add steps; first overlap:`, Object.entries(r.summary).map(([k, v]) => k + ' ' + v.firstBadAt.join(' ')).join(' | '))
}
