/**
 * app/src/screens/Profile.tsx
 *
 * Account tab. Signed out: create an account / sign in with Google (through
 * Supabase Auth), or keep booking as a guest. Signed in: name, e-mail, and
 * sign out. The account's e-mail fills the booking form and brings the
 * guest's trips to any phone. Facebook sign-in shows once it is enabled in
 * Supabase (EXPO_PUBLIC_FACEBOOK_LOGIN=1). Also the way into Settings.
 */
import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { redirectTo, signIn, signOut, useGoogleEnabled, type Account } from '../auth';
import { colors, radius, shadow, space, themed } from '../theme';
import { Button, ErrorBox, Ionicons } from '../ui';

const FACEBOOK = process.env.EXPO_PUBLIC_FACEBOOK_LOGIN === '1';

export function Profile({ account, onSettings }: { account: Account | null; onSettings: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Google sign-in switched on in Supabase?
  const google = useGoogleEnabled();

  // Opens the provider's sign-in page; the account appears when it returns.
  async function go(provider: 'google' | 'facebook') {
    setBusy(provider);
    setError(null);
    try {
      await signIn(provider);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView style={st.screen} contentContainerStyle={st.body}>
      <Text style={st.title}>Account</Text>

      {account ? (
        // Signed in: who, and sign out.
        <View style={st.card}>
          {account.avatar
            ? <Image source={{ uri: account.avatar }} style={st.avatar} />
            : <View style={[st.avatar, st.avatarEmpty]}><Text style={st.initial}>{account.name.slice(0, 1).toUpperCase()}</Text></View>}
          <Text style={st.name}>{account.name}</Text>
          <Text style={st.email}>{account.email}</Text>
          <View style={st.perks}>
            <Perk icon="ticket-outline" text="Your trips on any phone" />
            <Perk icon="create-outline" text="Name and e-mail filled in when booking" />
          </View>
          <Button label="Sign out" variant="ghost" onPress={() => signOut()} icon="log-out-outline" />
        </View>
      ) : (
        // Signed out: create an account with Google (or Facebook when enabled).
        <View style={st.card}>
          <View style={st.badge}><Ionicons name="person-circle-outline" size={44} color={colors.primary} /></View>
          <Text style={st.name}>Create your account</Text>
          <Text style={st.lead}>Sign in once to keep all your island trips together and book faster. Or keep booking as a guest; it works without an account.</Text>
          <Button label="Continue with Google" onPress={() => go('google')} busy={busy === 'google'} icon="logo-google" disabled={!google} />
          {FACEBOOK && <Button label="Continue with Facebook" variant="ghost" onPress={() => go('facebook')} busy={busy === 'facebook'} icon="logo-facebook" />}
          {/* Google is switched off in Supabase (or this build has no Supabase settings) */}
          {!google && <ErrorBox tone="notice" message="Google sign-in is coming soon. You can already book as a guest; your trips are kept on this phone." />}
          <ErrorBox message={error} />
        </View>
      )}

      {/* Settings: profile, privacy, notifications, preferences, payment */}
      <Pressable onPress={onSettings} style={({ pressed }) => [st.card, st.settingsRow, pressed && { opacity: 0.7 }]}>
        <View style={st.settingsIcon}><Ionicons name="settings-outline" size={22} color="#fff" /></View>
        <View style={{ flex: 1 }}>
          <Text style={st.sectionTitle}>Settings</Text>
          <Text style={st.settingsSub}>Profile, privacy, reminders, theme, payment</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.muted} />
      </Pressable>

      {/* For the team while setting up Google sign-in */}
      <Text style={st.dev}>Sign-in return address: {redirectTo}</Text>
    </ScrollView>
  );
}

// Small icon + text line.
function Perk({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={st.perk}><Ionicons name={icon} size={18} color={colors.primary} /><Text style={st.perkText}>{text}</Text></View>
  );
}

// Styles for this screen.
const st = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.md, paddingTop: 60, gap: space.md, paddingBottom: 120 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '800' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space.lg, gap: space.md, alignItems: 'stretch', ...shadow, shadowOpacity: 0.07 },
  badge: { alignSelf: 'center', width: 76, height: 76, borderRadius: 38, backgroundColor: colors.skySoft, alignItems: 'center', justifyContent: 'center' },
  avatar: { alignSelf: 'center', width: 84, height: 84, borderRadius: 42 },
  avatarEmpty: { backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  initial: { color: '#fff', fontSize: 34, fontWeight: '800' },
  name: { color: colors.ink, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  email: { color: colors.muted, textAlign: 'center', marginTop: -8 },
  lead: { color: colors.muted, textAlign: 'center', lineHeight: 21 },
  perks: { gap: 8, backgroundColor: colors.skySoft, borderRadius: radius.sm, padding: space.md },
  perk: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  perkText: { color: colors.ink },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  settingsRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  settingsIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  settingsSub: { color: colors.muted, fontSize: 13, marginTop: 2 },
  dev: { color: colors.muted, fontSize: 11, textAlign: 'center' },
}));
