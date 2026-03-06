import { motion } from 'framer-motion'
import { useTheme } from '../contexts/ThemeContext'

export default function Settings({ onClose, zIndex = 50 }) {
  const { theme, toggleTheme } = useTheme()
  const isLight = theme === 'light'

  return (
    <motion.div
      data-modal
      className="fixed inset-0 flex flex-col"
      style={{ zIndex, background: 'var(--surface)', color: 'var(--text)' }}
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'tween', duration: 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      {/* Header */}
      <div
        className="flex-shrink-0 relative flex items-center px-3"
        style={{
          paddingTop: 'max(12px, env(safe-area-inset-top))',
          paddingBottom: 10,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <button
          onClick={onClose}
          className="flex items-center gap-0.5 font-medium text-[15px] py-1 -ml-1 flex-shrink-0 z-10 text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          <span>Back</span>
        </button>
        <span
          className="absolute inset-x-0 text-center text-[15px] font-semibold pointer-events-none"
          style={{ color: 'var(--text)' }}
        >
          Settings
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-4 pt-8 pb-12 space-y-8">

          {/* Appearance section */}
          <div>
            <p
              className="text-[11px] font-semibold uppercase tracking-wider mb-3 px-1"
              style={{ color: 'var(--text-muted)' }}
            >
              Appearance
            </p>
            <div
              className="rounded-2xl overflow-hidden"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center justify-between px-4 py-3.5">
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                    Light Mode
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {isLight ? 'Light' : 'Dark'} appearance
                  </p>
                </div>
                <button
                  onClick={toggleTheme}
                  className="relative flex-shrink-0 focus:outline-none"
                  style={{
                    width: 50,
                    height: 30,
                    borderRadius: 15,
                    background: isLight ? '#34C759' : 'rgba(255,255,255,0.18)',
                    border: isLight ? 'none' : '1px solid rgba(255,255,255,0.12)',
                    transition: 'background 0.2s ease',
                  }}
                  aria-label="Toggle light mode"
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 3,
                      left: isLight ? 23 : 3,
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: '#fff',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
                      transition: 'left 0.2s ease',
                    }}
                  />
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </motion.div>
  )
}
