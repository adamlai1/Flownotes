// Same anchors, same note COUNT — does the SHAPE of the free-note set (ids/order) decide
// whether the add pipeline leaves overlap?  add-shape: n0..n(k-1) (new ids appended);
// remove-shape: n0..n38 minus random ids; shuffled: add-shape in random order.
import { loadLayout, overlaps, rng, makeItems, toSaved, anchorSet, W, H, SAFE, SCALE, PID, CTX } from './layout-harness.mjs'
const BV = await loadLayout()
const tot = { add: 0, remove: 0, shuffled: 0, steps: 0 }
for (const seed of [1, 2, 3, 4, 5]) for (const mode of ['bubbles', 'all']) {
  const nB = 5
  const base = makeItems(nB, 4, rng(seed))
  const laid0 = BV.layoutPage(base, {}, PID, CTX, W, H, SCALE, seed, SAFE)
  const saved = toSaved(BV, laid0, anchorSet(laid0, mode))
  const bubbles = base.filter(i => i.type !== 'note')
  const line = []
  for (let n = 10; n <= 36; n += 2) {
    const r = rng(seed * 100 + n)
    const addShape = [...bubbles, ...Array.from({ length: n }, (_, i) => ({ id: 'n' + i, type: 'note' }))]
    const pool = Array.from({ length: 39 }, (_, i) => 'n' + i)
    while (pool.length > n) pool.splice(Math.floor(r() * pool.length), 1)
    const removeShape = [...bubbles, ...pool.map(id => ({ id, type: 'note' }))]
    const shuffled = [...bubbles, ...addShape.slice(nB).sort(() => r() - 0.5)]
    const o = s => overlaps(BV.layoutPage(s, saved, PID, CTX, W, H, SCALE, seed, SAFE)).length
    const a = o(addShape), b = o(removeShape), c = o(shuffled)
    tot.add += a > 0; tot.remove += b > 0; tot.shuffled += c > 0; tot.steps++
    line.push(`${n}:${a}/${b}/${c}`)
  }
  console.log(`seed ${seed} ${mode}: n:add/remove/shuffled  ` + line.join(' '))
}
console.log('\nsteps with overlap —', tot)
