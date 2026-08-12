import { useLayoutEffect, useRef, useState } from 'react'
import { suggestBubbleNames, matchRange } from '../data/bubbleNames'

// The list holds every match and scrolls; these decide how much of it is on screen.
// ROW_H has to match what a row actually measures (text-sm's 20px line box inside
// py-1.5) or the container stops cutting off at a row boundary, which is the cue that
// there is more below.
const VISIBLE_SUGGESTIONS = 5
const SUGGESTION_ROW_H = 32

// A bubble name field with suggestions under it. Every path that names a bubble — the
// create sheet, the sidebar's add form, the tree's inline rename — uses this one, so
// the list can't drift between them or go missing from one.
//
// The suggestions are only ever a shortcut. Nothing typed is rejected, the list hides
// itself the moment it has no match to offer, and Enter on an unhighlighted field
// submits what's in it rather than what's underneath it.
//
// Escape is layered the way the rest of the app layers it: the first press takes back
// the list, and only once there is no list does a press reach the form. preventDefault
// keeps the global handler in lib/escapeStack from acting on the same press — otherwise
// one key would both close the list and blur the field.
export default function BubbleNameInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  exclude = [],
  inputRef,
  listPosition = 'overlay',   // 'inline' pushes content down; 'overlay' floats over it
  className = '',
  style,
  placeholder = 'Bubble name…',
  autoFocus = false,
  ariaLabel = 'Bubble name',
}) {
  const ownRef = useRef(null)
  const ref = inputRef ?? ownRef
  const listRef = useRef(null)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(-1)   // -1 = nothing highlighted

  const suggestions = suggestBubbleNames(value, { exclude })
  const open = focused && !dismissed && suggestions.length > 0

  // Bring a row into view when the arrows walk past the visible window. Called from the
  // key handler rather than from an effect on `active`, so it belongs to the keys alone:
  // an effect would also fire for the hover that sets `active`, and the list would creep
  // under the pointer as the cursor crossed a half-visible row. Pointer users scroll.
  //
  // Scrolls the container by hand rather than through scrollIntoView, which is free to
  // scroll every ancestor as well — inside a sheet or the sidebar's scroller, that moves
  // the whole surface out from under the user.
  // Queued rather than run on the spot, because an arrow that opens a closed list asks
  // for a row that isn't rendered yet. Drained before paint, so nothing is ever seen at
  // the wrong scroll position.
  const revealRef = useRef(null)
  const revealRow = (index) => { revealRef.current = index }

  useLayoutEffect(() => {
    const index = revealRef.current
    if (index == null) return
    revealRef.current = null
    const box = listRef.current
    const row = box?.children[index]
    if (!box || !row) return
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight
    }
  })

  function pick(name) {
    onChange(name)
    // Filled, not committed: the name is still editable and a colour may still be
    // wanted, so this never submits the form.
    setDismissed(true)
    setActive(-1)
    ref.current?.focus()
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return
      e.preventDefault()
      if (!open) {
        const first = e.key === 'ArrowDown' ? 0 : suggestions.length - 1
        setDismissed(false)
        setActive(first)
        revealRow(first)
        return
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      // From nothing highlighted, down enters at the top and up enters at the bottom.
      const next = active === -1
        ? (step === 1 ? 0 : suggestions.length - 1)
        : (active + step + suggestions.length) % suggestions.length
      setActive(next)
      revealRow(next)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (open && active >= 0) pick(suggestions[active])
      else onSubmit?.()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (open) { setDismissed(true); setActive(-1) }
      else onCancel?.()
      return
    }
    if (e.key === 'Tab' && open) setDismissed(true)
  }

  const list = open && (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Name suggestions"
      style={{
        ...(listPosition === 'overlay'
          ? { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30 }
          // Inline, the list is the part that gives: it may shrink below its five rows
          // so that whatever sits under it — a colour picker, a Create button — keeps
          // its place when the space does not stretch to everything.
          : { marginTop: 6, flex: '1 1 auto', minHeight: 0 }),
        maxHeight: VISIBLE_SUGGESTIONS * SUGGESTION_ROW_H,
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        // Stops a flick that runs past the end of the list from carrying on into the
        // sheet or the page behind it.
        overscrollBehavior: 'contain',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
      }}
    >
      {suggestions.map((name, i) => {
        const range = matchRange(name, value)
        return (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={i === active}
            // Keeps focus in the field, so the blur that would hide this list never
            // fires and the click lands on the row it was aimed at.
            onMouseDown={e => e.preventDefault()}
            onClick={() => pick(name)}
            onMouseEnter={() => setActive(i)}
            className="w-full text-left px-3 py-1.5 text-sm transition-colors"
            style={{
              background: i === active ? 'var(--hover)' : 'transparent',
              color: i === active ? 'var(--text)' : 'var(--text-2)',
              // Rows keep their height in a shrinking flex container, so the list
              // always cuts off mid-scroll rather than squeezing every row.
              flex: '0 0 auto',
            }}
          >
            {range ? (
              <>
                {name.slice(0, range.start)}
                <span className="font-semibold" style={{ color: 'var(--text)' }}>
                  {name.slice(range.start, range.end)}
                </span>
                {name.slice(range.end)}
              </>
            ) : name}
          </button>
        )
      })}
    </div>
  )

  return (
    <div style={{
      position: 'relative',
      // Inline, this is a column so the list below the input can be the flex child that
      // absorbs a squeeze. Overlaid, it is only a positioning context.
      ...(listPosition === 'inline'
        ? { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '0 1 auto' }
        : null),
    }}>
      <input
        ref={ref}
        value={value}
        onChange={e => { onChange(e.target.value); setDismissed(false); setActive(-1) }}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setActive(-1) }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className={className}
        style={{ flex: '0 0 auto', ...style }}
      />
      {list}
    </div>
  )
}
