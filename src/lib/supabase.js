import { createClient } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'

const supabaseUrl = 'https://qkgwudhlwxkvalqaoetl.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ3d1ZGhsd3hrdmFscWFvZXRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMTk2NDIsImV4cCI6MjA5NDc5NTY0Mn0.Ae6SL2hBYNPjWZFfixQcGBMEMOUUvbz8ULmvmCUsZPs'

// Native builds sign in over a custom-scheme redirect, so the session can't be read
// from the page URL — it arrives via appUrlOpen (see nativeAuth.js) and PKCE is
// required for exchangeCodeForSession. The web client stays exactly as before.
export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey,
  Capacitor.isNativePlatform()
    ? { auth: { flowType: 'pkce', detectSessionInUrl: false } }
    : undefined,
)
