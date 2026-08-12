// Suggested bubble names, and the matcher that picks which ones to offer.
//
// Naming a bubble is the one moment the app asks for a word before it will do anything,
// and a blank field is a worse prompt than a short list of the things people actually
// keep. These are suggestions in the weakest sense: nothing here constrains what can be
// typed, and the list gets out of the way the moment it has nothing to offer.

// Shown to an empty field, most universal first.
export const COMMON_BUBBLE_NAMES = [
  'Ideas', 'Work', 'To Do', 'Journal', 'Reading',
  'Goals', 'Health', 'Travel', 'Recipes', 'Random',
]

// The pool matched against as the user types. Order is rank: within a run of equally
// good matches, the earlier name wins, so the broad categories that open each group
// come out ahead of the specific ones that follow them.
export const BUBBLE_NAME_SUGGESTIONS = [
  'Work', 'Projects', 'Meetings', 'Career', 'Clients',
  'Team', 'Deadlines', 'Admin', 'Networking', 'Job Search',
  'School', 'Classes', 'Study Notes', 'Research', 'Reading',
  'Books', 'Courses', 'Lectures', 'Languages', 'Skills',
  'Ideas', 'Random', 'Questions', 'Insights', 'Thoughts',
  'Observations', 'Theories', 'Concepts', 'Ethics', 'Brainstorm',
  'Half-Baked', 'Miscellaneous',
  'Self', 'Reflections', 'Journal', 'Values', 'Habits',
  'Growth', 'Mindset', 'Emotions', 'Dreams', 'Gratitude',
  'Lessons',
  'Goals', 'Plans', 'To Do', 'Lists', 'Someday',
  'Bucket List', 'Resolutions', 'Priorities', 'Routines', 'Systems',
  'Progress',
  'Writing', 'Essays', 'Stories', 'Poetry', 'Music',
  'Art', 'Design', 'Photography', 'Lyrics', 'Drafts',
  'Health', 'Fitness', 'Workouts', 'Nutrition', 'Sleep',
  'Mental Health', 'Therapy', 'Recovery', 'Medical', 'Energy',
  'Relationships', 'Family', 'Friends', 'Partner', 'Conversations',
  'People', 'Social', 'Society', 'Advice', 'Conflicts',
  'Memories',
  'Finances', 'Budget', 'Investing', 'Home', 'Travel',
  'Trips', 'Shopping', 'Grocery', 'Recipes', 'Errands',
  'Documents', 'Archive', 'Trash',
  'Movies', 'TV Shows', 'Watch', 'Podcasts', 'Quotes',
  'Links', 'Social Media', 'Games', 'Sports', 'Tech',
  'AI', 'Hobbies', 'Wishlist',
]

// Every name worth offering for `query`, best first — the whole ranked run, not a
// window onto it. How many are on screen at once is the list's business (it scrolls);
// cutting the data short here would put names permanently out of reach instead.
//
// An empty field gets the common ten and then the rest of the ranked list behind them,
// so the names most people want are a glance away and the others a scroll away. Anything
// typed is matched case-insensitively, with a name the query starts off ranked above one
// that merely contains it — "read" offers Reading before Study Notes. Returns nothing
// when nothing matches, which is the signal to show no list at all rather than an empty
// box: a name that isn't here is a name the app has no business questioning.
export function suggestBubbleNames(query, { exclude = [], limit = Infinity } = {}) {
  const taken = new Set(exclude.map(name => name.trim().toLowerCase()))
  const q = (query || '').trim().toLowerCase()
  const free = (name) => !taken.has(name.toLowerCase())

  if (!q) {
    const common = new Set(COMMON_BUBBLE_NAMES)
    return [
      ...COMMON_BUBBLE_NAMES,
      ...BUBBLE_NAME_SUGGESTIONS.filter(name => !common.has(name)),
    ].filter(free).slice(0, limit)
  }

  const startsWith = []
  const contains = []
  for (const name of BUBBLE_NAME_SUGGESTIONS) {
    if (!free(name)) continue
    const at = name.toLowerCase().indexOf(q)
    if (at === 0) startsWith.push(name)
    else if (at > 0) contains.push(name)
  }
  return [...startsWith, ...contains].slice(0, limit)
}

// Where `query` sits inside `name`, for bolding the matched run. Returns null when
// there is nothing to mark.
export function matchRange(name, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return null
  const at = name.toLowerCase().indexOf(q)
  return at === -1 ? null : { start: at, end: at + q.length }
}
