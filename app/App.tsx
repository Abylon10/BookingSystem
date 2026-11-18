/**
 * app/App.tsx
 *
 * Guest app root. Simple state-based navigation (no router library):
 *
 *   Welcome (first launch only)
 *      │ get started
 *   Explore ──tap package──▶ PackageDetail ──book now──┐
 *      │                    (guests, dates, extra days)│
 *      └──build your own──▶ BuildTrip ──continue───────┤
 *                           (services checklist)       ▼
 *                                   GuestForm ──reserve (HOLD)──▶ Payment ──pay──▶ Confirmation
 *
 *   My trips (tab)  : list + calendar timeline ──tap──▶ Confirmation
 *   Account (tab)   : Google sign-in
 *
 * The bottom tab bar switches between Explore, My trips and Account; it is
 * hidden while booking.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Booking, IslandStatus, Package, Trip } from './src/api';
import { useAccount } from './src/auth';
import { saveBooking } from './src/storage';
import { colors, shadow } from './src/theme';
import { Ionicons, isoDay } from './src/ui';
import { Welcome } from './src/screens/Welcome';
import { Explore } from './src/screens/Explore';
import { PackageDetail } from './src/screens/PackageDetail';
import { BuildTrip } from './src/screens/BuildTrip';
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
  | { name: 'build'; island: IslandStatus }
  | { name: 'form'; trip: Trip; back: Route }
  | { name: 'pay'; booking: Booking }
  | { name: 'confirmed'; booking: Booking; justPaid: boolean; from: Tab };

// Remembers that the welcome screen was seen on this phone.
const WELCOME_KEY = 'seen-welcome';

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'loading' });
  // Arrival date chosen on Explore, kept while browsing packages.
  const [day, setDay] = useState(isoDay(new Date()));
  // Signed-in guest (Google), or null.
  const account = useAccount();

  // First launch → welcome screen; afterwards straight to Explore.
  useEffect(() => {
    AsyncStorage.getItem(WELCOME_KEY)
      .then((seen) => setRoute(seen ? { name: 'explore' } : { name: 'welcome' }))
      .catch(() => setRoute({ name: 'welcome' }));
  }, []);

  // Picks the screen for the current route.
  let screen;
  switch (route.name) {
    case 'loading':
      screen = <View style={{ flex: 1, backgroundColor: colors.ink }} />;
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
        <Explore day={day} onDay={setDay}
          onOpen={(pkg) => setRoute({ name: 'package', pkg })}
          onBuild={(island) => setRoute({ name: 'build', island })} />
      );
      break;
    case 'package':
      screen = <PackageDetail pkg={route.pkg} onBack={() => setRoute({ name: 'explore' })} onBook={(trip) => setRoute({ name: 'form', trip, back: route })} />;
      break;
    case 'build':
      screen = <BuildTrip island={route.island} startDay={day} onBack={() => setRoute({ name: 'explore' })} onContinue={(trip) => setRoute({ name: 'form', trip, back: route })} />;
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
      screen = <Profile account={account} />;
      break;
  }

  // The tab bar only shows on the three top-level screens.
  const tab = route.name === 'explore' || route.name === 'mine' || route.name === 'account' ? route.name : null;

  return (
    <View style={st.root}>
      <StatusBar style={route.name === 'welcome' || route.name === 'loading' ? 'light' : 'dark'} />
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
const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tabs: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', backgroundColor: '#fff',
    paddingTop: 10, paddingBottom: 26, borderTopLeftRadius: 24, borderTopRightRadius: 24, ...shadow,
  },
  tab: { flex: 1, alignItems: 'center' },
  tabPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999 },
  tabPillOn: { backgroundColor: colors.primary },
  tabText: { color: '#fff', fontWeight: '700' },
});
