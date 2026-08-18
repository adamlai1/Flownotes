// Press-and-hold arbitration timings, shared by the canvas (BubbleVisualization)
// and the sidebar bubble list (BubbleTree) so the two gestures can never drift
// apart. The sequence both implement:
//
//   pointer down ─┬─ moved > PRESS_MOVE_CANCEL_PX before pickup → scroll/swipe,
//                 │                                               both timers die
//                 ├─ still at DRAG_PICKUP_MS (canvas single-page) or
//                 │  DRAG_PICKUP_PAGED_MS (canvas paged mode, sidebar list)
//                 │  → the item is picked up for drag
//                 └─ still all the way to LONG_PRESS_MENU_MS → the pickup is
//                    abandoned and the item's menu opens instead

// Press-and-hold on an item without moving for this long opens its menu. It's
// deliberately well past the drag threshold: any movement at all cancels the menu
// and the press stays a drag, so the two gestures never compete. Raised by half
// from 500ms — the menu carries a destructive action, so it should take a
// deliberate hold to reach rather than a slightly slow tap.
export const LONG_PRESS_MENU_MS = 750

// Stationary press → drag pickup. The single-page canvas has nothing competing
// for the gesture and picks up almost immediately; paged mode and the sidebar
// list sit inside swipe/scroll surfaces, so they wait longer to be sure the
// press isn't the start of a scroll.
export const DRAG_PICKUP_MS = 100
export const DRAG_PICKUP_PAGED_MS = 220

// Moving farther than this before the pickup fires means the press is a
// scroll/swipe/drag — never a menu.
export const PRESS_MOVE_CANCEL_PX = 9
