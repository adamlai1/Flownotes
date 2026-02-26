import { useState, useEffect, useRef } from 'react'

export default function CreateNoteModal({ project, onClose, onCreateNote }) {
  const [content, setContent] = useState('')
  const [selectedBubbleIds, setSelectedBubbleIds] = useState([])
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState([])
  const textareaRef = useRef(null)

  useEffect(() => {
    if (textareaRef.current) textareaRef.current.focus()
    function handleKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  function handleCreate() {
    if (!content.trim()) return
    onCreateNote({ content: content.trim(), bubble_ids: selectedBubbleIds, tags })
    onClose()
  }

  function toggleBubble(id) {
    setSelectedBubbleIds(prev =>
      prev.includes(id) ? prev.filter(b => b !== id) : [...prev, id]
    )
  }

  function addTag() {
    const tag = tagInput.trim().replace(/^#/, '')
    if (tag && !tags.includes(tag)) {
      setTags(prev => [...prev, tag])
    }
    setTagInput('')
  }

  function removeTag(tag) {
    setTags(prev => prev.filter(t => t !== tag))
  }

  const rootBubbles = project.bubbles.filter(b => b.parent_id === null)

  function renderBubbleCheckboxes(parentId = null, depth = 0) {
    const items = project.bubbles.filter(b => b.parent_id === parentId)
    if (items.length === 0) return null
    return items.map(bubble => (
      <div key={bubble.id}>
        <label
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer"
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          <input
            type="checkbox"
            checked={selectedBubbleIds.includes(bubble.id)}
            onChange={() => toggleBubble(bubble.id)}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: bubble.color }}
          />
          <span className="text-sm text-gray-700">{bubble.name}</span>
        </label>
        {renderBubbleCheckboxes(bubble.id, depth + 1)}
      </div>
    ))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">New Note</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 scrollbar-thin">
          {/* Text area */}
          <div className="px-4 pt-3">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Write your note..."
              rows={6}
              className="w-full text-sm text-gray-800 placeholder-gray-300 outline-none resize-none leading-relaxed"
            />
          </div>

          {/* Bubbles */}
          {project.bubbles.length > 0 && (
            <div className="px-4 pb-3 border-t border-gray-50 pt-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Add to Bubbles</p>
              <div className="space-y-0.5 max-h-40 overflow-y-auto scrollbar-thin">
                {renderBubbleCheckboxes()}
              </div>
            </div>
          )}

          {/* Tags */}
          <div className="px-4 pb-3 border-t border-gray-50 pt-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tags</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs"
                >
                  #{tag}
                  <button onClick={() => removeTag(tag)} className="hover:text-red-500">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() }
                }}
                placeholder="Add tag..."
                className="flex-1 text-sm px-2 py-1.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-300"
              />
              <button
                onClick={addTag}
                className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
              >
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-100 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!content.trim()}
            className="flex-1 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 rounded-xl transition-colors"
          >
            Create Note
          </button>
        </div>
      </div>
    </div>
  )
}
