/**
 * app/src/screens/MyBookings.tsx
 *
 * Bookings made on this phone (saved reference + e-mail), refreshed live from
 * central, plus a "find a booking" form for one made on another phone.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { ApiError, getBooking, type Booking } from '../api';
import { PackageImage } from '../scene';
import { forgetBooking, loadSaved, saveBooking } from '../storage';
import { colors, peso, radius, shadow, space } from '../theme';
import { Button, ErrorBox, Field, Ionicons, prettyDay, SectionTitle, StatusBadge } from '../ui';

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
      <FlatList
        data={rows}
        keyExtractor={(r) => r.reference}
        contentContainerStyle={{ padding: space.md, paddingTop: 60, gap: space.md, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
        // Page title.
        ListHeaderComponent={
          <View style={{ gap: 2, marginBottom: space.sm }}>
            <Text style={st.title}>My trips</Text>
            <Text style={st.sub}>Show the reference at the island’s front desk</Text>
          </View>
        }
        ListEmptyComponent={!loading ? (
          <View style={st.empty}>
            <Ionicons name="ticket-outline" size={34} color={colors.muted} />
            <Text style={st.emptyText}>No bookings on this phone yet.</Text>
          </View>
        ) : undefined}
        renderItem={({ item }) => (item.booking ? (
          // A loaded booking: tap to open the confirmation screen.
          <Pressable onPress={() => onOpen(item.booking!)} style={({ pressed }) => [st.card, pressed && { opacity: 0.9 }]}>
            <PackageImage packageId={item.booking.package_id} style={st.thumb} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={st.ref}>{item.reference}</Text>
              <Text style={st.name} numberOfLines={1}>{item.booking.package_name}</Text>
              <Text style={st.meta}>
                {prettyDay(item.booking.day)} · {item.booking.guests} guest{item.booking.guests > 1 ? 's' : ''} · {peso(item.booking.total_php)}
              </Text>
              <StatusBadge status={item.booking.status} />
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </Pressable>
        ) : (
          // A reference that failed to load (island offline, or deleted).
          <View style={[st.card, { flexDirection: 'column', alignItems: 'flex-start' }]}>
            <Text style={st.ref}>{item.reference}</Text>
            <Text style={st.meta}>{item.error}</Text>
            <Pressable onPress={() => forget(item.reference)}><Text style={st.link}>Remove from this phone</Text></Pressable>
          </View>
        ))}
        // Lookup form under the list.
        ListFooterComponent={
          <View style={st.find}>
            <SectionTitle title="Find a booking" />
            <Field label="Reference" icon="pricetag-outline" value={ref} onChangeText={setRef} placeholder="e.g. MRP-7F3K2" autoCapitalize="characters" />
            <Field label="E-mail used when booking" icon="mail-outline" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
            <ErrorBox message={findError} />
            <Button label="Find booking" onPress={find} busy={finding} disabled={!ref.trim() || !email.trim()} icon="search" />
          </View>
        }
      />
    </View>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.ink, fontSize: 28, fontWeight: '800' },
  sub: { color: colors.muted },
  empty: { alignItems: 'center', gap: 8, marginVertical: space.md },
  emptyText: { color: colors.muted },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 10, ...shadow, shadowOpacity: 0.06 },
  thumb: { width: 76, height: 92, borderRadius: 14 },
  ref: { color: colors.primary, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  name: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 12 },
  link: { color: colors.primary, fontWeight: '700', marginTop: 4 },
  find: { gap: space.sm, marginTop: space.lg },
});
