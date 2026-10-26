/**
 * app/App.tsx
 *
 * Placeholder home screen. It proves the phone can reach central over the
 * hotspot and shows the merged search result from all islands. The real
 * screens from DESIGN.md §10 (search, detail, booking, ticket, staff scanner)
 * will replace this.
 */
import { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { searchListings, type Listing, type SearchResult } from './src/api';
import { colors, peso, radius, space } from './src/theme';

export default function App() {
  // Screen state: last search result, last error, and whether a request is running.
  const [data, setData] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetches listings from central. Used on first render and on pull-to-refresh.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await searchListings());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load once when the screen opens.
  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />

      {/* Header: title plus one chip per island showing online/offline and response time */}
      <View style={styles.header}>
        <Text style={styles.title}>Explore Biliran</Text>
        <Text style={styles.subtitle}>Resorts & tours across 3 islands</Text>
        {data && (
          <View style={styles.chips}>
            {data.islands.map((i) => (
              <Text key={i.id} style={[styles.chip, i.status === 'offline' && styles.chipOffline]}>
                {i.id} · {i.status === 'online' ? `${i.ms} ms` : 'offline'}
              </Text>
            ))}
          </View>
        )}
      </View>

      {/* Body: spinner on first load, error if central is unreachable, otherwise the list */}
      {loading && !data ? (
        <ActivityIndicator style={{ marginTop: space.xl }} color={colors.primary} />
      ) : error ? (
        <Text style={styles.error}>Can't reach central: {error}</Text>
      ) : (
        <FlatList
          data={data?.listings ?? []}
          keyExtractor={(l) => l.id}
          contentContainerStyle={{ padding: space.md, gap: space.md }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
          renderItem={({ item }) => <ListingCard item={item} />}
        />
      )}
    </View>
  );
}

// One resort/tour card: type, name, location, price and online units left.
function ListingCard({ item }: { item: Listing }) {
  return (
    <View style={styles.card}>
      <Text style={styles.kind}>{item.kind === 'resort' ? 'Resort' : 'Tour'}</Text>
      <Text style={styles.name}>{item.name}</Text>
      <Text style={styles.location}>{item.location}</Text>
      <View style={styles.row}>
        <Text style={styles.price}>
          {peso(item.price_php)}
          <Text style={styles.unit}>{item.kind === 'resort' ? ' / night' : ' / person'}</Text>
        </Text>
        <Text style={styles.left}>
          {item.online_available === null ? '' : `${item.online_available} left online`}
        </Text>
      </View>
    </View>
  );
}

// Styles, built from the theme tokens in src/theme.ts.
const styles = StyleSheet.create({
  // Layout
  screen: { flex: 1, backgroundColor: colors.sand },
  header: {
    backgroundColor: colors.primary,
    paddingTop: 56,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#D6E6EA', marginTop: 2 },

  // Island status chips
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: {
    backgroundColor: colors.secondary,
    color: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    overflow: 'hidden',
    fontSize: 12,
  },
  chipOffline: { backgroundColor: colors.danger },
  error: { color: colors.danger, margin: space.md },

  // Listing card
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: space.md },
  kind: { color: colors.secondary, fontWeight: '600', fontSize: 12, textTransform: 'uppercase' },
  name: { color: colors.ink, fontSize: 17, fontWeight: '700', marginTop: 2 },
  location: { color: colors.muted, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: space.sm },
  price: { color: colors.accent, fontSize: 18, fontWeight: '700' },
  unit: { color: colors.muted, fontSize: 13, fontWeight: '400' },
  left: { color: colors.muted, fontSize: 12 },
});
