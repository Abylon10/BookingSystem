/**
 * app/src/screens/Explore.tsx
 *
 * Home screen: pick a date and guest count, see every island's packages.
 * Central asks the three islands IN PARALLEL; each chip shows the island's
 * status and response time. Packages of an offline island are not shown,
 * because only the island that owns the inventory can sell them.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { searchPackages, type Package, type SearchResult } from '../api';
import { colors, peso, radius, space } from '../theme';
import { ErrorBox, Header, isoDay, nextDays, Pills, Stepper } from '../ui';

// The next 14 days, as chip values.
const DAYS = nextDays(14).map(isoDay);

export function Explore({ day, guests, onChange, onOpen }: {
  day: string;
  guests: number;
  onChange: (day: string, guests: number) => void;
  onOpen: (p: Package) => void;
}) {
  // Last search result, error text, and loading flag.
  const [data, setData] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Runs the search for the current date and guest count.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await searchPackages(day, guests));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [day, guests]);

  // Search again whenever the date or guest count changes.
  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={st.screen}>
      {/* Header with island status chips (online/offline, ms, link type) */}
      <Header title="Explore Biliran" subtitle="Packages on Biliran, Maripipi & Higatangan">
        {data && (
          <View style={st.chips}>
            {data.islands.map((i) => (
              <Text key={i.id} style={[st.chip, i.status === 'offline' && st.chipOff]}>
                {i.name ?? i.id} · {i.status === 'online' ? `${i.ms} ms` : 'offline'}
              </Text>
            ))}
          </View>
        )}
      </Header>

      <FlatList
        data={data?.packages ?? []}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: space.md, gap: space.md, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={load} />}
        // Filters on top of the list: date chips and guest stepper.
        ListHeaderComponent={
          <View style={{ gap: space.md }}>
            <Text style={st.section}>When?</Text>
            <Pills options={DAYS} value={day} onChange={(d) => onChange(d, guests)} labelOf={chipLabel} />
            <View style={st.guestRow}>
              <Text style={st.section}>Guests</Text>
              <Stepper value={guests} min={1} max={8} onChange={(g) => onChange(day, g)} />
            </View>
            {/* Offline-island notice: explains why some packages are missing */}
            {data?.islands.some((i) => i.status === 'offline') && (
              <Text style={st.notice}>
                Some islands are offline right now, so their packages can't be booked online. Walk-ins at the island still work.
              </Text>
            )}
            <ErrorBox message={error} />
            {loading && !data && <ActivityIndicator color={colors.primary} style={{ marginTop: space.lg }} />}
          </View>
        }
        ListEmptyComponent={!loading && !error ? <Text style={st.empty}>No packages found for this date.</Text> : undefined}
        renderItem={({ item }) => <PackageCard p={item} onPress={() => onOpen(item)} />}
      />
    </View>
  );
}

// "2026-11-14" → "Today", "Tomorrow", or "Sat 14".
function chipLabel(d: string) {
  const i = DAYS.indexOf(d);
  if (i === 0) return 'Today';
  if (i === 1) return 'Tomorrow';
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric' });
}

// One package card: island, name, location, price for the chosen guests,
// nights, and spots left (or the reason it can't be booked).
function PackageCard({ p, onPress }: { p: Package; onPress: () => void }) {
  const reason = p.guests > p.max_guests ? `Max ${p.max_guests} guests` : !p.available ? 'Unavailable on this date' : null;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.card, pressed && { opacity: 0.85 }, reason && { opacity: 0.6 }]}>
      <Text style={st.island}>{p.island_name}</Text>
      <Text style={st.name}>{p.name}</Text>
      <Text style={st.location}>{p.location} · {p.nights ? `${p.nights} night${p.nights > 1 ? 's' : ''}` : 'Day trip'}</Text>
      <View style={st.row}>
        <Text style={st.price}>
          {peso(p.total_php)}
          <Text style={st.unit}> for {p.guests} guest{p.guests > 1 ? 's' : ''}</Text>
        </Text>
        <Text style={[st.left, reason && { color: colors.danger }]}>{reason ?? `${p.spots} left`}</Text>
      </View>
    </Pressable>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sand },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: { backgroundColor: colors.secondary, color: '#fff', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden', fontSize: 12 },
  chipOff: { backgroundColor: colors.danger },
  section: { color: colors.ink, fontWeight: '700', fontSize: 15 },
  guestRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  notice: { backgroundColor: '#FBEBD7', color: colors.ink, padding: space.md, borderRadius: radius.sm },
  empty: { color: colors.muted, textAlign: 'center', marginTop: space.lg },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: space.md },
  island: { color: colors.secondary, fontWeight: '700', fontSize: 12, textTransform: 'uppercase' },
  name: { color: colors.ink, fontSize: 17, fontWeight: '700', marginTop: 2 },
  location: { color: colors.muted, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: space.sm },
  price: { color: colors.accent, fontSize: 18, fontWeight: '700' },
  unit: { color: colors.muted, fontSize: 13, fontWeight: '400' },
  left: { color: colors.muted, fontSize: 12 },
});
