/**
 * app/App.tsx
 *
 * Guest app root. Simple state-based navigation (no router library):
 *
 *   Welcome (first launch only)
 *      │ get started
 *   Log in (Google, or continue as guest; skipped when already signed in)
 *      │
 *   Explore ──tap──▶ PackageDetail ──book now──▶ GuestForm ──reserve (HOLD)──▶ Payment ──pay──▶ Confirmation
 *                    (Package or Build your own: arrival day, guests, extra
 *                     hours or the island's services checklist)
 *
 *   My trips (tab)  : list + calendar timeline ──tap──▶ Confirmation
 *   Account (tab)   : Google sign-in ──▶ Settings (profile, privacy,
 *                     notifications, preferences, payment)
 *
 * The bottom tab bar switches between Explore, My trips and Account; it is
 * hidden while booking. The theme (day, night or follow the phone) comes
 * from Settings and is also switched with the moon button on Explore.
 */
import { useEffect, useState } from 'react';
import { Appearance, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Booking, Package, Trip } from './src/api';
import { googleEnabled, hasSavedSession, useAccount, useGoogleEnabled } from './src/auth';
import { saveBooking } from './src/storage';
import { loadSettings, syncWithAccount, updateSettings, useSettings, type ThemeChoice } from './src/settings';
import { remindTrip } from './src/reminders';
import { applyTheme, colors, shadow, themed, type ThemeMode } from './src/theme';
import { Ionicons } from './src/ui';
import { Welcome } from './src/screens/Welcome';
import { SignIn } from './src/screens/SignIn';
import { Explore } from './src/screens/Explore';
import { PackageDetail } from './src/screens/PackageDetail';
import { GuestForm } from './src/screens/GuestForm';
import { Payment } from './src/screens/Payment';
import { Confirmation } from './src/screens/Confirmation';
import { MyBookings } from './src/screens/MyBookings';
import { Profile } from './src/screens/Profile';
import { Settings } from './src/screens/Settings';

// Which screen is showing, with the data it needs.
type Tab = 'explore' | 'mine' | 'account';
type Route =
  | { name: 'loading' }
  | { name: 'welcome' }
  | { name: 'signin' }
  | { name: 'settings' }
  | { name: Tab }
  | { name: 'package'; pkg: Package }
  | { name: 'form'; trip: Trip; back: Route }
  | { name: 'pay'; booking: Booking }
  | { name: 'confirmed'; booking: Booking; justPaid: boolean; from: Tab };

// Remembers on this phone: welcome seen, "continue as guest" chosen.
const WELCOME_KEY = 'seen-welcome';
const GUEST_KEY = 'continue-as-guest';

// The palette to use for a theme choice ("system" follows the phone).
const effectiveTheme = (choice: ThemeChoice, phone: string | null | undefined): ThemeMode =>
  choice === 'system' ? (phone === 'dark' ? 'dark' : 'light') : choice;

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'loading' });
  // Signed-in guest (Google), or null.
  const account = useAccount();
  // Whether Google sign-in is switched on in Supabase.
  const google = useGoogleEnabled();
  // Settings, and the day/night palette they ask for.
  const settings = useSettings();
  const phoneScheme = useColorScheme();
  const [theme, setTheme] = useState<ThemeMode>('light');
  const wanted = effectiveTheme(settings.theme, phoneScheme);
  useEffect(() => {
    if (wanted !== theme) { applyTheme(wanted); setTheme(wanted); }
  }, [wanted, theme]);

  // Signed in: settings follow the account (newest copy wins).
  useEffect(() => {
    if (account) void syncWithAccount(account.metadata);
  }, [account?.email]);

  // First launch → welcome screen → Log in. Later launches: Log in again
  // unless already signed in or "continue as guest" was chosen.
  // Also applies the saved day/night choice before the first screen shows.
  useEffect(() => {
    // The Log in screen is skipped while Google sign-in is off in Supabase.
    Promise.all([AsyncStorage.multiGet([WELCOME_KEY, GUEST_KEY]), hasSavedSession(), googleEnabled(), loadSettings()])
      .then(([[[, seen], [, guest]], signedIn, google, saved]) => {
        const mode = effectiveTheme(saved.theme, Appearance.getColorScheme());
        if (mode === 'dark') { applyTheme('dark'); setTheme('dark'); }
        setRoute(!seen ? { name: 'welcome' } : signedIn || guest || !google ? { name: 'explore' } : { name: 'signin' });
      })
      .catch(() => setRoute({ name: 'welcome' }));
  }, []);

  // Signing in from the Log in screen moves on to Explore by itself.
  useEffect(() => {
    if (account && route.name === 'signin') setRoute({ name: 'explore' });
  }, [account, route.name]);

  // The moon button: switches day / night (saved in Settings).
  const toggleTheme = () => updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' });

  // Picks the screen for the current route.
  let screen;
  switch (route.name) {
    case 'loading':
      screen = <View style={{ flex: 1, backgroundColor: colors.onLight }} />;
      break;
    case 'welcome':
      screen = (
        <Welcome onStart={() => {
          AsyncStorage.setItem(WELCOME_KEY, '1').catch(() => {});
          setRoute(account || !google ? { name: 'explore' } : { name: 'signin' });
        }} />
      );
      break;
    case 'signin':
      screen = (
        <SignIn onGuest={() => {
          AsyncStorage.setItem(GUEST_KEY, '1').catch(() => {});
          setRoute({ name: 'explore' });
        }} />
      );
      break;
    case 'explore':
      screen = (
        <Explore onOpen={(pkg) => setRoute({ name: 'package', pkg })} theme={theme} onToggleTheme={toggleTheme}
          account={account} onLogin={google ? () => setRoute({ name: 'signin' }) : undefined} />
      );
      break;
    case 'package':
      screen = <PackageDetail pkg={route.pkg} onBack={() => setRoute({ name: 'explore' })} onBook={(trip) => setRoute({ name: 'form', trip, back: route })} />;
      break;
    case 'form':
      screen = (
        <GuestForm
          trip={route.trip}
          account={account}
          onBack={() => setRoute(route.back)}
          // Save the reference as soon as it exists, so the guest can find it
          // again even if the app closes during payment.
          onHeld={(booking) => {
            saveBooking({ reference: booking.reference, email: booking.email });
            setRoute({ name: 'pay', booking });
          }}
        />
      );
      break;
    case 'pay':
      screen = (
        <Payment
          booking={route.booking}
          onPaid={(booking) => {
            void remindTrip(booking); // trip reminder, if switched on in Settings
            setRoute({ name: 'confirmed', booking, justPaid: true, from: 'explore' });
          }}
          onCancel={() => setRoute({ name: 'explore' })}
        />
      );
      break;
    case 'confirmed':
      screen = <Confirmation booking={route.booking} justPaid={route.justPaid} onDone={() => setRoute({ name: route.from })} />;
      break;
    case 'mine':
      screen = <MyBookings account={account} onSignIn={() => setRoute({ name: 'account' })} onOpen={(booking) => setRoute({ name: 'confirmed', booking, justPaid: false, from: 'mine' })} />;
      break;
    case 'account':
      screen = <Profile account={account} onSettings={() => setRoute({ name: 'settings' })} />;
      break;
    case 'settings':
      screen = <Settings account={account} onBack={() => setRoute({ name: 'account' })} />;
      break;
  }

  // The tab bar only shows on the three top-level screens.
  const tab = route.name === 'explore' || route.name === 'mine' || route.name === 'account' ? route.name : null;

  return (
    <View style={st.root}>
      <StatusBar style={route.name === 'welcome' || route.name === 'loading' || route.name === 'signin' || theme === 'dark' ? 'light' : 'dark'} />
      {screen}
      {tab && (
        <View style={st.tabs}>
          <TabButton icon="compass" label="Explore" active={tab === 'explore'} onPress={() => setRoute({ name: 'explore' })} />
          <TabButton icon="ticket" label="My trips" active={tab === 'mine'} onPress={() => setRoute({ name: 'mine' })} />
          <TabButton icon="person" label="Account" active={tab === 'account'} onPress={() => setRoute({ name: 'account' })} />
        </View>
      )}
    </View>
  );
}

// One button in the bottom tab bar (filled icon + label when active).
function TabButton({ icon, label, active, onPress }: { icon: 'compass' | 'ticket' | 'person'; label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={st.tab} hitSlop={6}>
      <View style={[st.tabPill, active && st.tabPillOn]}>
        <Ionicons name={active ? icon : `${icon}-outline`} size={22} color={active ? '#fff' : colors.muted} />
        {active && <Text style={st.tabText}>{label}</Text>}
      </View>
    </Pressable>
  );
}

// Styles for the root and tab bar.
const st = themed(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tabs: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', backgroundColor: colors.card,
    paddingTop: 10, paddingBottom: 26, borderTopLeftRadius: 24, borderTopRightRadius: 24, ...shadow,
  },
  tab: { flex: 1, alignItems: 'center' },
  tabPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999 },
  tabPillOn: { backgroundColor: colors.primary },
  tabText: { color: '#fff', fontWeight: '700' },
}));
