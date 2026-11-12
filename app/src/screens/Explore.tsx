/**
 * app/src/screens/Explore.tsx
 *
 * Home screen. Pick a date (calendar sheet) and guest count, filter by island
 * or search, then browse: day trips as big picture cards, overnight stays as
 * a list. Central asks the three islands IN PARALLEL; island chips show a
 * green/red dot for online/offline. An offline island's packages are not
 * shown, because only the island that owns the inventory can sell them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { searchPackages, type Package, type SearchResult } from '../api';
import { PackageImage } from '../scene';
import { colors, peso, radius, shadow, space } from '../theme';
import { addDays, DateSheet, ErrorBox, Ionicons, isoDay, Pills, prettyDay, SectionTitle, Stepper } from '../ui';

// How far ahead guests can book (matches the islands' inventoryDays: 60).
const TODAY = isoDay(new Date());
const LAST_DAY = addDays(TODAY, 59);

export function Explore({ day, guests, onChange, onOpen }: {
  day: string;
  guests: number;
  onChange: (day: string, guests: number) => void;
  onOpen: (p: Package) => void;
}) {
  // Search result, error text, loading flag, filters, calendar sheet.
  const [data, setData] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [island, setIsland] = useState('all');
  const [query, setQuery] = useState('');
  const [calendar, setCalendar] = useState(false);

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

  // Island filter + text search, done on the phone (no extra request).
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.packages ?? []).filter((p) =>
      (island === 'all' || p.island_id === island)
      && (!q || `${p.name} ${p.location} ${p.island_name}`.toLowerCase().includes(q)));
  }, [data, island, query]);
  const dayTrips = shown.filter((p) => p.nights === 0);
  const stays = shown.filter((p) => p.nights > 0);

  // Chip options: All + each island, with an online/offline dot.
  const islands = data?.islands ?? [];
  const chipIds = ['all', ...islands.map((i) => i.id)];
  const offline = islands.filter((i) => i.status === 'offline');

  return (
    <ScrollView
      style={st.screen}
      contentContainerStyle={{ paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={load} tintColor={colors.primary} />}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header: location pill, greeting, search box */}
      <View style={st.header}>
        <View style={st.locPill}>
          <Ionicons name="location" size={15} color={colors.primary} />
          <Text style={st.locText}>Biliran Province</Text>
        </View>
        <Text style={st.hello}>Discover your</Text>
        <Text style={st.helloBold}>perfect island trip</Text>
        <View style={st.search}>
          <Ionicons name="search" size={20} color={colors.muted} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Search falls, islands, stays…" placeholderTextColor="#8DA3AE" style={st.searchInput} />
          {query ? <Pressable onPress={() => setQuery('')} hitSlop={8}><Ionicons name="close-circle" size={18} color={colors.muted} /></Pressable> : null}
        </View>

        {/* Trip settings: date (opens the calendar) and guests */}
        <View style={st.tripRow}>
          <Pressable onPress={() => setCalendar(true)} style={st.dateBtn}>
            <Ionicons name="calendar-outline" size={20} color={colors.primary} />
            <View>
              <Text style={st.tripLabel}>Date</Text>
              <Text style={st.tripValue}>{day === TODAY ? 'Today' : prettyDay(day)}</Text>
            </View>
          </Pressable>
          <Stepper value={guests} min={1} max={8} onChange={(g) => onChange(day, g)} />
        </View>
      </View>

      <View style={st.body}>
        {/* Island chips with live status dots */}
        {islands.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: space.md }}>
            <Pills
              options={chipIds}
              value={island}
              onChange={setIsland}
              labelOf={(id) => (id === 'all' ? 'All islands' : islands.find((i) => i.id === id)?.name?.replace(' Island', '') ?? id)}
              dotOf={(id) => (id === 'all' ? null : islands.find((i) => i.id === id)?.status === 'online' ? colors.ok : colors.danger)}
            />
          </ScrollView>
        )}

        {offline.length > 0 && (
          <ErrorBox tone="notice" message={`${offline.map((i) => i.name ?? i.id).join(', ')} ${offline.length > 1 ? 'are' : 'is'} offline, so ${offline.length > 1 ? 'their' : 'its'} packages can't be booked online right now. Walk-ins at the island still work.`} />
        )}
        <ErrorBox message={error} />
        {loading && !data && <ActivityIndicator color={colors.primary} style={{ marginTop: space.lg }} />}

        {/* Day trips: big horizontal picture cards */}
        {dayTrips.length > 0 && (
          <>
            <SectionTitle title="Day trips" note={`${dayTrips.length} found`} />
            <FlatList
              horizontal
              data={dayTrips}
              keyExtractor={(p) => p.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: space.md, paddingRight: space.md, paddingVertical: 4 }}
              renderItem={({ item }) => <BigCard p={item} onPress={() => onOpen(item)} />}
            />
          </>
        )}

        {/* Overnight stays: list rows with a thumbnail */}
        {stays.length > 0 && (
          <>
            <SectionTitle title="Island stays" note={`${stays.length} found`} />
            <View style={{ gap: space.md }}>
              {stays.map((p) => <RowCard key={p.id} p={p} onPress={() => onOpen(p)} />)}
            </View>
          </>
        )}

        {!loading && !error && shown.length === 0 && (
          <View style={st.empty}>
            <Ionicons name="boat-outline" size={36} color={colors.muted} />
            <Text style={st.emptyText}>{query || island !== 'all' ? 'Nothing matches your filters.' : 'No packages online right now. Try again in a moment.'}</Text>
          </View>
        )}
      </View>

      {/* Calendar sheet */}
      <DateSheet open={calendar} onClose={() => setCalendar(false)} value={day} min={TODAY} max={LAST_DAY} onChange={(d) => onChange(d, guests)} />
    </ScrollView>
  );
}

// Why a package can't be booked for the current search (or null if it can).
export function unavailableReason(p: Package) {
  if (p.guests > p.max_guests) return `Max ${p.max_guests} guests`;
  if (!p.available) return 'Fully booked';
  return null;
}

// Big picture card (reference: featured hotels): picture, island tag,
// name and price on a dark strip at the bottom.
function BigCard({ p, onPress }: { p: Package; onPress: () => void }) {
  const reason = unavailableReason(p);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.big, pressed && { opacity: 0.9 }]}>
      <PackageImage packageId={p.id} style={StyleSheet.absoluteFill} />
      <View style={st.tag}><Text style={st.tagText}>{p.island_name.replace(' Island', '')}</Text></View>
      <View style={st.bigFoot}>
        <Text style={st.bigName} numberOfLines={1}>{p.name}</Text>
        <View style={st.bigRow}>
          <Text style={st.bigPrice}>{peso(p.price_php)}<Text style={st.bigUnit}>{p.pricing === 'per_guest' ? ' /guest' : ' /package'}</Text></Text>
          <Text style={[st.bigLeft, reason && { color: '#FFC9BD' }]}>{reason ?? `${p.spots} left`}</Text>
        </View>
      </View>
    </Pressable>
  );
}

// List row (reference: "Hotels nearby"): thumbnail, name, place, price.
function RowCard({ p, onPress }: { p: Package; onPress: () => void }) {
  const reason = unavailableReason(p);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.row, pressed && { opacity: 0.9 }]}>
      <PackageImage packageId={p.id} style={st.thumb} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={st.rowName} numberOfLines={1}>{p.name}</Text>
        <View style={st.rowPlace}>
          <Ionicons name="location-outline" size={13} color={colors.muted} />
          <Text style={st.rowMeta} numberOfLines={1}>{p.location}</Text>
        </View>
        <Text style={st.rowMeta}>{p.nights} night{p.nights > 1 ? 's' : ''} · up to {p.max_guests} guests</Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={st.rowPrice}>{peso(p.total_php)}</Text>
        <Text style={[st.rowLeft, reason && { color: colors.danger }]}>{reason ?? `${p.spots} left`}</Text>
      </View>
    </Pressable>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },

  // Header block on a light sky background with a rounded bottom
  header: { backgroundColor: colors.skySoft, paddingTop: 56, paddingHorizontal: space.md, paddingBottom: space.lg, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg, gap: 6 },
  locPill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7, marginBottom: space.sm, ...shadow, shadowOpacity: 0.06 },
  locText: { color: colors.ink, fontWeight: '700', fontSize: 13 },
  hello: { color: colors.muted, fontSize: 22 },
  helloBold: { color: colors.ink, fontSize: 26, fontWeight: '800', marginTop: -4 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.pill, paddingHorizontal: 16, height: 52, marginTop: space.md, ...shadow, shadowOpacity: 0.07 },
  searchInput: { flex: 1, fontSize: 15, color: colors.ink },
  tripRow: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  dateBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.pill, paddingHorizontal: 16, height: 54 },
  tripLabel: { color: colors.muted, fontSize: 11 },
  tripValue: { color: colors.ink, fontWeight: '700', fontSize: 15 },

  body: { padding: space.md, gap: space.md },

  // Big picture card
  big: { width: 250, height: 210, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.sky, justifyContent: 'flex-end' },
  tag: { position: 'absolute', top: 12, left: 12, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  bigFoot: { backgroundColor: 'rgba(1, 60, 88, 0.78)', padding: 12, gap: 4 },
  bigName: { color: '#fff', fontSize: 16, fontWeight: '800' },
  bigRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  bigPrice: { color: colors.sun, fontSize: 16, fontWeight: '800' },
  bigUnit: { color: '#CFE8F1', fontSize: 12, fontWeight: '500' },
  bigLeft: { color: '#CFE8F1', fontSize: 12 },

  // List row
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 10, ...shadow, shadowOpacity: 0.06 },
  thumb: { width: 76, height: 76, borderRadius: 14 },
  rowName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  rowPlace: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  rowMeta: { color: colors.muted, fontSize: 12 },
  rowPrice: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  rowLeft: { color: colors.muted, fontSize: 12 },

  empty: { alignItems: 'center', gap: 8, marginTop: space.lg },
  emptyText: { color: colors.muted, textAlign: 'center' },
});
