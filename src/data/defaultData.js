import { generateId } from '../utils/helpers'

const ideasId = generateId()
const ideasSelfId = generateId()
const ideasOtherId = generateId()
const ideasSocietyId = generateId()
const ideasRelationshipsId = generateId()
const remindersId = generateId()
const pastMemoriesId = generateId()
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
        id: ideasOtherId,
        name: 'Other People',
        parent_id: ideasId,
        color: '#ec4899',
      },
      {
        id: ideasSocietyId,
        name: 'Society',
        parent_id: ideasId,
        color: '#f43f5e',
      },
      {
        id: ideasRelationshipsId,
        name: 'Relationships',
        parent_id: ideasId,
        color: '#f97316',
      },
      {
        id: remindersId,
        name: 'Reminders',
        parent_id: null,
        color: '#22c55e',
      },
      {
        id: pastMemoriesId,
        name: 'Past Memories',
        parent_id: null,
        color: '#14b8a6',
      },
    ],
    notes: [],
    customTagColors: { ...TAG_COLORS },
  }
}

export const CONNECTION_TYPES = [
  'causes',
  'similar idea',
  'opposing idea',
  'leads to',
]

export const DEFAULT_PROJECT_ID = defaultProjectId
