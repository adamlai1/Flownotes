import { createContext, useContext, useState, useEffect } from 'react'

const ThemeContext = createContext({ theme: 'dark', toggleTheme: () => {} })

// The browser paints the status-bar region with theme-color, and the header is what
// sits under it — so this must track the header's rendered background exactly:
// bg-gray-900 (#111827) in dark, var(--card) (#FAFAF7) in light. The page background
// (#1C1C1E) is deliberately NOT used here; it made the status bar visibly seam against
// the navy nav.
const THEME_COLOR = { dark: '#111827', light: '#FAFAF7' }

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLOR[theme] ?? THEME_COLOR.dark)
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('mindmap-theme') || 'dark'
    applyTheme(saved)
    return saved
  })

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('mindmap-theme', next)
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
