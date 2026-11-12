/**
 * app/App.tsx
 *
 * Guest app root. Simple state-based navigation (no router library):
 *
 *   Explore ──tap package──▶ PackageDetail ──reserve (HOLD)──▶ Payment
 *      ▲                                                          │ pay
 *      └──────────────── done ◀── Confirmation ◀──────────────────┘ (CONFIRMED)
 *
 *   My bookings (tab) ──tap──▶ Confirmation
 *
 * The bottom bar switches between the two tabs; it is hidden during booking.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { Booking, Package } from './src/api';
import { saveBooking } from './src/storage';
import { colors, space } from './src/theme';
import { isoDay } from './src/ui';
import { Explore } from './src/screens/Explore';
import { PackageDetail } from './src/screens/PackageDetail';
import { Payment } from './src/screens/Payment';
import { Confirmation } from './src/screens/Confirmation';
import { MyBookings } from './src/screens/MyBookings';

// Which screen is showing, with the data it needs.
type Route =
  | { name: 'explore' }
  | { name: 'mine' }
  | { name: 'package'; pkg: Package }
  | { name: 'pay'; booking: Booking }
  | { name: 'confirmed'; booking: Booking; justPaid: boolean; from: 'explore' | 'mine' };

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'explore' });
  // Search filters live here so they survive opening a package and coming back.
  const [day, setDay] = useState(isoDay(new Date()));
  const [guests, setGuests] = useState(2);

  // Picks the screen for the current route.
  let screen;
  switch (route.name) {
    case 'explore':
      screen = (
        <Explore
          day={day}
          guests={guests}
          onChange={(d, g) => { setDay(d); setGuests(g); }}
          onOpen={(pkg) => setRoute({ name: 'package', pkg })}
        />
      );
      break;
    case 'package':
      screen = (
        <PackageDetail
          pkg={route.pkg}
          onBack={() => setRoute({ name: 'explore' })}
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
      <StatusBar style="light" />
      {screen}
      {tab && (
        <View style={st.tabs}>
          <TabButton label="Explore" active={tab === 'explore'} onPress={() => setRoute({ name: 'explore' })} />
          <TabButton label="My bookings" active={tab === 'mine'} onPress={() => setRoute({ name: 'mine' })} />
        </View>
      )}
    </View>
  );
}

// One button in the bottom tab bar.
function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={st.tab}>
      <Text style={[st.tabText, active && st.tabActive]}>{label}</Text>
      {active && <View style={st.tabDot} />}
    </Pressable>
  );
}

// Styles for the root and tab bar.
const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.sand },
  tabs: {
    position: 'absolute', left: space.md, right: space.md, bottom: space.lg,
    flexDirection: 'row', backgroundColor: colors.ink, borderRadius: 999, paddingVertical: 10,
  },
  tab: { flex: 1, alignItems: 'center', gap: 4 },
  tabText: { color: '#9FB3BE', fontWeight: '600' },
  tabActive: { color: '#fff' },
  tabDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
});
