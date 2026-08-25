import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, useAnimationControls } from 'framer-motion'
import { useEscapeLayer, useEscapeInput, ESC_LEVEL } from '../lib/escapeStack'
import { useDismissOnOutside } from '../lib/dismiss'

// Multi-step password prompt used for every lock flow (create, verify, change,
// remove). Each step is one field; `validate` runs when a step is submitted and
// returns an error string to reject it (which shakes the input) or null to advance.
//
// Rendered through a portal so it always sits above the settings panel, the note
// editor stack, and the transformed bubble-view wrappers.

const STEPS_BY_MODE = {
  create: [
    { key: 'next', label: 'New password', placeholder: 'Enter a password' },
    { key: 'confirm', label: 'Confirm password', placeholder: 'Enter it again' },
  ],
  verify: [
    { key: 'current', label: 'Password', placeholder: 'Enter your password' },
  ],
  change: [
    { key: 'current', label: 'Current password', placeholder: 'Enter current password' },
    { key: 'next', label: 'New password', placeholder: 'Enter a new password' },
    { key: 'confirm', label: 'Confirm new password', placeholder: 'Enter it again' },
  ],
}

export default function PasswordModal({
  mode = 'verify',
  title,
  message,
  confirmLabel = 'Continue',
  destructive = false,
  onValidate,   // (stepKey, value, values) => error string | null
  onSubmit,     // (values) => void — all steps passed
  onClose,
}) {
  const steps = STEPS_BY_MODE[mode] ?? STEPS_BY_MODE.verify
  const [stepIndex, setStepIndex] = useState(0)
  const [value, setValue] = useState('')
  const [values, setValues] = useState({})
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const shake = useAnimationControls()

  const step = steps[stepIndex]
  const isLast = stepIndex === steps.length - 1

  // Escape dismisses the prompt. The password field is autofocused, so it gets an
  // explicit cancel — the default "blur first" would otherwise swallow the press.
  useEscapeLayer(true, onClose, ESC_LEVEL.password)
  useEscapeInput(inputRef, onClose)
  // Outside-press dismissal via the shared hook (Escape stays with the
  // registration above, which pairs with the input-cancel behaviour).
  const formRef = useRef(null)
  useDismissOnOutside(true, onClose, [formRef], { escLevel: false })

  useEffect(() => {
    // Focus on mount and whenever the step changes.
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [stepIndex])

  function reject(msg) {
    setError(msg)
    setValue('')
    shake.start({ x: [0, -9, 9, -7, 7, -4, 4, 0], transition: { duration: 0.4 } })
    navigator.vibrate?.([40, 60, 40])
    inputRef.current?.focus()
  }

  function handleSubmit(e) {
    e?.preventDefault()
    const entry = value
    if (!entry) return reject('Enter a password')
    const err = onValidate?.(step.key, entry, values)
    if (err) return reject(err)
    const nextValues = { ...values, [step.key]: entry }
    if (isLast) {
      onSubmit?.(nextValues)
      return
    }
    setValues(nextValues)
    setValue('')
    setError('')
    setStepIndex(i => i + 1)
  }

  return createPortal(
    <motion.div
      data-modal
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 flex items-center justify-center px-6"
      style={{ background: 'rgba(0,0,0,0.65)', zIndex: 200 }}
    >
      <motion.form
        ref={formRef}
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.94 }}
        transition={{ duration: 0.15 }}
        onSubmit={handleSubmit}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-xs rounded-2xl p-6"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
      >
        <div className="flex justify-center mb-3">
          <span
            className="w-11 h-11 rounded-full flex items-center justify-center"
            style={{ background: destructive ? 'rgba(220,38,38,0.15)' : 'rgba(99,102,241,0.15)' }}
          >
            <svg
              className="w-5 h-5"
              style={{ color: destructive ? '#f87171' : '#818cf8' }}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </span>
        </div>

        <h2 className="font-semibold text-lg text-center mb-1" style={{ color: 'var(--text)' }}>
          {title}
        </h2>
        {message && (
          <p className="text-sm text-center mb-4" style={{ color: 'var(--text-muted)' }}>
            {message}
          </p>
        )}

        <motion.div animate={shake} className="mb-1">
          <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5 px-1"
            style={{ color: 'var(--text-muted)' }}>
            {step.label}
          </label>
          <input
            ref={inputRef}
            type="password"
            value={value}
            onChange={e => { setValue(e.target.value); if (error) setError('') }}
            placeholder={step.placeholder}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full px-3 py-2.5 rounded-xl text-sm outline-none"
            style={{
              background: 'var(--input-bg)',
              border: `1px solid ${error ? '#dc2626' : 'var(--input-border)'}`,
              color: 'var(--text)',
              userSelect: 'text',
              WebkitUserSelect: 'text',
            }}
          />
        </motion.div>

        <p className="text-xs mb-4 px-1 min-h-[16px]" style={{ color: '#f87171' }}>
          {error}
        </p>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
            style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white transition-colors"
            style={{ background: destructive ? '#dc2626' : '#6366f1' }}
          >
            {isLast ? confirmLabel : 'Continue'}
          </button>
        </div>

        {steps.length > 1 && (
          <div className="flex justify-center gap-1.5 mt-4">
            {steps.map((s, i) => (
              <span
                key={s.key}
                style={{
                  width: i === stepIndex ? 16 : 6, height: 6, borderRadius: 3,
                  background: i === stepIndex ? '#6366f1' : 'var(--border)',
                  transition: 'width 0.2s, background 0.2s',
                }}
              />
            ))}
          </div>
        )}
      </motion.form>
    </motion.div>,
    document.body
  )
}
