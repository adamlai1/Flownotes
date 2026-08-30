import { useState, useRef, forwardRef } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { rimStyle, BUTTON_RIM } from './BubbleVisualization'
import { useDismissOnOutside } from '../lib/dismiss'

// ─── Floating create button ───────────────────────────────────────────────────
//
// Tap expands the button into two icon tiles — Note in the button's own spot,
// Bubble directly above it — and hold makes a bubble directly, skipping the
// expansion. Lives in its own file for one reason worth stating: it needs the
// theme, and App renders the ThemeProvider itself, so a useTheme() call up there
// would read the context default rather than the live value.
//
// The expansion renders HERE, not in a separate component, so the tiles share
// the button's exact size, radius, fill, rim, and shadow by construction — the
// expanded state must read as the button multiplying, not a menu opening. There
// is deliberately no panel, no labels, and no entrance animation: the tiles are
// tappable the instant they render, and Note occupies the exact spot the + held,
// so creating a note is the same thumb position as before with one extra tap.
//
// The two scales the + can be under — the press dip and the hold growth — are
// driven from SEPARATE elements on purpose. Both start on the same pointerdown,
// and a single element can only animate `transform` toward one of them; nesting
// lets the dip play at press speed while the hold keeps the full LONG_PRESS_MS
// ramp it is timed against.

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

// The + button's resting spot; the Note tile renders at exactly this bottom so
// it lands under the thumb that just tapped the +. The Bubble tile stacks one
// tile directly above, GAP apart.
const BOTTOM = 'calc(1.5rem + env(safe-area-inset-bottom))'
const GAP = 12

// One flat colour with a single moulded edge: the beveled rim (BUTTON_RIM, shared
// with the bubbles' rim helper) is the button's only edge treatment — a lightened
// tint of its own fill, not white, so it reads as a moulded bevel rather than a
// decal. Still no glow and no translucency: bubbles are lit glass, this is a solid
// opaque tile casting an ordinary shadow, which is what makes it read as a control
// sitting on top of the canvas rather than one more thing floating in it.
const INDIGO = '#4F46E5' // indigo-600 — the original colour, kept as a revert value

// EXPERIMENT (neutral scheme): the indigo read purple-leaning against the neutral
// canvas; 'navy2' is the pre-rim decision, restored after an accent-fill (#6366f1)
// detour read as one more CTA. The BUTTON_RIM bevel is tuned against this fill.
// Flip the variant to compare; 'indigo' restores the original colour exactly.
//   'accent' — #6366f1, the app accent (tried; dropped)
//   'ios'  — iOS system blue (#007AFF light / #0A84FF dark, per Apple's own pair)
//   'deep' — a slightly deeper blue (#2563EB, Tailwind blue-600)
//   'navy' — deeper still (#1D4ED8, Tailwind blue-700)
//   'navy2' — darker again (#1E40AF, Tailwind blue-800)
const PLUS_COLOR_VARIANT = 'navy2' // 'accent' | 'ios' | 'deep' | 'navy' | 'navy2' | 'indigo'

function plusFill(isLight) {
  return PLUS_COLOR_VARIANT === 'accent' ? '#6366f1'
    : PLUS_COLOR_VARIANT === 'ios' ? (isLight ? '#007AFF' : '#0A84FF')
    : PLUS_COLOR_VARIANT === 'deep' ? '#2563EB'
    : PLUS_COLOR_VARIANT === 'navy' ? '#1D4ED8'
    : PLUS_COLOR_VARIANT === 'navy2' ? '#1E40AF'
    : INDIGO
}

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
function plusShadow(isLight, pressed) {
  return isLight
    ? (pressed
        ? '0 2px 5px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.12)'
        : '0 6px 16px rgba(0,0,0,0.24), 0 2px 5px rgba(0,0,0,0.16)')
    : (pressed
        ? '0 1px 4px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)'
        : '0 4px 12px rgba(0,0,0,0.45), 0 1px 3px rgba(0,0,0,0.32)')
}

// Shared button-shell styling: the fixed placement and neutral chrome every tile
// (the + itself included) sits in. transform/transition stay per-caller — the +
// animates its hold growth there.
function shellStyle(bottom) {
  return {
    width: SIZE,
    height: SIZE,
    bottom,
    padding: 0,
    border: 'none',
    background: 'none',
    borderRadius: RADIUS,
    touchAction: 'manipulation',
    WebkitTouchCallout: 'none',
    // Without this, mobile Safari and Chrome paint their own grey wash over the
    // button on tap and leave it there for a beat after the finger is gone.
    WebkitTapHighlightColor: 'transparent',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  }
}

// One expansion tile: the + button's tile rendered verbatim (fill, rim, shadow,
// press dip) with a different glyph inside. No hold behavior — a tile does one
// thing on tap.
const FanTile = forwardRef(function FanTile({ bottom, label, onClick, isLight, children }, ref) {
  const [pressed, setPressed] = useState(false)
  const release = () => setPressed(false)
  return (
    <button
      ref={ref}
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onContextMenu={e => e.preventDefault()}
      className="fixed right-6 z-50 flex items-center justify-center"
      style={shellStyle(bottom)}
      aria-label={label}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: RADIUS,
          background: plusFill(isLight),
          boxShadow: plusShadow(isLight, pressed),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: pressed ? 'scale(0.93)' : 'scale(1)',
          transition: pressed
            ? 'transform 0.1s ease-out, box-shadow 0.1s ease-out'
            : 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.22s ease-out',
        }}
      >
        {children}
        <span aria-hidden style={rimStyle(BUTTON_RIM)} />
      </span>
    </button>
  )
})

export default function CreateButton({
  held,
  holdMs,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  expanded,
  onCreateNote,
  onCreateBubble,
  onCollapse,
}) {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const [pressed, setPressed] = useState(false)
  const noteTileRef = useRef(null)
  const bubbleTileRef = useRef(null)

  // Outside-tap dismissal through the shared hook — it also stops the dismissing
  // press at document capture and swallows its click, so collapsing the expansion
  // by tapping the canvas can never drag or long-press the canvas underneath.
  useDismissOnOutside(!!expanded, onCollapse, [noteTileRef, bubbleTileRef])

  const release = () => setPressed(false)

  return (
    <>
      <button
        onClick={onClick}
        onPointerDown={e => { setPressed(true); onPointerDown?.(e) }}
        onPointerUp={e => { release(); onPointerUp?.(e) }}
        onPointerLeave={e => { release(); onPointerCancel?.(e) }}
        onPointerCancel={e => { release(); onPointerCancel?.(e) }}
        onContextMenu={e => e.preventDefault()}
        className="fixed right-6 z-40 flex items-center justify-center"
        style={{
          ...shellStyle(BOTTOM),
          // Grows while the hold is registering, so a different action is visibly on its
          // way; snaps back on release or cancel. Slower than the hold itself, so the
          // growth reads as the gesture filling up rather than a press-down bounce.
          transform: held ? 'scale(1.18)' : 'scale(1)',
          transition: held
            ? `transform ${holdMs}ms cubic-bezier(0.4, 0, 0.6, 1)`
            : 'transform 0.18s ease-out',
        }}
        aria-label="Create note or bubble. Hold to create a bubble directly."
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: RADIUS,
            background: plusFill(isLight),
            boxShadow: plusShadow(isLight, pressed),
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
          {/* Beveled rim: hairline ring, brighter at TL/BR. Inherits the span's radius
              and scales with its press dip. pointer-events: none in rimStyle keeps it
              from swallowing taps. */}
          <span aria-hidden style={rimStyle(BUTTON_RIM)} />
        </span>
      </button>

      {expanded && (
        <>
          {/* Invisible shield, same pattern as the popup menus: keeps presses near
              the tiles from reaching the canvas's position-based handlers. Sits
              above the + (both z-40, this renders later) and below the tiles. */}
          <div className="fixed inset-0 z-40" />
          {/* Note takes the +'s exact spot — the common action stays under the
              thumb. Its glyph is one rounded note card with text lines, the
              singular of the All Notes view's stacked-cards icon. */}
          <FanTile
            ref={noteTileRef}
            bottom={BOTTOM}
            label="Create note"
            onClick={onCreateNote}
            isLight={isLight}
          >
            <svg
              width={24} height={24} viewBox="0 0 24 24"
              fill="none" stroke="#fff" strokeLinecap="round"
              style={{ pointerEvents: 'none' }}
            >
              <rect x="4" y="5" width="16" height="14" rx="3" strokeWidth={2.25} />
              <path d="M8 10.5h8M8 14h5" strokeWidth={2} />
            </svg>
          </FanTile>
          {/* Bubble sits one tile directly above. Its glyph is the app's own
              bubble symbol — a dot inside a dashed containing ring — lifted from
              the canvas-view toggle, so it means "bubble" everywhere it appears. */}
          <FanTile
            ref={bubbleTileRef}
            bottom={`calc(${BOTTOM} + ${SIZE + GAP}px)`}
            label="Create bubble"
            onClick={onCreateBubble}
            isLight={isLight}
          >
            <svg
              width={24} height={24} viewBox="0 0 24 24"
              fill="none" stroke="#fff" strokeLinecap="round"
              style={{ pointerEvents: 'none' }}
            >
              <circle cx="12" cy="12" r="4.25" strokeWidth={2.25} />
              <circle cx="12" cy="12" r="9.25" strokeWidth={1.75} strokeDasharray="3.2 2.2" />
            </svg>
          </FanTile>
        </>
      )}
    </>
  )
}
