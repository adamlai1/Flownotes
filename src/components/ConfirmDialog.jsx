import { motion, AnimatePresence } from 'framer-motion'
import { useEscapeLayer, ESC_LEVEL } from '../lib/escapeStack'

// Small centered confirm modal. Rendered at the top of the tree by whoever needs it;
// `open` drives the enter/exit animation. onConfirm/onCancel are always provided.
export default function ConfirmDialog({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}) {
  // Escape cancels the dialog and nothing else — it outranks the view underneath.
  useEscapeLayer(open, onCancel, ESC_LEVEL.modal)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-modal
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 70, background: 'rgba(0,0,0,0.6)' }}
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.15 }}
            className="mx-6 w-full max-w-xs rounded-2xl p-6"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-white font-semibold text-lg text-center mb-1">{title}</h2>
            {message && <p className="text-gray-400 text-sm text-center mb-5">{message}</p>}
            <div className="flex gap-3">
              <button
                onClick={onCancel}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
                style={{ background: 'var(--hover)', color: 'var(--text-2)' }}
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
