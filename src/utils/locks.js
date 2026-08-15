// Password locking for bubbles and notes.
//
// ⚠ IMPORTANT — this is a UI gate, NOT encryption. Locked notes and bubbles are
// still stored in plain text in localStorage and in Supabase exactly like every
// other item; only the *display* is withheld until the password is entered.
// Anyone who can read the device's localStorage, the Supabase rows, or an export
// can read locked content without ever seeing this password. Treat the lock as a
// shoulder-surfing / casual-privacy feature, not as protection for secrets.
//
// The password itself is never stored in plain text: only a salted hash is kept
// (locally and, when signed in, in the user_preferences row).

import { generateId, realBubbleIds } from './helpers'

// Rounds are cheap here because the hash is only defending the *password* against
// someone reading localStorage — not the content, which isn't protected at all.
const HASH_ROUNDS = 1000

// FNV-1a, 32-bit. Not cryptographic; see the file header.
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function generateSalt() {
  // generateId() is the app's id source (timestamp + Math.random); good enough to
  // keep two users with the same password from sharing a stored hash.
  return generateId() + generateId()
}

// Salted, iterated digest rendered as 32 hex chars. Four differently-prefixed FNV
// passes are folded together so the stored value is wider than a single 32-bit hash.
export function hashPassword(password, salt) {
  const base = `${salt}:${password}`
  let acc = base
  for (let i = 0; i < HASH_ROUNDS; i++) {
    acc = fnv1a(`${acc}:${i}`).toString(16) + base
  }
  return [0, 1, 2, 3]
    .map(i => fnv1a(`${i}#${acc}`).toString(16).padStart(8, '0'))
    .join('')
}

// ── Effective lock state ──────────────────────────────────────────────────────
// An item's own `locked` flag is only half the story: locking a bubble locks
// everything inside it (nested bubbles and their notes) without touching the
// children's own flags, so unlocking the parent restores them untouched.
//
// "Gated" = the user may not see this item right now: it (or an ancestor) is
// locked and hasn't been unlocked in this session.

const EMPTY_SET = new Set()

// Sentinel id placed in `unlockedIds` by Settings → Unlock All: one password entry
// reveals everything for the rest of the session.
export const UNLOCK_ALL = '*'

export function buildLockIndex(bubbles = [], notes = [], unlockedIds = EMPTY_SET) {
  const byId = new Map(bubbles.map(b => [b.id, b]))
  const all = unlockedIds.has(UNLOCK_ALL)
  const isUnlocked = id => all || unlockedIds.has(id)

  // Walk up the parent chain collecting the locked ancestors still gating `id`.
  // `seen` guards against a corrupted parent cycle.
  function bubbleChainGates(id) {
    const gates = []
    const seen = new Set()
    let b = byId.get(id)
    while (b && !seen.has(b.id)) {
      seen.add(b.id)
      if (b.locked && !isUnlocked(b.id)) gates.push(b.id)
      b = b.parent_id != null ? byId.get(b.parent_id) : null
    }
    return gates
  }

  function noteGates(note) {
    const gates = []
    if (note.locked && !isUnlocked(note.id)) gates.push(note.id)
    for (const bid of realBubbleIds(note)) gates.push(...bubbleChainGates(bid))
    return [...new Set(gates)]
  }

  const gatedBubbleIds = new Set(
    bubbles.filter(b => bubbleChainGates(b.id).length > 0).map(b => b.id)
  )
  const gatedNoteIds = new Set(
    notes.filter(n => noteGates(n).length > 0).map(n => n.id)
  )

  return {
    gatedBubbleIds,
    gatedNoteIds,
    isGated: item =>
      item?.type === 'note' ? gatedNoteIds.has(item.id) : gatedBubbleIds.has(item.id),
    // Every id that must be unlocked before `item` becomes visible — the item
    // itself when it carries its own lock, plus any locked ancestor bubbles.
    gatingIdsFor: item =>
      item?.type === 'note' ? noteGates(item) : bubbleChainGates(item.id),
  }
}
