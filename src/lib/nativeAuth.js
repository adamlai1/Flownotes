import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { supabase } from './supabase'

export const AUTH_CALLBACK_URL = 'com.adamlai.flownotes://auth/callback'

// Errors are dispatched as a window event so they reach the global ErrorOverlay in
// main.jsx — this module runs outside React and may fire before any screen mounts.
export const AUTH_ERROR_EVENT = 'flownotes-native-auth-error'

function reportAuthError(message) {
  window.dispatchEvent(new CustomEvent(AUTH_ERROR_EVENT, { detail: message }))
}

async function handleAuthCallback(url) {
  if (typeof url !== 'string' || !url.startsWith(AUTH_CALLBACK_URL)) return

  try {
    const parsed = new URL(url)
    const code = parsed.searchParams.get('code')
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''))
    const accessToken = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code)
      if (error) throw error
    } else if (accessToken && refreshToken) {
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
      if (error) throw error
    } else {
      const providerError =
        parsed.searchParams.get('error_description') ||
        hashParams.get('error_description') ||
        parsed.searchParams.get('error') ||
        hashParams.get('error')
      throw new Error(providerError || 'Sign-in callback contained no credentials')
    }
  } catch (e) {
    reportAuthError(`Sign-in failed: ${e?.message || e}`)
  } finally {
    // Dismiss the in-app browser either way — on failure the error is shown in the
    // app, and leaving the browser sheet up would hide it.
    try { await Browser.close() } catch { /* already closed */ }
  }
}

// Called once at module-load time from main.jsx, before React mounts, so the listener
// exists no matter when iOS delivers the callback URL.
export function initNativeAuth() {
  if (!Capacitor.isNativePlatform()) return

  App.addListener('appUrlOpen', ({ url }) => { handleAuthCallback(url) })

  // If iOS relaunched the app cold via the callback URL, appUrlOpen may not fire —
  // the URL is only available as the launch URL.
  App.getLaunchUrl()
    .then(result => { if (result?.url) handleAuthCallback(result.url) })
    .catch(() => {})
}
