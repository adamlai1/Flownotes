import { createContext, useContext, useState, useEffect } from 'react'

const ThemeContext = createContext({ theme: 'dark', toggleTheme: () => {} })

// The browser paints the status-bar region with theme-color, and the header is what
// sits under it — so this must track the header's rendered background exactly. The
// header bar is now containerless on the pure-black ground, so dark is #000000
// (was navy #111827, which left a visible navy strip above the black header).
// Light keeps the light surface. Also mirrored in index.html's meta (initial
// paint before this runs) and public/manifest.json's theme_color.
const THEME_COLOR = { dark: '#000000', light: '#FAFAF7' }

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
