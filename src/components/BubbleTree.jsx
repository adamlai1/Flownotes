import { useState } from 'react'
import { getNoteCountForBubble, contrastColor } from '../utils/helpers'

function BubbleNode({
  bubble,
  bubbles,
  notes,
  depth,
  selectedBubbleId,
  onSelectBubble,
  onRenameBubble,
  onDeleteBubble,
  onAddChildBubble,
}) {
  const [expanded, setExpanded] = useState(true)
  const [hovering, setHovering] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const children = bubbles.filter(b => b.parent_id === bubble.id)
  const noteCount = getNoteCountForBubble(notes, bubble.id, bubbles)
  const isSelected = selectedBubbleId === bubble.id

  function handleRename() {
    const name = renameValue.trim()
    if (name) onRenameBubble(bubble.id, name)
    setRenaming(false)
  }

  function handleDelete() {
    if (window.confirm(`Delete bubble "${bubble.name}"? Notes won't be deleted.`)) {
      onDeleteBubble(bubble.id)
    }
  }

  return (
    <div>
      <div
        className="relative flex items-center group"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {/* Expand/collapse toggle */}
        {children.length > 0 ? (
          <button
            onClick={() => setExpanded(e => !e)}
            className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-600 flex-shrink-0"
          >
            <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {renaming ? (
          <div className="flex-1 flex items-center gap-1 py-0.5">
            <input
              autoFocus
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
              className="flex-1 px-1.5 py-0.5 text-xs border border-indigo-300 rounded outline-none"
            />
            <button onClick={handleRename} className="text-xs text-indigo-600 font-medium px-1">OK</button>
          </div>
        ) : (
          <button
            onClick={() => onSelectBubble(bubble.id)}
            className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm transition-colors text-left min-w-0 ${
              isSelected ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: bubble.color }}
            />
            <span className="truncate">{bubble.name}</span>
            <span className="ml-auto text-xs text-gray-400 flex-shrink-0">{noteCount || ''}</span>
          </button>
        )}

        {/* Actions */}
        {hovering && !renaming && (
          <div className="absolute right-1 flex items-center gap-0.5 bg-white rounded shadow-sm border border-gray-100 z-10">
            <button
              onClick={() => onAddChildBubble(bubble.id)}
              className="p-1 text-gray-400 hover:text-indigo-600"
              title="Add child bubble"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <button
              onClick={() => { setRenaming(true); setRenameValue(bubble.name) }}
              className="p-1 text-gray-400 hover:text-blue-600"
              title="Rename"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              onClick={handleDelete}
              className="p-1 text-gray-400 hover:text-red-500"
              title="Delete bubble"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {expanded && children.length > 0 && (
        <div>
          {children.map(child => (
            <BubbleNode
              key={child.id}
              bubble={child}
              bubbles={bubbles}
              notes={notes}
              depth={depth + 1}
              selectedBubbleId={selectedBubbleId}
              onSelectBubble={onSelectBubble}
              onRenameBubble={onRenameBubble}
              onDeleteBubble={onDeleteBubble}
              onAddChildBubble={onAddChildBubble}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function BubbleTree({
  bubbles,
  notes,
  parentId,
  selectedBubbleId,
  onSelectBubble,
  onRenameBubble,
  onDeleteBubble,
  onAddChildBubble,
}) {
  const rootBubbles = bubbles.filter(b => b.parent_id === parentId)

  return (
    <div className="space-y-0.5">
      {rootBubbles.map(bubble => (
        <BubbleNode
          key={bubble.id}
          bubble={bubble}
          bubbles={bubbles}
          notes={notes}
          depth={0}
          selectedBubbleId={selectedBubbleId}
          onSelectBubble={onSelectBubble}
          onRenameBubble={onRenameBubble}
          onDeleteBubble={onDeleteBubble}
          onAddChildBubble={onAddChildBubble}
        />
      ))}
    </div>
  )
}
