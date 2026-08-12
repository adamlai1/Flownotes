// Geometry for a row of colour swatches that has to stay on one line.
//
// The row can neither wrap nor scroll, so the swatches are sized from the width they
// actually have rather than from a fixed figure: each colour gets a slot of
// containerWidth / count, and the swatch takes most of that slot with the rest left as
// the gap. That keeps the gap proportional to the swatches at every width instead of
// pinching to nothing on a phone.

export const MIN_SWATCH = 18   // still tappable on the narrowest phone
export const MAX_SWATCH = 34   // still a swatch, not a button, on a desktop
export const GAP_RATIO = 0.22  // of each slot, so the gap scales with the swatch

// { size, gap } in px for `count` swatches across `width`.
//
// Three regimes, and which one applies is decided by the width alone:
//   • Roomy — the slot would make a swatch bigger than the cap, so the swatch is capped
//     and the gap is held proportional to it. The row then measures less than the
//     container and is centred, rather than drifting into a widely spaced row.
//   • Ordinary — the swatch takes its share of the slot and the gap is whatever is left,
//     so the row fills the width exactly.
//   • Tight — the slot is under the floor, so the swatch is held at the floor and the
//     gap absorbs the shortfall. Below about count × MIN_SWATCH there is nothing left to
//     absorb it, and the swatch goes under the floor: a row that no longer quite fits
//     the thumb still beats a row that overflows the screen.
export function swatchMetrics(width, count, { min = MIN_SWATCH, max = MAX_SWATCH, gapRatio = GAP_RATIO } = {}) {
  if (!(width > 0) || count < 1) return { size: 0, gap: 0 }
  if (count === 1) return { size: Math.max(Math.min(width, max), 0), gap: 0 }

  const slot = width / count
  const ideal = slot * (1 - gapRatio)

  if (ideal > max) {
    return { size: max, gap: max * (gapRatio / (1 - gapRatio)) }
  }
  if (ideal < min) {
    const gap = (width - count * min) / (count - 1)
    if (gap < 0) return { size: width / count, gap: 0 }
    return { size: min, gap }
  }
  return { size: ideal, gap: (width - count * ideal) / (count - 1) }
}

// Total width the row occupies at these metrics — what must never exceed the container.
export function swatchRowWidth({ size, gap }, count) {
  return count < 1 ? 0 : count * size + (count - 1) * gap
}
