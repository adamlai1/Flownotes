import { StrictMode, Component, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// ── Global error overlay ──────────────────────────────────────────────────────

function ErrorOverlay() {
  const [errors, setErrors] = useState([])

  useEffect(() => {
    function push(msg) {
      setErrors(prev => [...prev, { id: Date.now() + Math.random(), msg }])
    }

    function onError(event) {
      push(event.message + (event.filename ? `\n${event.filename}:${event.lineno}` : ''))
    }

    function onUnhandledRejection(event) {
      const reason = event.reason
      push(reason instanceof Error ? reason.message + '\n' + reason.stack : String(reason))
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [])

  if (errors.length === 0) return null

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
      display: 'flex', flexDirection: 'column', gap: 4, padding: 8, pointerEvents: 'none',
    }}>
      {errors.map(e => (
        <div key={e.id} style={{
          background: '#7f1d1d', color: '#fecaca', fontFamily: 'monospace',
          fontSize: 13, padding: '8px 12px', borderRadius: 6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)', pointerEvents: 'auto',
          display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <span style={{ flex: 1 }}>⚠ {e.msg}</span>
          <button
            onClick={() => setErrors(prev => prev.filter(x => x.id !== e.id))}
            style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
          >✕</button>
        </div>
      ))}
    </div>
  )
}

// ── React error boundary ──────────────────────────────────────────────────────

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 24, fontFamily: 'monospace', background: '#7f1d1d',
          color: '#fecaca', minHeight: '100vh', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          <strong style={{ fontSize: 16 }}>⚠ React Error</strong>
          {'\n\n'}
          {this.state.error.message}
          {'\n\n'}
          {this.state.error.stack}
          {'\n\n'}
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              background: '#fecaca', color: '#7f1d1d', border: 'none',
              padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold',
            }}
          >Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Mount ─────────────────────────────────────────────────────────────────────

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <ErrorOverlay />
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
