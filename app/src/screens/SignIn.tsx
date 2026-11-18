/**
 * app/src/screens/SignIn.tsx
 *
 * Log in screen, shown after the welcome screen (and from the Log in button
 * on the home screen). "Continue with Google" signs in through Supabase
 * Auth; the account fills the booking form and brings the guest's trips to
 * any phone. "Continue as guest" still lets people book without an account.
 */
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { authConfigured, signIn } from '../auth';
import { HERO_PHOTOS } from '../scene';
import { colors, radius, space, themed } from '../theme';
import { ErrorBox, Ionicons } from '../ui';

export function SignIn({ onGuest }: { onGuest: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opens Google's sign-in; when it returns, App.tsx sees the account and
  // moves on by itself.
  async function google() {
    setBusy(true);
    setError(null);
    try {
      await signIn('google');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={st.screen}>
      {/* Photo on top, card below */}
      <Image source={HERO_PHOTOS.home} style={st.photo} resizeMode="cover" />
      <View style={st.shade} />
      <View style={st.card}>
        <Image source={require('../../assets/resortify-logo.png')} style={st.logo} />
        <Text style={st.title}>Log in to Resortify</Text>
        <Text style={st.lead}>Keep your island trips together, book faster, and see your bookings on any phone.</Text>

        {/* Google */}
        <Pressable onPress={google} disabled={busy || !authConfigured} style={({ pressed }) => [st.google, (pressed || busy) && { opacity: 0.8 }, !authConfigured && { opacity: 0.5 }]}>
          <Ionicons name="logo-google" size={20} color="#013C58" />
          <Text style={st.googleText}>{busy ? 'Opening Google…' : 'Continue with Google'}</Text>
        </Pressable>
        {!authConfigured && <ErrorBox tone="notice" message="Google sign-in isn't set up in this build yet." />}
        <ErrorBox message={error} />

        {/* Guest */}
        <Pressable onPress={onGuest} hitSlop={8} style={st.guest}>
          <Text style={st.guestText}>Continue as guest</Text>
        </Pressable>
        <Text style={st.fine}>You can log in later from the home screen.</Text>
      </View>
    </View>
  );
}

// Styles for this screen.
const st = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, justifyContent: 'flex-end' },
  photo: { position: 'absolute', top: 0, left: 0, right: 0, height: '55%', width: '100%' },
  shade: { position: 'absolute', top: 0, left: 0, right: 0, height: '55%', backgroundColor: 'rgba(1, 60, 88, 0.25)' },
  card: { backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, paddingBottom: 44, gap: space.md, alignItems: 'stretch' },
  logo: { width: 76, height: 76, borderRadius: 38, alignSelf: 'center', marginTop: -62, borderWidth: 4, borderColor: colors.card },
  title: { color: colors.ink, fontSize: 24, fontWeight: '800', textAlign: 'center' },
  lead: { color: colors.muted, textAlign: 'center', lineHeight: 21 },
  google: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#fff',
    borderRadius: radius.pill, paddingVertical: 15, borderWidth: 1.5, borderColor: colors.line },
  googleText: { color: '#013C58', fontWeight: '800', fontSize: 16 },
  guest: { alignSelf: 'center', paddingVertical: 6 },
  guestText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
  fine: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: -8 },
}));
