import { useState, useRef, useMemo, useEffect } from 'react'
import { motion } from 'framer-motion'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { getNoteTitle } from '../utils/helpers'

// ── Text splitting / note building ─────────────────────────────────────────────

function splitText(text, mode, sep) {
  const t = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!t.trim()) return []
  if (mode === 'blank') return t.split(/\n[ \t]*\n+/).map(s => s.trim()).filter(Boolean)
  if (mode === 'custom') {
    if (!sep) return [t.trim()]
    return t.split(sep).map(s => s.trim()).filter(Boolean)
  }
  return [t.trim()] // keep as one note
}

// First line = title, rest = body — for every note, regardless of length.
function buildNoteContent(chunk) {
  return chunk.trim()
}

function flattenBubbles(bubbles, parentId = null, depth = 0) {
  const out = []
  for (const b of bubbles.filter(x => (x.parent_id ?? null) === parentId)) {
    out.push({ id: b.id, name: b.name, color: b.color, depth })
    out.push(...flattenBubbles(bubbles, b.id, depth + 1))
  }
  return out
}

// Root level has no bubble colour of its own; a root OVERRIDE still needs to read as
// "custom", so it borrows the accent.
const ROOT_ACCENT = '#6366f1'

// ── UI bits ─────────────────────────────────────────────────────────────────────

function Pill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors flex-shrink-0"
      style={active
        ? { background: '#6366f1', color: '#fff' }
        : { background: 'var(--hover)', color: 'var(--text-2)', border: '1px solid var(--border)' }}
    >
      {children}
    </button>
  )
}

// The list of destinations, shared by every picker (root + every bubble, indented).
function BubbleOptions({ rootLabel, options }) {
  return (
    <>
      <option value="">{rootLabel}</option>
      {options.map(b => (
        <option key={b.id} value={b.id}>{' '.repeat(b.depth * 3)}{b.name}</option>
      ))}
    </>
  )
}

// A bubble pill with a transparent native <select> laid over it, so tapping the pill
// opens the platform picker instead of a hand-rolled dropdown (works well on mobile).
// `custom` styles the pill in the bubble's colour; otherwise it stays grey to show the
// note is just following the default.
function BubblePill({ value, custom, color, label, rootLabel, options, onChange }) {
  const tint = color || ROOT_ACCENT
  return (
    <div className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
      <span
        className="flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-full text-[10px] font-medium max-w-[132px]"
        style={custom
          ? { background: `${tint}22`, color: tint, border: `1px solid ${tint}66` }
          : { background: 'var(--hover)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: custom ? tint : 'var(--text-muted)' }}
        />
        <span className="truncate">{label}</span>
        <svg className="w-2.5 h-2.5 flex-shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
        </svg>
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-label="Assign bubble"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        <BubbleOptions rootLabel={rootLabel} options={options} />
      </select>
    </div>
  )
}

export default function ImportNotes({ project, onImportNotes, onClose, showToast }) {
  const [stage, setStage] = useState('menu') // 'menu' | 'paste' | 'preview'
  const [rawText, setRawText] = useState('')
  const [pasteValue, setPasteValue] = useState('')
  const [splitMode, setSplitMode] = useState('one') // 'one' | 'blank' | 'custom'
  const [customSep, setCustomSep] = useState('---')
  const [defaultBubble, setDefaultBubble] = useState('') // '' = root level
  // Per-note destinations the user set explicitly, keyed by index into `notes`.
  // Anything absent here follows `defaultBubble`.
  const [overrides, setOverrides] = useState({})
  const [selected, setSelected] = useState(() => new Set())
  const [loadingPdf, setLoadingPdf] = useState(false)
  const fileInputRef = useRef(null)

  const chunks = useMemo(() => splitText(rawText, splitMode, customSep), [rawText, splitMode, customSep])
  const notes = useMemo(
    () => chunks.map((chunk, i) => {
      const content = buildNoteContent(chunk)
      return {
        content,
        title: getNoteTitle(content) || `Imported Note ${i + 1}`,
        preview: content.split('\n').slice(1).join(' ').trim(),
      }
    }),
    [chunks],
  )
  const bubbleOptions = useMemo(() => flattenBubbles(project.bubbles || []), [project.bubbles])
  const bubbleById = useMemo(() => {
    const m = new Map()
    for (const b of bubbleOptions) m.set(b.id, b)
    return m
  }, [bubbleOptions])
  const rootLabel = project.name || 'Root level'

  // Overrides are keyed by position, so any change that re-splits the text invalidates
  // them (chunk N is no longer the same note). Drop them along with the selection.
  useEffect(() => {
    setOverrides({})
    setSelected(new Set())
  }, [rawText, splitMode, customSep])

  // Resolved destination for a note, and whether that came from an explicit override.
  // Comparing against the default (rather than just "is there an override?") keeps a
  // note grey when its override happens to match the default.
  const bubbleFor = (i) => (i in overrides ? overrides[i] : defaultBubble)
  const isCustom = (i) => bubbleFor(i) !== defaultBubble

  function assignOne(i, bubbleId) {
    setOverrides(prev => ({ ...prev, [i]: bubbleId }))
  }

  function assignSelected(bubbleId) {
    setOverrides(prev => {
      const next = { ...prev }
      for (const i of selected) next[i] = bubbleId
      return next
    })
    setSelected(new Set())
  }

  function toggleSelected(i) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const overrideCount = useMemo(
    () => notes.reduce((acc, _, i) => acc + (isCustom(i) ? 1 : 0), 0),
    [notes, overrides, defaultBubble], // eslint-disable-line react-hooks/exhaustive-deps
  )

  function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    const name = file.name.toLowerCase()
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      readPdf(file)
    } else {
      const reader = new FileReader()
      reader.onload = () => { setRawText(String(reader.result || '')); setStage('preview') }
      reader.onerror = () => showToast('Could not read file')
      reader.readAsText(file)
    }
  }

  async function readPdf(file) {
    setLoadingPdf(true)
    try {
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      const buf = await file.arrayBuffer()
      const pdf = await pdfjs.getDocument({ data: buf }).promise
      let text = ''
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p)
        const content = await page.getTextContent()
        text += content.items.map(it => it.str).join(' ') + '\n\n'
      }
      setRawText(text.trim())
      setStage('preview')
    } catch (err) {
      console.error('PDF read error:', err)
      showToast('Could not read PDF')
    } finally {
      setLoadingPdf(false)
    }
  }

  function doImport() {
    const count = onImportNotes(notes.map((n, i) => {
      const bubbleId = bubbleFor(i)
      return { content: n.content, bubble_ids: bubbleId ? [bubbleId] : [] }
    }))
    showToast(`Imported ${count} note${count === 1 ? '' : 's'}`)
    onClose()
  }

  function back() {
    if (stage === 'preview') {
      setStage('menu'); setRawText(''); setPasteValue('')
      setOverrides({}); setSelected(new Set()); setDefaultBubble('')
    }
    else if (stage === 'paste') setStage('menu')
    else onClose()
  }

  return (
    <motion.div
      data-modal
      className="fixed inset-0 flex flex-col"
      style={{ zIndex: 60, background: 'var(--surface)', color: 'var(--text)' }}
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'tween', duration: 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      {/* Header */}
      <div
        className="flex-shrink-0 relative flex items-center px-3"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))', paddingBottom: 10, borderBottom: '1px solid var(--border)' }}
      >
        <button onClick={back} className="flex items-center gap-0.5 font-medium text-[15px] py-1 -ml-1 flex-shrink-0 z-10 text-indigo-400 hover:text-indigo-300 transition-colors">
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          <span>{stage === 'menu' ? 'Settings' : 'Back'}</span>
        </button>
        <span className="absolute inset-x-0 text-center text-[15px] font-semibold pointer-events-none" style={{ color: 'var(--text)' }}>
          Import Notes
        </span>
      </div>

      <input ref={fileInputRef} type="file" accept=".txt,.pdf,text/plain,application/pdf" onChange={handleFile} className="hidden" />

      {/* ── Menu: choose a source ───────────────────────────────────────────── */}
      {stage === 'menu' && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-lg mx-auto px-4 pt-8 space-y-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loadingPdf}
              className="w-full flex items-center gap-3 px-4 py-4 rounded-2xl active:opacity-70 transition-opacity text-left"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
            >
              <span className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'rgba(99,102,241,0.18)' }}>
                <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.9A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              </span>
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{loadingPdf ? 'Reading PDF…' : 'Import from File'}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Choose a .txt or .pdf file</p>
              </div>
            </button>

            <button
              onClick={() => setStage('paste')}
              className="w-full flex items-center gap-3 px-4 py-4 rounded-2xl active:opacity-70 transition-opacity text-left"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
            >
              <span className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'rgba(52,199,89,0.18)' }}>
                <svg className="w-5 h-5" style={{ color: '#34C759' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
              </span>
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Paste Text</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Paste copied notes (select all → copy → paste)</p>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* ── Paste: large text area ──────────────────────────────────────────── */}
      {stage === 'paste' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="max-w-lg w-full mx-auto px-4 pt-4 flex-1 flex flex-col min-h-0">
            <textarea
              autoFocus
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              placeholder="Paste your notes here…"
              className="flex-1 w-full rounded-2xl p-4 text-sm outline-none resize-none"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', userSelect: 'text', WebkitUserSelect: 'text' }}
            />
          </div>
          <div className="max-w-lg w-full mx-auto px-4 py-4" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
            <button
              onClick={() => { setRawText(pasteValue); setStage('preview') }}
              disabled={!pasteValue.trim()}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-opacity disabled:opacity-40"
              style={{ background: '#6366f1' }}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ── Preview + options ───────────────────────────────────────────────── */}
      {stage === 'preview' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-lg mx-auto px-4 pt-4 space-y-4" style={{ paddingBottom: '1rem' }}>
              {/* Split options */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider mb-2 px-1" style={{ color: 'var(--text-muted)' }}>Split into notes</p>
                <div className="flex gap-2 flex-wrap">
                  <Pill active={splitMode === 'one'} onClick={() => setSplitMode('one')}>Keep as One Note</Pill>
                  <Pill active={splitMode === 'blank'} onClick={() => setSplitMode('blank')}>Split by Blank Lines</Pill>
                  <Pill active={splitMode === 'custom'} onClick={() => setSplitMode('custom')}>Custom Separator</Pill>
                </div>
                {splitMode === 'custom' && (
                  <input
                    value={customSep}
                    onChange={e => setCustomSep(e.target.value)}
                    placeholder="Separator, e.g. ---"
                    className="mt-2 w-full px-3 py-2 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', userSelect: 'text', WebkitUserSelect: 'text' }}
                  />
                )}
              </div>

              {/* Default destination for every note */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider mb-2 px-1" style={{ color: 'var(--text-muted)' }}>Import all to</p>
                <select
                  value={defaultBubble}
                  onChange={e => setDefaultBubble(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg text-sm outline-none appearance-none"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}
                >
                  <BubbleOptions rootLabel={rootLabel} options={bubbleOptions} />
                </select>
                {overrideCount > 0 && (
                  <p className="text-[11px] mt-1.5 px-1" style={{ color: 'var(--text-muted)' }}>
                    {overrideCount} note{overrideCount === 1 ? '' : 's'} assigned separately
                  </p>
                )}
              </div>

              {/* Preview list */}
              <div>
                <div className="flex items-baseline justify-between mb-2 px-1 gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    This will create {notes.length} note{notes.length === 1 ? '' : 's'}
                  </p>
                  {notes.length > 0 && (
                    <p className="text-[11px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>Tap to select</p>
                  )}
                </div>
                <div className="space-y-2">
                  {notes.slice(0, 200).map((n, i) => {
                    const bid = bubbleFor(i)
                    const bubble = bid ? bubbleById.get(bid) : null
                    const custom = isCustom(i)
                    const isSel = selected.has(i)
                    return (
                      <div
                        key={i}
                        onClick={() => toggleSelected(i)}
                        className="rounded-xl px-3 py-2.5 flex items-start gap-2 cursor-pointer transition-colors"
                        style={{
                          background: isSel ? 'rgba(99,102,241,0.12)' : 'var(--surface-2)',
                          border: `1px solid ${isSel ? 'rgba(99,102,241,0.55)' : 'var(--border)'}`,
                        }}
                      >
                        {/* Selection checkmark */}
                        <span
                          className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full flex items-center justify-center transition-colors"
                          style={isSel
                            ? { background: '#6366f1' }
                            : { border: '1.5px solid var(--border)' }}
                        >
                          {isSel && (
                            <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </span>

                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate" style={{ color: 'var(--text)' }}>{n.title || 'Untitled'}</p>
                          {n.preview && (
                            <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {n.preview}
                            </p>
                          )}
                        </div>

                        <BubblePill
                          value={bid}
                          custom={custom}
                          color={bubble?.color}
                          label={bubble ? bubble.name : rootLabel}
                          rootLabel={rootLabel}
                          options={bubbleOptions}
                          onChange={v => assignOne(i, v)}
                        />
                      </div>
                    )
                  })}
                  {notes.length > 200 && (
                    <p className="text-xs text-center py-2" style={{ color: 'var(--text-muted)' }}>…and {notes.length - 200} more</p>
                  )}
                  {notes.length === 0 && (
                    <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>Nothing to import</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Bulk reassign + import */}
          <div className="max-w-lg w-full mx-auto px-4 py-4" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))', borderTop: '1px solid var(--border)' }}>
            {selected.size > 0 && (
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-2)' }}>
                  {selected.size} selected
                </span>
                {/* Transparent select over the button, same trick as the pills */}
                <div className="relative flex-1 min-w-0">
                  <span
                    className="flex items-center justify-center gap-1 w-full py-2 rounded-lg text-xs font-medium"
                    style={{ background: 'var(--hover)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  >
                    Move selected to…
                    <svg className="w-3 h-3 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                    </svg>
                  </span>
                  {/* value is a placeholder so picking ANY real option (incl. root) fires change */}
                  <select
                    value="__placeholder"
                    onChange={e => { if (e.target.value !== '__placeholder') assignSelected(e.target.value) }}
                    aria-label="Move selected notes to bubble"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  >
                    <option value="__placeholder" disabled hidden>Move selected to…</option>
                    <BubbleOptions rootLabel={rootLabel} options={bubbleOptions} />
                  </select>
                </div>
                <button
                  onClick={() => setSelected(new Set())}
                  className="text-xs font-medium flex-shrink-0 px-2 py-2 text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  Clear
                </button>
              </div>
            )}
            <button
              onClick={doImport}
              disabled={notes.length === 0}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-opacity disabled:opacity-40"
              style={{ background: '#6366f1' }}
            >
              Import {notes.length} Note{notes.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}
    </motion.div>
  )
}
