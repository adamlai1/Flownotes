import { createContext, useContext, useState, useEffect } from 'react'

const THEME_COLORS = { dark: '#1C1C1E', light: '#F2F2F7' }

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  const meta = document.getElementById('theme-color-dynamic')
  if (meta) meta.setAttribute('content', THEME_COLORS[theme])
}

const ThemeContext = createContext({ theme: 'dark', toggleTheme: () => {} })

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
