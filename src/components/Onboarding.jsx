import { motion } from 'framer-motion'

const TIPS = [
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" strokeWidth={2} />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3" />
      </svg>
    ),
    text: 'Tap a bubble to dive in',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M7 11V7a5 5 0 0110 0v4M5 11h14l-1 9H6L5 11z" />
      </svg>
    ),
    text: 'Hold and drag to rearrange',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    ),
    text: 'Tap + to create a note',
  },
]

export default function Onboarding({ onDismiss }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 flex flex-col items-center justify-center px-8"
      style={{ background: '#000', zIndex: 200 }}
    >
      {/* Logo mark */}
      <motion.div
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1, duration: 0.35 }}
        className="mb-6 flex items-center justify-center w-16 h-16 rounded-2xl"
        style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
      >
        <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="3" strokeWidth={2} />
          <circle cx="4.5" cy="6" r="2" strokeWidth={2} />
          <circle cx="19.5" cy="6" r="2" strokeWidth={2} />
          <circle cx="4.5" cy="18" r="2" strokeWidth={2} />
          <circle cx="19.5" cy="18" r="2" strokeWidth={2} />
          <line x1="9.5" y1="10.5" x2="6" y2="7.5" strokeWidth={1.5} />
          <line x1="14.5" y1="10.5" x2="18" y2="7.5" strokeWidth={1.5} />
          <line x1="9.5" y1="13.5" x2="6" y2="16.5" strokeWidth={1.5} />
          <line x1="14.5" y1="13.5" x2="18" y2="16.5" strokeWidth={1.5} />
        </svg>
      </motion.div>

      {/* Name + tagline */}
      <motion.div
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.18, duration: 0.35 }}
        className="text-center mb-10"
      >
        <h1 className="text-3xl font-bold text-white mb-2">FlowNotes</h1>
        <p className="text-gray-400 text-[15px] leading-snug">
          A mind-mapping notes app.<br />Organize your thoughts in bubbles.
        </p>
      </motion.div>

      {/* Tips */}
      <motion.div
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.26, duration: 0.35 }}
        className="w-full max-w-xs space-y-3 mb-10"
      >
        {TIPS.map((tip, i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-4 py-3 rounded-xl"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <span className="text-indigo-400 flex-shrink-0">{tip.icon}</span>
            <span className="text-gray-200 text-[14px]">{tip.text}</span>
          </div>
        ))}
      </motion.div>

      {/* CTA */}
      <motion.button
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.34, duration: 0.35 }}
        onClick={onDismiss}
        className="w-full max-w-xs py-3.5 rounded-2xl text-white font-semibold text-[16px] transition-opacity active:opacity-80"
        style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
      >
        Get Started
      </motion.button>
    </motion.div>
  )
}
