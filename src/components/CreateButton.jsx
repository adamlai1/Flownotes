import { useState } from 'react'
import { useTheme } from '../contexts/ThemeContext'

// ─── Floating create button ───────────────────────────────────────────────────
//
// Tap makes a note, hold makes a bubble. Lives in its own file for one reason worth
// stating: it needs the theme, and App renders the ThemeProvider itself, so a useTheme()
// call up there would read the context default rather than the live value.
//
// The two scales it can be under — the press dip and the hold growth — are driven from
// SEPARATE elements on purpose. Both start on the same pointerdown, and a single element
// can only animate `transform` toward one of them; nesting lets the dip play at press
// speed while the hold keeps the full LONG_PRESS_MS ramp it is timed against.

// Same footprint as before: 56px, 24px in from the right edge. The bubble layout reserves
// a no-go zone around this button from its own constants (see PLUS_BTN_EXCL_R and the
// width-52 / height-52 centre it is measured from), so the size and inset are not free to
// change here alone.
const SIZE = 56
// Deliberately rounder than the bubbles' shared CORNER_RATIO (22% → 12px here),
// which read as a square with modest corners. ~29% is squircle territory, and
// breaking from the canvas shapes' ratio is the point: material already sets the
// button apart (solid tile vs lit glass); the silhouette now does too.
const RADIUS = Math.round(SIZE * 0.29)

// One flat colour. No ramp, no edge light, no translucency: the button shares the
// bubbles' silhouette, so MATERIAL is what has to tell them apart. Bubbles are lit
// glass — gradient, backdrop blur, coloured glow. This is a solid opaque tile that
// casts an ordinary shadow, which is what makes it read as a control sitting on top
// of the canvas rather than one more thing floating in it.
const INDIGO = '#4F46E5' // indigo-600 — the previous colour, kept as the revert value

// EXPERIMENT (neutral scheme): the indigo read purple-leaning against the neutral
// canvas; these are two truer-blue candidates for the primary action. Flip the
// variant to compare; 'indigo' restores the old colour exactly.
//   'ios'  — iOS system blue (#007AFF light / #0A84FF dark, per Apple's own pair)
//   'deep' — a slightly deeper blue (#2563EB, Tailwind blue-600)
//   'navy' — deeper still (#1D4ED8, Tailwind blue-700)
//   'navy2' — darker again (#1E40AF, Tailwind blue-800)
const PLUS_COLOR_VARIANT = 'navy2' // 'ios' | 'deep' | 'navy' | 'navy2' | 'indigo'

export default function CreateButton({
  held,
  holdMs,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
}) {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const [pressed, setPressed] = useState(false)

  const fill = PLUS_COLOR_VARIANT === 'ios'
    ? (isLight ? '#007AFF' : '#0A84FF')
    : PLUS_COLOR_VARIANT === 'deep' ? '#2563EB'
    : PLUS_COLOR_VARIANT === 'navy' ? '#1D4ED8'
    : PLUS_COLOR_VARIANT === 'navy2' ? '#1E40AF'
    : INDIGO

  // A plain drop shadow — dark, soft, offset downward. Deliberately NOT a glow: glow is
  // the bubbles' signal, and anything indigo bleeding out of these edges would put the
  // button straight back into their family.
  //
  // Light mode carries it stronger. An indigo tile on a near-white canvas has far less
  // tonal separation to work with than the same tile on the dark one, so the shadow is
  // most of what lifts it off the background there.
  //
  // Pressed, the shadow tightens and pulls in toward the button: it is travelling toward
  // the surface, so its cast shortens. That is the same cue the scale dip gives, read off
  // the light instead of the size.
  const shadow = isLight
    ? (pressed
        ? '0 2px 5px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.12)'
        : '0 6px 16px rgba(0,0,0,0.24), 0 2px 5px rgba(0,0,0,0.16)')
    : (pressed
        ? '0 1px 4px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)'
        : '0 4px 12px rgba(0,0,0,0.45), 0 1px 3px rgba(0,0,0,0.32)')

  const release = () => setPressed(false)

  return (
    <button
      onClick={onClick}
      onPointerDown={e => { setPressed(true); onPointerDown?.(e) }}
      onPointerUp={e => { release(); onPointerUp?.(e) }}
      onPointerLeave={e => { release(); onPointerCancel?.(e) }}
      onPointerCancel={e => { release(); onPointerCancel?.(e) }}
      onContextMenu={e => e.preventDefault()}
      className="fixed right-6 z-40 flex items-center justify-center"
      style={{
        width: SIZE,
        height: SIZE,
        bottom: 'calc(1.5rem + env(safe-area-inset-bottom))',
        padding: 0,
        border: 'none',
        background: 'none',
        borderRadius: RADIUS,
        // Grows while the hold is registering, so a different action is visibly on its
        // way; snaps back on release or cancel. Slower than the hold itself, so the
        // growth reads as the gesture filling up rather than a press-down bounce.
        transform: held ? 'scale(1.18)' : 'scale(1)',
        transition: held
          ? `transform ${holdMs}ms cubic-bezier(0.4, 0, 0.6, 1)`
          : 'transform 0.18s ease-out',
        touchAction: 'manipulation',
        WebkitTouchCallout: 'none',
        // Without this, mobile Safari and Chrome paint their own grey wash over the
        // button on tap and leave it there for a beat after the finger is gone.
        WebkitTapHighlightColor: 'transparent',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
      aria-label="Create note. Hold to create a bubble."
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: RADIUS,
          background: fill,
          boxShadow: shadow,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Down fast, back with a little overshoot — the same easing the bubbles use for
          // their pick-up pop, so a press here feels like the rest of the app.
          transform: pressed ? 'scale(0.93)' : 'scale(1)',
          transition: pressed
            ? 'transform 0.1s ease-out, box-shadow 0.1s ease-out'
            : 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.22s ease-out',
        }}
      >
        <svg
          width={24} height={24} viewBox="0 0 24 24"
          fill="none" stroke="#fff" strokeWidth={2.75} strokeLinecap="round"
          style={{ pointerEvents: 'none' }}
        >
          <path d="M12 5.5v13M5.5 12h13" />
        </svg>
      </span>
    </button>
  )
}
