import { useState } from 'react'
import BubbleTree from './BubbleTree'
import { BUBBLE_COLORS } from '../data/defaultData'
import { generateId } from '../utils/helpers'

export default function Sidebar({
  open,
  project,
  selectedBubbleId,
  onSelectBubble,
  onAddBubble,
  onRenameBubble,
  onDeleteBubble,
  onClose,
}) {
  const [addingBubble, setAddingBubble] = useState(false)
  const [newBubbleName, setNewBubbleName] = useState('')
  const [newBubbleColor, setNewBubbleColor] = useState(BUBBLE_COLORS[0])
  const [newBubbleParentId, setNewBubbleParentId] = useState(null)

  function handleAddBubble() {
    const name = newBubbleName.trim()
    if (!name) return
    onAddBubble({
      id: generateId(),
      name,
      parent_id: newBubbleParentId,
      color: newBubbleColor,
    })
    setNewBubbleName('')
    setNewBubbleColor(BUBBLE_COLORS[0])
    setNewBubbleParentId(null)
    setAddingBubble(false)
  }

  const rootBubbles = project.bubbles.filter(b => b.parent_id === null)

  return (
    <>
      {/* Overlay for mobile */}
      {open && (
        <div
          className="fixed inset-0 bg-black/30 z-20 md:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        flex-shrink-0 w-64 bg-white border-r border-gray-200
        flex flex-col
        transition-all duration-200 ease-in-out overflow-hidden
        ${open ? 'translate-x-0' : '-translate-x-full'}
        fixed md:relative inset-y-0 left-0 z-30 md:z-auto
        md:translate-x-0
        ${!open ? 'md:w-0 md:border-r-0' : 'md:w-64'}
        top-[49px] md:top-auto
      `}>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {/* All notes shortcut */}
          <div className="px-3 pt-3">
            <button
              onClick={() => onSelectBubble(null)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                selectedBubbleId === null
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              All Notes
              <span className="ml-auto text-xs text-gray-400">{project.notes.length}</span>
            </button>
          </div>

          {/* Bubbles section */}
          <div className="px-3 pt-4 pb-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Bubbles</span>
            </div>

            {project.bubbles.length === 0 ? (
              <p className="text-xs text-gray-400 px-1">No bubbles yet</p>
            ) : (
              <BubbleTree
                bubbles={project.bubbles}
                notes={project.notes}
                parentId={null}
                selectedBubbleId={selectedBubbleId}
                onSelectBubble={onSelectBubble}
                onRenameBubble={onRenameBubble}
                onDeleteBubble={onDeleteBubble}
                onAddChildBubble={(parentId) => {
                  setNewBubbleParentId(parentId)
                  setAddingBubble(true)
                }}
              />
            )}
          </div>
        </div>

        {/* Add bubble button */}
        <div className="p-3 border-t border-gray-100">
          {addingBubble ? (
            <div className="space-y-2">
              <input
                autoFocus
                value={newBubbleName}
                onChange={e => setNewBubbleName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleAddBubble()
                  if (e.key === 'Escape') { setAddingBubble(false); setNewBubbleName('') }
                }}
                placeholder={newBubbleParentId
                  ? `Child of "${project.bubbles.find(b => b.id === newBubbleParentId)?.name}"`
                  : "Bubble name..."}
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:border-indigo-300"
              />
              <div className="flex gap-1 flex-wrap">
                {BUBBLE_COLORS.map(color => (
                  <button
                    key={color}
                    onClick={() => setNewBubbleColor(color)}
                    className={`w-5 h-5 rounded-full transition-transform ${newBubbleColor === color ? 'ring-2 ring-offset-1 ring-gray-600 scale-110' : ''}`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAddBubble}
                  className="flex-1 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                >
                  Add
                </button>
                <button
                  onClick={() => { setAddingBubble(false); setNewBubbleName(''); setNewBubbleParentId(null) }}
                  className="flex-1 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setNewBubbleParentId(null); setAddingBubble(true) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            >
              <span className="text-lg leading-none">+</span>
              <span>New Bubble</span>
            </button>
          )}
        </div>
      </aside>
    </>
  )
}
