/**
 * app/src/auth.ts
 *
 * Guest accounts with Google sign-in, through Supabase Auth (browser flow):
 *   1. ask Supabase for Google's sign-in URL (skipBrowserRedirect),
 *   2. open it in an in-app browser session,
 *   3. Google -> Supabase -> back to this app's redirect URL with the tokens,
 *   4. store the session on the phone (AsyncStorage) and keep it refreshed.
 * The account's e-mail links the guest to their bookings (central's
 * GET /api/me/bookings checks the token with Supabase).
 *
 * Setup needed once (see docs/TEAM-SETUP.md): a Google OAuth client in
 * Google Cloud, pasted into Supabase > Authentication > Providers > Google,
 * and this app's redirect URL in Supabase > Authentication > URL Configuration.
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type Session } from '@supabase/supabase-js';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';

// Lets the browser session hand control back to the app on the web build.
WebBrowser.maybeCompleteAuthSession();

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

// True when the app was built with Supabase settings (sign-in available).
export const authConfigured = Boolean(URL && KEY);

// One Supabase client for the app, used only for sign-in (bookings go
// through central). The session is kept on the phone and refreshed.
export const supabase = createClient(URL || 'https://example.invalid', KEY || 'missing', {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

// Where Google/Supabase send the guest back: exp://… in Expo Go,
// biliranbooking://… in the installed app. Must be allowed in Supabase.
export const redirectTo = makeRedirectUri({ scheme: 'biliranbooking' });

// Reads "#access_token=…&refresh_token=…" (or "?code=…") from the return URL.
function paramsOf(url: string) {
  const out: Record<string, string> = {};
  const parts = url.split(/[?#]/).slice(1).join('&');
  for (const pair of parts.split('&')) {
    const [k, v] = pair.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
  }
  return out;
}

// Signs in with Google (or another provider enabled in Supabase). Resolves
// when signed in; resolves quietly if the guest closed the browser.
export async function signIn(provider: 'google' | 'facebook' = 'google') {
  if (!authConfigured) throw new Error('Sign-in is not set up in this build of the app.');
  const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } });
  if (error) throw error;
  const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (res.type !== 'success') return;
  const p = paramsOf(res.url);
  if (p.error_description || p.error) throw new Error(p.error_description || p.error);
  if (p.code) {
    const { error: e } = await supabase.auth.exchangeCodeForSession(p.code);
    if (e) throw e;
  } else if (p.access_token) {
    const { error: e } = await supabase.auth.setSession({ access_token: p.access_token, refresh_token: p.refresh_token });
    if (e) throw e;
  }
}

export const signOut = () => supabase.auth.signOut();

// The signed-in guest as a React hook: null while signed out.
export function useAccount() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    if (!authConfigured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  const user = session?.user;
  return user ? {
    token: session!.access_token,
    email: user.email ?? '',
    name: (user.user_metadata?.full_name as string) ?? (user.user_metadata?.name as string) ?? user.email ?? 'Guest',
    avatar: (user.user_metadata?.avatar_url as string) ?? null,
  } : null;
}
export type Account = NonNullable<ReturnType<typeof useAccount>>;
