/**
 * app/src/screens/MyBookings.tsx
 *
 * Bookings made on this phone (saved reference + e-mail), refreshed live from
 * central, plus a "find a booking" form for one made on another phone.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { ApiError, getBooking, type Booking } from '../api';
import { forgetBooking, loadSaved, saveBooking } from '../storage';
import { colors, peso, radius, space } from '../theme';
import { Button, ErrorBox, Field, Header, prettyDay, StatusBadge } from '../ui';

// One row: either the loaded booking, or the error for that reference.
type Row = { reference: string; email: string; booking?: Booking; error?: string };

export function MyBookings({ onOpen }: { onOpen: (b: Booking) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  // Lookup form state.
  const [ref, setRef] = useState('');
  const [email, setEmail] = useState('');
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);

  // Loads every saved booking from central IN PARALLEL (they may live on
  // different islands; one offline island doesn't block the others).
  const load = useCallback(async () => {
    setLoading(true);
    const saved = await loadSaved();
    const results = await Promise.allSettled(saved.map((s) => getBooking(s.reference, s.email)));
    setRows(saved.map((s, i) => {
      const r = results[i];
      return r.status === 'fulfilled' ? { ...s, booking: r.value } : { ...s, error: (r.reason as ApiError).message };
    }));
    setLoading(false);
  }, []);

  // Load when the tab opens.
  useEffect(() => {
    load();
  }, [load]);

  // Finds a booking by reference + e-mail, saves it, and opens it.
  async function find() {
    setFinding(true);
    setFindError(null);
    try {
      const b = await getBooking(ref.trim().toUpperCase(), email.trim());
      await saveBooking({ reference: b.reference, email: email.trim() });
      setRef('');
      onOpen(b);
    } catch (err) {
      const e = err as ApiError;
      setFindError(e.status === 404 ? 'No booking with that reference and e-mail.' : e.message);
    } finally {
      setFinding(false);
    }
  }

  // Removes a row that can't be loaded any more.
  async function forget(reference: string) {
    await forgetBooking(reference);
    setRows((r) => r.filter((x) => x.reference !== reference));
  }

  return (
    <View style={st.screen}>
      <Header title="My bookings" subtitle="Show the reference at the island’s front desk" />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.reference}
        contentContainerStyle={{ padding: space.md, gap: space.md, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        ListEmptyComponent={!loading ? <Text style={st.empty}>No bookings on this phone yet.</Text> : undefined}
        renderItem={({ item }) => (item.booking ? (
          // A loaded booking: tap to open the confirmation screen.
          <Pressable onPress={() => onOpen(item.booking!)} style={({ pressed }) => [st.card, pressed && { opacity: 0.85 }]}>
            <View style={st.row}>
              <Text style={st.ref}>{item.reference}</Text>
              <StatusBadge status={item.booking.status} />
            </View>
            <Text style={st.name}>{item.booking.package_name}</Text>
            <Text style={st.meta}>
              {item.booking.island_name} · {prettyDay(item.booking.day)} · {item.booking.guests} guest{item.booking.guests > 1 ? 's' : ''} · {peso(item.booking.total_php)}
            </Text>
          </Pressable>
        ) : (
          // A reference that failed to load (island offline, or deleted).
          <View style={st.card}>
            <Text style={st.ref}>{item.reference}</Text>
            <Text style={st.meta}>{item.error}</Text>
            <Pressable onPress={() => forget(item.reference)}><Text style={st.link}>Remove from this phone</Text></Pressable>
          </View>
        ))}
        // Lookup form under the list.
        ListFooterComponent={
          <View style={st.find}>
            <Text style={st.section}>Find a booking</Text>
            <Field label="Reference" value={ref} onChangeText={setRef} placeholder="e.g. MRP-7F3K2" autoCapitalize="characters" />
            <Field label="E-mail used when booking" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
            <ErrorBox message={findError} />
            <Button label="Find" onPress={find} busy={finding} disabled={!ref.trim() || !email.trim()} />
          </View>
        }
      />
    </View>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sand },
  empty: { color: colors.muted, textAlign: 'center', marginTop: space.md },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ref: { color: colors.ink, fontWeight: '800', fontSize: 16, letterSpacing: 1 },
  name: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 13 },
  link: { color: colors.primary, fontWeight: '600', marginTop: 4 },
  find: { gap: space.sm, marginTop: space.lg },
  section: { color: colors.ink, fontWeight: '700', fontSize: 15 },
});
