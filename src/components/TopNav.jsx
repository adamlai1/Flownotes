import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useBodyScrollLock } from '../lib/bodyScrollLock'

export default function TopNav({
  projectList,
  activeProject,
  onSwitchProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  sidebarOpen,
  onToggleSidebar,
  onOpenSettings,
  onGoToProjectRoot,
  atProjectRoot,
  controlsSlotRef,
  isDesktop,
  syncStatus,
  onSignOut,
}) {
  const { user } = useAuth()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef(null)

  // Dismissal is a real backdrop (rendered with the menu below), not a
  // document listener: a document-level outside-close lets the very tap that
  // dismisses the menu also activate whatever it lands on — e.g. opening a
  // bubble on the canvas. The backdrop swallows that tap instead.
  const [dropdownOpen, setDropdownOpen] = useState(false)
  // Word-boundary truncation for the pill's project name: when the full name
  // overflows, trailing words are dropped one at a time (with an ellipsis) until
  // it fits — "Personal…" instead of "Person…". Measured, so it adapts to the
  // pill's actual width; a single overflowing word falls back to CSS ellipsis.
  const pillNameRef = useRef(null)
  // Viewport clamp for the project dropdown (same pattern as the canvas's sort
  // menu): centred under the pill, then measured and shifted inward if it would
  // overflow either screen edge — so it survives future layout moves unchanged.
  // The clamp owns the element's transform (the centring -50% lives there too).
  const projectMenuRef = useRef(null)
  useLayoutEffect(() => {
    if (!dropdownOpen) return
    const el = projectMenuRef.current
    if (!el) return
    el.style.transform = 'translateX(-50%)'
    const r = el.getBoundingClientRect()
    const pad = 8
    let dx = 0
    if (r.left < pad) dx = pad - r.left
    else if (r.right > window.innerWidth - pad) dx = (window.innerWidth - pad) - r.right
    if (dx) el.style.transform = `translateX(calc(-50% + ${dx}px))`
  }, [dropdownOpen])
  const [pillName, setPillName] = useState(activeProject.name)
  useEffect(() => {
    const reset = () => setPillName(activeProject.name)
    reset()
    window.addEventListener('resize', reset)
    return () => window.removeEventListener('resize', reset)
  }, [activeProject.name])
  useLayoutEffect(() => {
    const el = pillNameRef.current
    if (!el) return
    if (el.scrollWidth <= el.clientWidth + 1) return
    const base = pillName.endsWith('…') ? pillName.slice(0, -1).trimEnd() : pillName
    const words = base.split(' ')
    if (words.length <= 1) return // single word: CSS ellipsis takes over
    setPillName(words.slice(0, -1).join(' ') + '…')
  })
  const [newProjectName, setNewProjectName] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  // Project rename / new-project inputs raise the keyboard — hold the app
  // shell still while one is mounted (see bodyScrollLock).
  useBodyScrollLock(creatingProject || renamingId !== null)
  const dropdownRef = useRef(null)
  const newNameRef = useRef(null)

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
    // EXPERIMENT (neutral scheme): originally bg-gray-900 (navy #111827) with a
    // border-b and nav shadow; then var(--surface). Now the bar has NO container at
    // all — no surface, border, or shadow — its controls float directly on the
    // ground (--bg, pure black in dark). The safe-area paddingTop stays: it is what
    // keeps the controls out of the notch/clock area. Revert by restoring
    // 'border-b border-gray-800' and background 'var(--surface)' +
    // boxShadow 'var(--nav-shadow, none)'.
    // Transparent + relative: the app-shell vignette band (AppVignette) paints
    // behind this bar, so the bar must not cover it — and being positioned makes
    // the z-30 effective, keeping the controls crisp above the band.
    // pb-0.5 (not py-2's 8px): row 2 sits directly beneath, and the tighter
    // bottom padding is what makes the two rows read as one header cluster.
    <nav className="relative flex items-center px-3 pt-2 pb-0.5 z-30 flex-shrink-0"
      style={{ paddingTop: 'max(8px, env(safe-area-inset-top))', background: 'transparent' }}
    >
      {/* Inner relative row: the project pill is ABSOLUTELY positioned at its
          centre (same approach as the note editor's title), so it stays visually
          centred on the viewport no matter how wide the left group (hamburger +
          sort + select) or the right group is — in-flow centering would drift
          with the groups' widths. */}
      <div className="relative flex items-center w-full">
      {/* Left: Hamburger */}
      <div className="flex items-center flex-shrink-0">
        <button
          onClick={onToggleSidebar}
          className="flex p-2 text-gray-400"
          style={{ WebkitTapHighlightColor: 'transparent', outline: 'none', background: 'none' }}
          aria-label="Toggle sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d={(sidebarOpen && !isDesktop) ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
          </svg>
        </button>
      </div>

      {/* Project pill — viewport-centred via absolute positioning (out of flow, so
          the left/right groups can't push it). z-10 keeps it tappable above the
          in-flow groups if a very long name ever meets a wide left group. */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10" ref={dropdownRef}>
        {/* Split pill: the NAME half navigates to the project root canvas (no-op
            when already there — App guards it); the CHEVRON half opens the project
            switcher. A hairline divider separates the two targets, and each half
            gives its own press feedback (active:opacity) so it is obvious which
            one was hit. */}
        {/* No overflow-hidden on the wrapper: both halves carry invisible vertical
            hit-slop (py-3 -my-1.5 → 44px effective touch height on a 32px visual),
            and clipping would cut the slop off. The halves paint no background of
            their own, so nothing escapes the rounded pill visually. */}
        <div
          // 140px cap on phones: an absolute pill can't flex-shrink against its
          // neighbours, so the cap is what guarantees a long name never reaches
          // under the sort/select group beside it.
          className="flex items-stretch rounded-lg max-w-[140px] sm:max-w-xs"
          style={{ background: 'var(--hover)', color: 'var(--text)' }}
        >
          <button
            onClick={() => onGoToProjectRoot?.()}
            className={`flex items-center gap-1.5 pl-3 pr-2.5 py-3 -my-1.5 text-sm font-medium min-w-0 transition-opacity active:opacity-50 ${
              // Dimmed when not on the project root, matching how the breadcrumb
              // dims non-current levels; full strength at the root.
              atProjectRoot ? '' : 'text-white/40'
            }`}
            aria-label={`Go to ${activeProject.name} root`}
          >
            {/* No folder icon — its ~22px goes to the name instead. `truncate`
                stays as the backstop for a single word too long to fit; the
                word-boundary trimming above handles the multi-word case. */}
            <span ref={pillNameRef} className="truncate" title={activeProject.name}>{pillName}</span>
          </button>
          <div aria-hidden className="self-center" style={{ width: 1, height: 20, background: 'var(--border)' }} />
          <button
            onClick={() => { setDropdownOpen(o => !o); setCreatingProject(false); setRenamingId(null) }}
            className="flex items-center justify-center px-2.5 py-3 -my-1.5 flex-shrink-0 transition-opacity active:opacity-50"
            aria-label="Switch project"
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {dropdownOpen && (
          <div
            className="fixed inset-0 z-40"
            onClick={() => { setDropdownOpen(false); setCreatingProject(false); setRenamingId(null) }}
          />
        )}
        {dropdownOpen && (
          <div
            ref={projectMenuRef}
            // Centred under the pill (which is itself viewport-centred), not
            // left-anchored — that anchoring dated from the pill's old
            // left-aligned position. The clamp effect above nudges it inward
            // if it would overflow a screen edge.
            className="absolute top-full mt-1 w-64 rounded-xl shadow-xl z-50 py-1"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', left: '50%', transform: 'translateX(-50%)' }}
          >
            <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Projects</div>

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
                      className="flex-1 px-2 py-1 text-sm border border-indigo-600 rounded-md outline-none bg-gray-800 text-white"
                    />
                    <button onClick={() => handleRename(proj.id)}
                      className="text-xs px-2 py-1 bg-indigo-600 text-white rounded-md">OK</button>
                    <button onClick={() => setRenamingId(null)}
                      className="text-xs px-2 py-1 text-gray-500 hover:text-gray-300">✕</button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => { onSwitchProject(proj.id); setDropdownOpen(false) }}
                      className={`flex-1 text-left px-2 py-2 text-sm rounded-lg transition-colors ${
                        proj.id === activeProject.id
                          ? 'bg-indigo-950 text-indigo-300 font-medium'
                          : 'text-gray-300 hover:bg-gray-800'
                      }`}
                    >
                      {proj.name}
                    </button>
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => { setRenamingId(proj.id); setRenameValue(proj.name) }}
                        className="p-1 text-gray-600 hover:text-gray-400 rounded"
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

            <div className="mt-1 pt-1 px-2" style={{ borderTop: '1px solid var(--border)' }}>
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
                    className="flex-1 px-2 py-1 text-sm border border-indigo-600 rounded-md outline-none bg-gray-800 text-white"
                  />
                  <button onClick={handleCreateProject}
                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded-md">Create</button>
                </div>
              ) : (
                <button
                  onClick={() => setCreatingProject(true)}
                  className="w-full flex items-center gap-2 px-2 py-2 text-sm text-indigo-400 hover:bg-indigo-950 rounded-lg transition-colors"
                >
                  <span className="text-lg leading-none">+</span>
                  <span>New Project</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* In-context view controls (layout mode / select / view toggle) portal in
          here from the canvas — see the headerControlsEl plumbing in App. Empty in
          All Notes and on screens without a canvas. */}
      <div ref={controlsSlotRef} className="flex items-center flex-shrink-0 ml-1" />

      <div className="flex-1" />

      {/* Right: Settings + User */}
      <div className="flex items-center flex-shrink-0 gap-1">
        <button onClick={onOpenSettings} className="p-2 rounded-md text-gray-600 hover:bg-gray-800 transition-colors" aria-label="Settings">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {syncStatus === 'syncing' && (
          <svg className="w-4 h-4 text-indigo-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
          </svg>
        )}
        {syncStatus === 'synced' && (
          <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
          </svg>
        )}
        {syncStatus === 'error' && (
          <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          </svg>
        )}
        {/* Offline is a normal resting state, not a failure: changes are safe locally
            and will upload on reconnect, so it gets a muted cloud-off rather than red. */}
        {syncStatus === 'offline' && (
          <svg
            className="w-4 h-4"
            style={{ color: 'var(--text-muted)' }}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
            aria-label="Offline — changes saved on this device"
          >
            <title>Offline — changes saved on this device</title>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6.34 8.04A5 5 0 007 18h10a4 4 0 001.9-7.52M9.5 5.2A5.5 5.5 0 0117.6 9.3" />
          </svg>
        )}

        {user && (
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen(o => !o)}
              className="flex items-center justify-center w-8 h-8 rounded-full overflow-hidden border-2 border-gray-700 hover:border-indigo-500 transition-colors"
              aria-label="User menu"
            >
              {user.user_metadata?.avatar_url ? (
                <img src={user.user_metadata.avatar_url} alt="avatar" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-indigo-700 flex items-center justify-center text-white text-xs font-bold">
                  {(user.user_metadata?.full_name || user.email || '?')[0].toUpperCase()}
                </div>
              )}
            </button>

            {userMenuOpen && (
              <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
            )}
            {userMenuOpen && (
              <div
                className="absolute top-full right-0 mt-1 w-52 rounded-xl shadow-xl z-50 py-1"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
              >
                <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                  <div className="text-sm font-medium text-white truncate">
                    {user.user_metadata?.full_name || 'User'}
                  </div>
                  <div className="text-xs text-gray-500 truncate">{user.email}</div>
                </div>
                <button
                  onClick={() => { onSignOut?.(); setUserMenuOpen(false) }}
                  className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800 transition-colors"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      </div>{/* end inner relative row */}
    </nav>
  )
}
