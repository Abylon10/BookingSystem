/**
 * app/src/screens/Explore.tsx
 *
 * Home screen. Pick a date (calendar sheet), filter by island or search,
 * then browse: day trips as big picture cards, island stays as a list, and
 * "Build your own trip" per island (services checklist). The number of
 * guests is chosen after tapping a package or an island.
 *
 * Central asks the three islands IN PARALLEL; island chips show a green/red
 * dot for online/offline. An offline island's packages are not shown,
 * because only the island that owns the inventory can sell them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { searchPackages, type IslandStatus, type Package, type SearchResult } from '../api';
import { HERO_PHOTOS, PackageImage } from '../scene';
import { colors, peso, radius, shadow, space } from '../theme';
import { addDays, DateSheet, ErrorBox, Ionicons, isoDay, Pills, prettyDay, SectionTitle } from '../ui';

// How far ahead guests can book (matches the islands' inventoryDays: 60).
const TODAY = isoDay(new Date());
const LAST_DAY = addDays(TODAY, 59);

export function Explore({ day, onDay, onOpen, onBuild }: {
  day: string;
  onDay: (day: string) => void;
  onOpen: (p: Package) => void;
  onBuild: (island: IslandStatus) => void;
}) {
  // Search result, error text, loading flag, filters, calendar sheet.
  const [data, setData] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [island, setIsland] = useState('all');
  const [query, setQuery] = useState('');
  const [calendar, setCalendar] = useState(false);

  // Runs the search for the current date (1 guest; the guest count is
  // chosen on the package screen).
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await searchPackages(day, 1));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [day]);

  // Search again whenever the date changes.
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
  const buildable = islands.filter((i) => i.status === 'online' && (island === 'all' || i.id === island));

  return (
    <ScrollView
      style={st.screen}
      contentContainerStyle={{ paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={load} tintColor={colors.primary} />}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header: Biliran photo with the Resortify logo, location and greeting,
          then the search box and arrival date */}
      <View style={st.header}>
        <Image source={HERO_PHOTOS.home} style={st.headerPhoto} resizeMode="cover" />
        <View style={st.headerShade} />
        <View style={st.topRow}>
          <View style={st.brand}>
            <Image source={require('../../assets/resortify-logo.png')} style={st.logo} />
            <Text style={st.brandName}>Resortify</Text>
          </View>
          <View style={st.locPill}>
            <Ionicons name="location" size={14} color={colors.primary} />
            <Text style={st.locText}>Biliran Province</Text>
          </View>
        </View>
        <Text style={st.hello}>Discover your</Text>
        <Text style={st.helloBold}>perfect island trip</Text>
        <View style={st.search}>
          <Ionicons name="search" size={20} color={colors.muted} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Search falls, islands, stays…" placeholderTextColor="#8DA3AE" style={st.searchInput} />
          {query ? <Pressable onPress={() => setQuery('')} hitSlop={8}><Ionicons name="close-circle" size={18} color={colors.muted} /></Pressable> : null}
        </View>
        <Pressable onPress={() => setCalendar(true)} style={st.dateBtn}>
          <Ionicons name="calendar-outline" size={20} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={st.tripLabel}>Arrival date</Text>
            <Text style={st.tripValue}>{day === TODAY ? 'Today' : prettyDay(day)}</Text>
          </View>
          <Ionicons name="chevron-down" size={18} color={colors.muted} />
        </Pressable>
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

        {/* Build your own trip from an island's services checklist */}
        {buildable.length > 0 && (
          <>
            <SectionTitle title="Build your own trip" note="Pick services" />
            <View style={{ gap: space.sm }}>
              {buildable.map((i) => (
                <Pressable key={i.id} onPress={() => onBuild(i)} style={({ pressed }) => [st.build, pressed && { opacity: 0.9 }]}>
                  <View style={st.buildIcon}><Ionicons name="options-outline" size={22} color={colors.ink} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={st.rowName}>{i.name}</Text>
                    <Text style={st.rowMeta}>
                      {(data?.services ?? []).filter((s) => s.island_id === i.id).map((s) => s.name).join(' · ') || 'Choose rooms, tours and boats'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.muted} />
                </Pressable>
              ))}
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
      <DateSheet open={calendar} onClose={() => setCalendar(false)} value={day} min={TODAY} max={LAST_DAY} onChange={onDay} />
    </ScrollView>
  );
}

// Big picture card (reference: featured hotels): picture, island tag,
// name and price on a dark strip; a red note when it can't be booked.
function BigCard({ p, onPress }: { p: Package; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.big, pressed && { opacity: 0.9 }]}>
      <PackageImage packageId={p.id} style={StyleSheet.absoluteFill} />
      {!p.available && <View style={st.shade} />}
      <View style={st.tag}><Text style={st.tagText}>{p.island_name.replace(' Island', '')}</Text></View>
      <View style={st.bigFoot}>
        <Text style={st.bigName} numberOfLines={1}>{p.name}</Text>
        <View style={st.bigRow}>
          <Text style={st.bigPrice}>{peso(p.price_php)}<Text style={st.bigUnit}>{p.pricing === 'per_guest' ? ' /guest' : ' /package'}</Text></Text>
          {!p.available && <Text style={st.bigOff} numberOfLines={1}>{p.reason}</Text>}
        </View>
      </View>
    </Pressable>
  );
}

// List row (reference: "Hotels nearby"): thumbnail, name, place, price.
function RowCard({ p, onPress }: { p: Package; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.row, pressed && { opacity: 0.9 }, !p.available && { opacity: 0.75 }]}>
      <PackageImage packageId={p.id} style={st.thumb} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={st.rowName} numberOfLines={1}>{p.name}</Text>
        <View style={st.rowPlace}>
          <Ionicons name="location-outline" size={13} color={colors.muted} />
          <Text style={st.rowMeta} numberOfLines={1}>{p.location}</Text>
        </View>
        <Text style={st.rowMeta}>{p.nights} night{p.nights > 1 ? 's' : ''} · up to {p.max_guests} guests</Text>
        {!p.available && <Text style={st.rowOff} numberOfLines={1}>{p.reason}</Text>}
      </View>
      <Text style={st.rowPrice}>{peso(p.price_php)}</Text>
    </Pressable>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },

  // Header block on a light sky background with a rounded bottom
  header: { backgroundColor: colors.ink, paddingTop: 52, paddingHorizontal: space.md, paddingBottom: space.lg, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg, gap: 6, overflow: 'hidden' },
  headerPhoto: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' },
  headerShade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(1, 60, 88, 0.45)' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.md },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radius.pill, paddingLeft: 3, paddingRight: 12, paddingVertical: 3 },
  logo: { width: 32, height: 32, borderRadius: 16 },
  brandName: { color: colors.ink, fontWeight: '800', fontSize: 15, letterSpacing: 0.5 },
  locPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 7 },
  locText: { color: colors.ink, fontWeight: '700', fontSize: 12 },
  hello: { color: '#E3F6FC', fontSize: 22 },
  helloBold: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: -4 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.pill, paddingHorizontal: 16, height: 52, marginTop: space.md, ...shadow, shadowOpacity: 0.07 },
  searchInput: { flex: 1, fontSize: 15, color: colors.ink },
  dateBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.pill, paddingHorizontal: 16, height: 54, marginTop: space.sm },
  tripLabel: { color: colors.muted, fontSize: 11 },
  tripValue: { color: colors.ink, fontWeight: '700', fontSize: 15 },

  body: { padding: space.md, gap: space.md },

  // Big picture card
  big: { width: 250, height: 210, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.sky, justifyContent: 'flex-end' },
  shade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(240,240,240,0.55)' },
  tag: { position: 'absolute', top: 12, left: 12, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  bigFoot: { backgroundColor: 'rgba(1, 60, 88, 0.78)', padding: 12, gap: 4 },
  bigName: { color: '#fff', fontSize: 16, fontWeight: '800' },
  bigRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  bigPrice: { color: colors.sun, fontSize: 16, fontWeight: '800' },
  bigUnit: { color: '#CFE8F1', fontSize: 12, fontWeight: '500' },
  bigOff: { color: '#FFC9BD', fontSize: 12, fontWeight: '700', flexShrink: 1 },

  // List row
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 10, ...shadow, shadowOpacity: 0.06 },
  thumb: { width: 76, height: 76, borderRadius: 14 },
  rowName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  rowPlace: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  rowMeta: { color: colors.muted, fontSize: 12 },
  rowOff: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  rowPrice: { color: colors.primary, fontSize: 16, fontWeight: '800' },

  // Build-your-own island rows
  build: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 14, borderWidth: 1.5, borderColor: colors.sky, borderStyle: 'dashed' },
  buildIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.sun, alignItems: 'center', justifyContent: 'center' },

  empty: { alignItems: 'center', gap: 8, marginTop: space.lg },
  emptyText: { color: colors.muted, textAlign: 'center' },
});
