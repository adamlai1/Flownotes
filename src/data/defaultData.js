import { generateId, ROOT_BUBBLE_ID } from '../utils/helpers'

// Fixed, well-known ids for everything the app seeds — identical on every
// install, so the same starter bubble/project matches by id across devices
// and accounts. The cloud scopes them per user via the composite (user_id, id)
// primary key (see supabase/composite_ids.sql). The 'seed:' prefix cannot
// collide with generateId() output, which is lowercase alphanumerics only.
export const SEED_PROJECT_ID = 'seed:project'
export const SEED_IDEAS_ID = 'seed:ideas'
// No longer seeded (new installs get Lists/Watch List as the nesting demo
// instead), but the constant stays: the one-time legacy-id migration still
// remaps old installs' random-id "Self" onto it, and accounts that already
// have the bubble keep it forever.
export const SEED_IDEAS_SELF_ID = 'seed:ideas-self'
export const SEED_TODO_ID = 'seed:todo'
export const SEED_JOURNAL_ID = 'seed:journal'
// Added after the four above. The legacy-id migration deliberately does NOT
// know about these: no legacy-era install ever had a random-id "Lists" or
// "Watch List" to remap, and teaching the migration their names would fold a
// user's own same-named bubble into them.
export const SEED_LISTS_ID = 'seed:lists'
export const SEED_LISTS_WATCHLIST_ID = 'seed:lists-watchlist'
export const SEED_INTRO_NOTE_ID = 'seed:note-intro'

const ideasId = SEED_IDEAS_ID
const ideasSelfId = SEED_IDEAS_SELF_ID
const toDoId = SEED_TODO_ID
const journalId = SEED_JOURNAL_ID
const defaultProjectId = SEED_PROJECT_ID

// Sentinel ID used when a note is explicitly pinned to the root level
// alongside membership in other bubbles. Canonically defined in
// utils/helpers.js next to realBubbleIds (imported above, since the seed
// note below uses it); re-exported here for existing importers.
export { ROOT_BUBBLE_ID }

export const DEFAULT_TAGS = ['Certain', 'Think About More', 'Not Sure', 'Could Be Wrong']

export const TAG_COLORS = {
  'Certain': '#34C759',
  'Think About More': '#FFD60A',
  'Not Sure': '#FF9F0A',
  'Could Be Wrong': '#FF453A',
}

export const CUSTOM_TAG_PALETTE = ['#0A84FF', '#BF5AF2', '#FF375F', '#64D2FF', '#5E5CE6']

export const BUBBLE_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f43f5e', // rose
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
]

// The colour a new bubble should start on: whichever is least spoken for where it is
// being made. Colour is how a bubble is told apart at a glance, so defaulting to the
// same one every time makes a level that all looks alike — and the level is exactly the
// scope that matters, hence siblings first.
//
// Ties fall to the colour least used anywhere in the project, and then to palette order,
// so the answer is always the same for the same input.
export function leastUsedBubbleColor(siblingColors = [], projectColors = []) {
  const tally = (list) => list.reduce((counts, c) => counts.set(c, (counts.get(c) || 0) + 1), new Map())
  const amongSiblings = tally(siblingColors)
  const amongProject = tally(projectColors)

  let best = BUBBLE_COLORS[0]
  let bestLocal = Infinity
  let bestGlobal = Infinity
  for (const color of BUBBLE_COLORS) {
    const local = amongSiblings.get(color) || 0
    const global = amongProject.get(color) || 0
    // Strictly better only — an equal candidate later in the palette never displaces
    // the earlier one, which is what makes palette order the final tie-break.
    if (local < bestLocal || (local === bestLocal && global < bestGlobal)) {
      best = color
      bestLocal = local
      bestGlobal = global
    }
  }
  return best
}

// The starting structure a brand-new install is seeded with. Kept deliberately small
// and unopinionated — it is scaffolding to show what bubbles ARE, not a filing system
// anyone has to adopt. "Watch List" inside "Lists" is the one nested bubble, there
// purely to demonstrate that bubbles hold bubbles; the one seed note lives on the
// project canvas AND in To Do at once, teaching that notes live in many places
// without a tooltip. Everything else the user invents themselves.
//
// This runs only when there is no local project list at all (see initializeData in
// App.jsx). Changing it never reaches an existing install: local data loads from
// storage, and cloud data overwrites local on sign-in. Nothing here migrates anybody
// — accounts seeded under the old shape (with "Self", without Lists) keep exactly
// what they have.
// Static templates shared by createDefaultProject and the pristine checks
// below, so "what the app seeds" and "what counts as untouched" can never
// drift apart.
const SEED_BUBBLES = [
  { id: ideasId, name: 'Ideas', parent_id: null, color: '#6366f1' },
  { id: toDoId, name: 'To Do', parent_id: null, color: '#22c55e' },
  { id: journalId, name: 'Journal', parent_id: null, color: '#14b8a6' },
  { id: SEED_LISTS_ID, name: 'Lists', parent_id: null, color: '#8b5cf6' },
  { id: SEED_LISTS_WATCHLIST_ID, name: 'Watch List', parent_id: SEED_LISTS_ID, color: '#f97316' },
]
const SEED_NOTE_CONTENT =
  'This note is also in To Do — tap the "To Do" bubble to see. Notes can live in as many bubbles as you want.'

// "Untouched seed content" — items the app created that the user has not made
// their own. Used to keep app-created content from tripping the guest⇄cloud
// merge dialog on a fresh device: pristine seed items don't count as
// local-only work, while an edited one is real user data and does. The tests
// compare SHAPE, not timestamps — closing the note editor always rewrites
// updated_at even with zero changes, so a timestamp rule would mark the
// teaching note "edited" the moment someone opens it, which the note itself
// invites. A pristine note may still have a rewritten bubble_ids (deleting a
// seed bubble re-pins it); membership alone doesn't make it the user's.
export function isPristineSeedBubble(bubble) {
  const t = SEED_BUBBLES.find(s => s.id === bubble.id)
  return !!t && bubble.name === t.name &&
    (bubble.parent_id ?? null) === (t.parent_id ?? null) &&
    bubble.color === t.color
}

export function isPristineSeedNote(note) {
  return note.id === SEED_INTRO_NOTE_ID &&
    note.content === SEED_NOTE_CONTENT &&
    (note.tags ?? []).length === 0 &&
    (note.connections ?? []).length === 0
}

export function createDefaultProject() {
  const now = new Date().toISOString()
  return {
    id: defaultProjectId,
    name: 'Personal Notes',
    created_at: now,
    bubbles: SEED_BUBBLES.map(b => ({ ...b })),
    notes: [
      {
        id: SEED_INTRO_NOTE_ID,
        content: SEED_NOTE_CONTENT,
        created_at: now,
        updated_at: now,
        bubble_ids: [ROOT_BUBBLE_ID, toDoId],
        tags: [],
        connections: [],
        locked: false,
      },
    ],
    customTagColors: { ...TAG_COLORS },
    // Every default tag gets a stable id so cloud sync never inserts a null id.
    customTagIds: Object.fromEntries(
      Object.keys(TAG_COLORS).map(name => [name, generateId()])
    ),
  }
}

export const CONNECTION_TYPES = [
  'causes',
  'similar idea',
  'opposing idea',
  'leads to',
]

export const DEFAULT_PROJECT_ID = defaultProjectId
