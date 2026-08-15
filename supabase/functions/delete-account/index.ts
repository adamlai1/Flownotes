// Deletes the CALLING user's account. Deployed with JWT verification on (the
// default), and the user id is derived from the verified token — a request can
// only ever delete its own account; the request body is ignored entirely and
// never trusted.
//
// The service role key is read from the function's environment (Supabase
// injects SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY into every deployed
// function). It exists only server-side and never reaches the client bundle.
//
// Row cleanup: deleting the auth.users row cascades through the user_id
// foreign keys — projects, bubbles, notes, connections, and user_preferences
// are removed by ON DELETE CASCADE (normalized by
// supabase/delete_account_cascades.sql), and feedback is anonymized by its
// ON DELETE SET NULL. custom_tags was created outside the repo's SQL files,
// so its rows are deleted explicitly below rather than trusting an unverified
// cascade — and BEFORE the auth delete, so a failure aborts with the account
// fully intact and the call simply retried.

import { createClient } from 'npm:@supabase/supabase-js@2'

const ALLOWED_ORIGINS = new Set([
  'https://nubblenotes.com',
  'https://www.nubblenotes.com',
  'capacitor://localhost',
])

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://nubblenotes.com',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('Origin') ?? '')
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, headers)

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json(401, { error: 'Missing authorization' }, headers)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  // The ONLY source of the user id: the verified token. getUser validates the
  // JWT against the project's auth server.
  const { data, error: authError } = await admin.auth.getUser(jwt)
  const userId = data?.user?.id
  if (authError || !userId) return json(401, { error: 'Invalid token' }, headers)

  // custom_tags first (unverified cascade — see header). Failing here aborts
  // before anything irreversible happens.
  const { error: tagsError } = await admin.from('custom_tags').delete().eq('user_id', userId)
  if (tagsError) {
    console.error('delete-account: custom_tags delete failed', tagsError)
    return json(500, { error: 'Failed to delete account data' }, headers)
  }

  // Deleting the auth user cascades to the content tables in one transaction:
  // it either fully succeeds or errors (a NO ACTION foreign key would surface
  // as an FK violation here, never as silent orphans). Success is only
  // reported when this resolves cleanly — never on partial failure.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId)
  if (deleteError) {
    console.error('delete-account: auth delete failed', deleteError)
    return json(500, { error: 'Failed to delete account' }, headers)
  }

  return json(200, { ok: true }, headers)
})
