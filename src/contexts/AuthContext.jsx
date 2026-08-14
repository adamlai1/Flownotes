import { createContext, useContext, useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { supabase } from '../lib/supabase'
import { AUTH_CALLBACK_URL } from '../lib/nativeAuth'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [guestMode, setGuestMode] = useState(() => !!localStorage.getItem('guestMode'))

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        // Clear guest mode when signing in
        localStorage.removeItem('guestMode')
        setGuestMode(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function signInWithGoogle() {
    if (Capacitor.isNativePlatform()) {
      // The session comes back through the appUrlOpen listener in nativeAuth.js,
      // not a page redirect — so ask Supabase for the URL and open it ourselves.
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
      })
      if (error) throw error
      await Browser.open({ url: data.url })
      return { data, error }
    }
    return supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
  }

  function signOut() {
    return supabase.auth.signOut()
  }

  function continueAsGuest() {
    localStorage.setItem('guestMode', '1')
    setGuestMode(true)
  }

  return (
    <AuthContext.Provider value={{ user, loading, guestMode, signInWithGoogle, signOut, continueAsGuest }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
