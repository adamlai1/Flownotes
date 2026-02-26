import { generateId } from '../utils/helpers'

const ideasId = generateId()
const ideasSelfId = generateId()
const ideasOtherId = generateId()
const ideasSocietyId = generateId()
const ideasRelationshipsId = generateId()
const remindersId = generateId()
const defaultProjectId = generateId()

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
        name: 'Ideas: Self',
        parent_id: ideasId,
        color: '#8b5cf6',
      },
      {
        id: ideasOtherId,
        name: 'Ideas: Other People',
        parent_id: ideasId,
        color: '#ec4899',
      },
      {
        id: ideasSocietyId,
        name: 'Ideas: Society',
        parent_id: ideasId,
        color: '#f43f5e',
      },
      {
        id: ideasRelationshipsId,
        name: 'Ideas: Relationships',
        parent_id: ideasId,
        color: '#f97316',
      },
      {
        id: remindersId,
        name: 'Reminders',
        parent_id: null,
        color: '#22c55e',
      },
    ],
    notes: [],
  }
}

export const CONNECTION_TYPES = [
  'causes this',
  'similar idea',
  'opposing idea',
  'leads to',
]

export const DEFAULT_PROJECT_ID = defaultProjectId
