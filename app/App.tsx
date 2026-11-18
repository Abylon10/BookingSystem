/**
 * app/App.tsx
 *
 * Guest app root. Simple state-based navigation (no router library):
 *
 *   Welcome (first launch only)
 *      │ get started
 *   Explore ──tap──▶ PackageDetail ──book now──▶ GuestForm ──reserve (HOLD)──▶ Payment ──pay──▶ Confirmation
 *                    (Package or Build your own: guests, dates, extra days
 *                     or the island's services checklist)
 *
 *   My trips (tab)  : list + calendar timeline ──tap──▶ Confirmation
 *   Account (tab)   : Google sign-in
 *
 * The bottom tab bar switches between Explore, My trips and Account; it is
 * hidden while booking. Day / night is switched on Explore or Account and
 * saved on the phone.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Booking, Package, Trip } from './src/api';
import { useAccount } from './src/auth';
import { saveBooking } from './src/storage';
import { applyTheme, colors, shadow, themed, type ThemeMode } from './src/theme';
import { Ionicons, isoDay } from './src/ui';
import { Welcome } from './src/screens/Welcome';
import { Explore } from './src/screens/Explore';
import { PackageDetail } from './src/screens/PackageDetail';
import { GuestForm } from './src/screens/GuestForm';
import { Payment } from './src/screens/Payment';
import { Confirmation } from './src/screens/Confirmation';
import { MyBookings } from './src/screens/MyBookings';
import { Profile } from './src/screens/Profile';

// Which screen is showing, with the data it needs.
type Tab = 'explore' | 'mine' | 'account';
type Route =
  | { name: 'loading' }
  | { name: 'welcome' }
  | { name: Tab }
  | { name: 'package'; pkg: Package }
  | { name: 'form'; trip: Trip; back: Route }
  | { name: 'pay'; booking: Booking }
  | { name: 'confirmed'; booking: Booking; justPaid: boolean; from: Tab };

// Remembers that the welcome screen was seen on this phone, and day/night.
const WELCOME_KEY = 'seen-welcome';
const THEME_KEY = 'app-theme';

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'loading' });
  // Arrival date chosen on Explore, kept while browsing packages.
  const [day, setDay] = useState(isoDay(new Date()));
  // Signed-in guest (Google), or null.
  const account = useAccount();
  // Day or night (saved on the phone).
  const [theme, setTheme] = useState<ThemeMode>('light');

  // First launch → welcome screen; afterwards straight to Explore.
  // Also applies the saved day/night choice before the first screen shows.
  useEffect(() => {
    AsyncStorage.multiGet([WELCOME_KEY, THEME_KEY])
      .then(([[, seen], [, saved]]) => {
        if (saved === 'dark') { applyTheme('dark'); setTheme('dark'); }
        setRoute(seen ? { name: 'explore' } : { name: 'welcome' });
      })
      .catch(() => setRoute({ name: 'welcome' }));
  }, []);

  // Switches day / night: new palette and styles, re-render, remember it.
  const toggleTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
    AsyncStorage.setItem(THEME_KEY, next).catch(() => {});
  };

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
          setRoute({ name: 'explore' });
        }} />
      );
      break;
    case 'explore':
      screen = (
        <Explore day={day} onDay={setDay} onOpen={(pkg) => setRoute({ name: 'package', pkg })} theme={theme} onToggleTheme={toggleTheme} />
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
          onPaid={(booking) => setRoute({ name: 'confirmed', booking, justPaid: true, from: 'explore' })}
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
      screen = <Profile account={account} theme={theme} onToggleTheme={toggleTheme} />;
      break;
  }

  // The tab bar only shows on the three top-level screens.
  const tab = route.name === 'explore' || route.name === 'mine' || route.name === 'account' ? route.name : null;

  return (
    <View style={st.root}>
      <StatusBar style={route.name === 'welcome' || route.name === 'loading' || theme === 'dark' ? 'light' : 'dark'} />
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
