/**
 * app/App.tsx
 *
 * Guest app root. Simple state-based navigation (no router library):
 *
 *   Welcome (first launch only)
 *      │ get started
 *   Explore ──tap──▶ PackageDetail ──book now──▶ GuestForm ──reserve (HOLD)──▶ Payment
 *      ▲                                                                         │ pay
 *      └──────────────────────── done ◀── Confirmation ◀─────────────────────────┘ (CONFIRMED)
 *
 *   My trips (tab) ──tap──▶ Confirmation
 *
 * The bottom tab bar switches between Explore and My trips; it is hidden
 * while booking.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Booking, Package } from './src/api';
import { saveBooking } from './src/storage';
import { colors, shadow } from './src/theme';
import { Ionicons, isoDay } from './src/ui';
import { Welcome } from './src/screens/Welcome';
import { Explore } from './src/screens/Explore';
import { PackageDetail } from './src/screens/PackageDetail';
import { GuestForm } from './src/screens/GuestForm';
import { Payment } from './src/screens/Payment';
import { Confirmation } from './src/screens/Confirmation';
import { MyBookings } from './src/screens/MyBookings';

// Which screen is showing, with the data it needs.
type Route =
  | { name: 'loading' }
  | { name: 'welcome' }
  | { name: 'explore' }
  | { name: 'mine' }
  | { name: 'package'; pkg: Package }
  | { name: 'form'; pkg: Package }
  | { name: 'pay'; booking: Booking }
  | { name: 'confirmed'; booking: Booking; justPaid: boolean; from: 'explore' | 'mine' };

// Remembers that the welcome screen was seen on this phone.
const WELCOME_KEY = 'seen-welcome';

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'loading' });
  // Search filters live here so they survive opening a package and coming back.
  const [day, setDay] = useState(isoDay(new Date()));
  const [guests, setGuests] = useState(2);

  // First launch → welcome screen; afterwards straight to Explore.
  useEffect(() => {
    AsyncStorage.getItem(WELCOME_KEY)
      .then((seen) => setRoute(seen ? { name: 'explore' } : { name: 'welcome' }))
      .catch(() => setRoute({ name: 'welcome' }));
  }, []);

  // Updates the shared date/guest filters.
  const setTrip = (d: string, g: number) => { setDay(d); setGuests(g); };

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
      screen = <Explore day={day} guests={guests} onChange={setTrip} onOpen={(pkg) => setRoute({ name: 'package', pkg })} />;
      break;
    case 'package':
      screen = (
        <PackageDetail
          pkg={route.pkg}
          onBack={() => setRoute({ name: 'explore' })}
          onChange={setTrip}
          onBook={(pkg) => setRoute({ name: 'form', pkg })}
        />
      );
      break;
    case 'form':
      screen = (
        <GuestForm
          pkg={route.pkg}
          onBack={() => setRoute({ name: 'package', pkg: route.pkg })}
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
      screen = <Confirmation booking={route.booking} justPaid={route.justPaid} onDone={() => setRoute(route.from === 'mine' ? { name: 'mine' } : { name: 'explore' })} />;
      break;
    case 'mine':
      screen = <MyBookings onOpen={(booking) => setRoute({ name: 'confirmed', booking, justPaid: false, from: 'mine' })} />;
      break;
  }

  // The tab bar only shows on the two top-level screens.
  const tab = route.name === 'explore' || route.name === 'mine' ? route.name : null;

  return (
    <View style={st.root}>
      <StatusBar style={route.name === 'welcome' || route.name === 'loading' ? 'light' : 'dark'} />
      {screen}
      {tab && (
        <View style={st.tabs}>
          <TabButton icon="compass" label="Explore" active={tab === 'explore'} onPress={() => setRoute({ name: 'explore' })} />
          <TabButton icon="ticket" label="My trips" active={tab === 'mine'} onPress={() => setRoute({ name: 'mine' })} />
        </View>
      )}
    </View>
  );
}

// One button in the bottom tab bar (filled icon + label when active).
function TabButton({ icon, label, active, onPress }: { icon: 'compass' | 'ticket'; label: string; active: boolean; onPress: () => void }) {
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
