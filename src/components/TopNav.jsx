import { useState, useRef, useEffect } from 'react'

export default function TopNav({
  projectList,
  activeProject,
  onSwitchProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  sidebarOpen,
  onToggleSidebar,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const dropdownRef = useRef(null)
  const newNameRef = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false)
        setCreatingProject(false)
        setRenamingId(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    if (creatingProject && newNameRef.current) newNameRef.current.focus()
  }, [creatingProject])

  function handleCreateProject() {
    const name = newProjectName.trim()
    if (!name) return
    onCreateProject(name)
    setNewProjectName('')
    setCreatingProject(false)
    setDropdownOpen(false)
  }

  function handleRename(id) {
    const name = renameValue.trim()
    if (!name) return
    onRenameProject(id, name)
    setRenamingId(null)
  }

  function handleDelete(id, name) {
    if (window.confirm(`Delete project "${name}"? This cannot be undone.`)) {
      onDeleteProject(id)
      setDropdownOpen(false)
    }
  }

  return (
    <nav className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-200 shadow-sm z-50 flex-shrink-0">
      {/* Hamburger / Sidebar toggle */}
      <button
        onClick={onToggleSidebar}
        className="p-2 rounded-md text-gray-500 hover:bg-gray-100 transition-colors"
        aria-label="Toggle sidebar"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d={sidebarOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
        </svg>
      </button>

      {/* Logo */}
      <span className="font-semibold text-gray-800 text-sm hidden sm:block mr-1">MindMap</span>

      {/* Project dropdown */}
      <div className="relative flex-1 sm:flex-none" ref={dropdownRef}>
        <button
          onClick={() => { setDropdownOpen(o => !o); setCreatingProject(false); setRenamingId(null) }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 rounded-lg text-sm font-medium transition-colors max-w-[200px] sm:max-w-xs"
        >
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
          </svg>
          <span className="truncate">{activeProject.name}</span>
          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {dropdownOpen && (
          <div className="absolute top-full left-0 mt-1 w-64 bg-white rounded-xl shadow-xl border border-gray-100 z-50 py-1">
            <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Projects</div>

            {projectList.map(proj => (
              <div key={proj.id} className="group flex items-center gap-1 px-2">
                {renamingId === proj.id ? (
                  <div className="flex-1 flex items-center gap-1 py-1">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename(proj.id)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="flex-1 px-2 py-1 text-sm border border-indigo-300 rounded-md outline-none"
                    />
                    <button onClick={() => handleRename(proj.id)}
                      className="text-xs px-2 py-1 bg-indigo-600 text-white rounded-md">OK</button>
                    <button onClick={() => setRenamingId(null)}
                      className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700">✕</button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => { onSwitchProject(proj.id); setDropdownOpen(false) }}
                      className={`flex-1 text-left px-2 py-2 text-sm rounded-lg transition-colors ${
                        proj.id === activeProject.id
                          ? 'bg-indigo-50 text-indigo-700 font-medium'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {proj.name}
                    </button>
                    <div className="hidden group-hover:flex items-center gap-0.5">
                      <button
                        onClick={() => { setRenamingId(proj.id); setRenameValue(proj.name) }}
                        className="p-1 text-gray-400 hover:text-gray-600 rounded"
                        title="Rename"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      {projectList.length > 1 && (
                        <button
                          onClick={() => handleDelete(proj.id, proj.name)}
                          className="p-1 text-gray-400 hover:text-red-500 rounded"
                          title="Delete"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}

            <div className="border-t border-gray-100 mt-1 pt-1 px-2">
              {creatingProject ? (
                <div className="flex items-center gap-1 py-1">
                  <input
                    ref={newNameRef}
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleCreateProject()
                      if (e.key === 'Escape') setCreatingProject(false)
                    }}
                    placeholder="Project name..."
                    className="flex-1 px-2 py-1 text-sm border border-indigo-300 rounded-md outline-none"
                  />
                  <button onClick={handleCreateProject}
                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded-md">Create</button>
                </div>
              ) : (
                <button
                  onClick={() => setCreatingProject(true)}
                  className="w-full flex items-center gap-2 px-2 py-2 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                >
                  <span className="text-lg leading-none">+</span>
                  <span>New Project</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1">
        {/* Settings icon (future use) */}
        <button className="p-2 rounded-md text-gray-400 hover:bg-gray-100 transition-colors" aria-label="Settings">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>
    </nav>
  )
}
