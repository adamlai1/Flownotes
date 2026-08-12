import { generateId } from '../utils/helpers'

const ideasId = generateId()
const ideasSelfId = generateId()
const toDoId = generateId()
const journalId = generateId()
const defaultProjectId = generateId()

// Sentinel ID used when a note is explicitly pinned to the root level
// alongside membership in other bubbles.
export const ROOT_BUBBLE_ID = '__root__'

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
// anyone has to adopt. "Self" is the one nested bubble, there purely to demonstrate that
// bubbles hold bubbles; everything else the user invents themselves.
//
// This runs only when there is no local project list at all (see initializeData in
// App.jsx). Changing it never reaches an existing install: local data loads from
// storage, and cloud data overwrites local on sign-in. Nothing here migrates anybody.
export function createDefaultProject() {
  const now = new Date().toISOString()
  return {
    id: defaultProjectId,
    name: 'Personal Notes',
    created_at: now,
    bubbles: [
      {
        id: ideasId,
        name: 'Ideas',
        parent_id: null,
        color: '#6366f1',
      },
      {
        id: ideasSelfId,
        name: 'Self',
        parent_id: ideasId,
        color: '#8b5cf6',
      },
      {
        id: toDoId,
        name: 'To Do',
        parent_id: null,
        color: '#22c55e',
      },
      {
        id: journalId,
        name: 'Journal',
        parent_id: null,
        color: '#14b8a6',
      },
    ],
    notes: [],
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
