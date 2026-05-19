import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://qkgwudhlwxkvalqaoetl.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ3d1ZGhsd3hrdmFscWFvZXRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMTk2NDIsImV4cCI6MjA5NDc5NTY0Mn0.Ae6SL2hBYNPjWZFfixQcGBMEMOUUvbz8ULmvmCUsZPs'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
