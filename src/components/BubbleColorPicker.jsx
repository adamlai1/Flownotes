import { useLayoutEffect, useRef, useState } from 'react'
import { BUBBLE_COLORS } from '../data/defaultData'
import { swatchMetrics } from '../utils/swatchLayout'

// The palette, on one line at any width.
//
// The row is measured rather than assumed: its own clientWidth is the space inside
// whatever padding it sits in, which is the number the swatches have to divide up. A
// ResizeObserver on that element covers every way the number can change — window resize,
// orientation, the sheet itself resizing — without listening to the window at all.
//
// Selection is drawn with box-shadow. A border or a wider element would add to the row's
// layout width, so picking a colour could push the row past the space it just measured.
export default function BubbleColorPicker({
  value,
  onChange,
  colors = BUBBLE_COLORS,
  label = 'Bubble colour',
  // What the ring's inner gap is painted in — the surface behind the row, so the ring
  // reads as a gap rather than a second coloured band.
  offsetColor = 'var(--surface-2)',
}) {
  const rowRef = useRef(null)
  const [width, setWidth] = useState(0)

  // Layout effect + observer: the first measurement lands before paint, so the row is
  // never seen at a placeholder size first.
  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return undefined
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { size, gap } = swatchMetrics(width, colors.length)

  return (
    <div
      ref={rowRef}
      role="radiogroup"
      aria-label={label}
      style={{
        display: 'flex',
        flexWrap: 'nowrap',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        gap,
        // Only matters before the first measurement, and for the sliver of a moment
        // where a swatch would otherwise be drawn at full size in a box too small.
        minHeight: size || 24,
      }}
    >
      {size > 0 && colors.map(color => {
        const selected = value === color
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={color}
            onClick={() => onChange(color)}
            style={{
              width: size,
              height: size,
              flex: '0 1 auto',
              minWidth: 0,
              padding: 0,
              border: 'none',
              borderRadius: '50%',
              background: color,
              cursor: 'pointer',
              // Ring sits outside the box without occupying space: an offset in the
              // sheet's own colour, then the ring itself.
              boxShadow: selected
                ? `0 0 0 2px ${offsetColor}, 0 0 0 4px var(--text)`
                : 'none',
              transition: 'box-shadow 0.12s ease-out',
            }}
          />
        )
      })}
    </div>
  )
}
