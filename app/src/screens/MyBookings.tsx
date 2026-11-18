/**
 * app/src/screens/MyBookings.tsx
 *
 * The guest's trips:
 *  - signed in with Google: every booking made with the account's e-mail
 *    (all islands, via central), plus
 *  - bookings saved on this phone (reference + e-mail), refreshed live.
 * Two views: a list, and a calendar timeline showing how long each
 * reservation uses the services (tap a day to see what's on it).
 * Also a "find a booking" form for one made on another phone.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, getBooking, myBookings, type Booking } from '../api';
import type { Account } from '../auth';
import { PackageImage } from '../scene';
import { forgetBooking, loadSaved, saveBooking } from '../storage';
import { colors, peso, radius, shadow, space, themed } from '../theme';
import { Button, ErrorBox, Field, Ionicons, isoDay, parseDay, Pills, prettyDay, SectionTitle, StatusBadge } from '../ui';

// One row: either the loaded booking, or the error for that reference.
type Row = { reference: string; email: string; booking?: Booking; error?: string };
const ISLAND_NAMES: Record<string, string> = { biliran: 'Biliran Mainland', maripipi: 'Maripipi Island', higatangan: 'Higatangan Island' };
const ACTIVE = new Set(['HELD', 'CONFIRMED', 'CHECKED_IN']);
const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
// One colour per booking on the timeline.
const BAR_COLORS = ['#00537A', '#F5A201', '#1E8A6E', '#6C63FF', '#C8553D', '#2D9CDB'];

export function MyBookings({ account, onOpen, onSignIn }: { account: Account | null; onOpen: (b: Booking) => void; onSignIn: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'List' | 'Calendar'>('List');

  // Lookup form state.
  const [ref, setRef] = useState('');
  const [email, setEmail] = useState('');
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);

  // Loads the account's bookings and every saved booking IN PARALLEL (they
  // may live on different islands; one offline island doesn't block others).
  const load = useCallback(async () => {
    setLoading(true);
    const saved = await loadSaved();
    const [mine, ...results] = await Promise.allSettled([
      account ? myBookings(account.token) : Promise.resolve({ email: '', bookings: [] as Booking[] }),
      ...saved.map((s) => getBooking(s.reference, s.email)),
    ]);
    const out = new Map<string, Row>();
    // Saved on this phone (live from the islands).
    saved.forEach((s, i) => {
      const r = results[i] as PromiseSettledResult<Booking>;
      out.set(s.reference, r.status === 'fulfilled' ? { ...s, booking: r.value } : { ...s, error: (r.reason as ApiError).message });
    });
    // From the account (central's copies); the live copy wins when both exist.
    if (mine.status === 'fulfilled') {
      for (const b of (mine.value as { bookings: Booking[] }).bookings) {
        const existing = out.get(b.reference);
        if (!existing?.booking) out.set(b.reference, { reference: b.reference, email: b.email, booking: { ...b, island_name: b.island_name ?? ISLAND_NAMES[b.island_id] ?? b.island_id } });
      }
    }
    setRows([...out.values()].sort((a, b) => (b.booking?.day ?? '').localeCompare(a.booking?.day ?? '')));
    setLoading(false);
  }, [account]);

  // Load when the tab opens (and again after signing in or out).
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

  const bookings = rows.filter((r) => r.booking).map((r) => r.booking!);

  return (
    <ScrollView
      style={st.screen}
      contentContainerStyle={{ padding: space.md, paddingTop: 60, gap: space.md, paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
      keyboardShouldPersistTaps="handled"
    >
      {/* Page title */}
      <View style={{ gap: 2 }}>
        <Text style={st.title}>My trips</Text>
        <Text style={st.sub}>Show the reference at the island’s front desk</Text>
      </View>

      {/* Sign-in nudge (bookings follow the account to any phone) */}
      {!account && (
        <Pressable onPress={onSignIn} style={st.nudge}>
          <Ionicons name="logo-google" size={20} color={colors.onLight} />
          <Text style={st.nudgeText}>Sign in with Google to see your trips on any phone</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.onLight} />
        </Pressable>
      )}

      <Pills options={['List', 'Calendar']} value={view} onChange={setView} />

      {view === 'Calendar' ? <Timeline bookings={bookings.filter((b) => ACTIVE.has(b.status))} onOpen={onOpen} /> : (
        <View style={{ gap: space.md }}>
          {!loading && rows.length === 0 && (
            <View style={st.empty}>
              <Ionicons name="ticket-outline" size={34} color={colors.muted} />
              <Text style={st.emptyText}>No bookings yet.</Text>
            </View>
          )}
          {rows.map((item) => (item.booking ? (
            // A loaded booking: tap to open the confirmation screen.
            <Pressable key={item.reference} onPress={() => onOpen(item.booking!)} style={({ pressed }) => [st.card, pressed && { opacity: 0.9 }]}>
              <PackageImage packageId={item.booking.package_id === 'custom' ? item.booking.island_id : item.booking.package_id} style={st.thumb} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={st.ref}>{item.reference}</Text>
                <Text style={st.name} numberOfLines={1}>{item.booking.package_name}</Text>
                <Text style={st.meta}>
                  {prettyDay(item.booking.day)}{item.booking.end_day && item.booking.end_day !== item.booking.day ? ` – ${prettyDay(item.booking.end_day)}` : ''} · {item.booking.guests} guest{item.booking.guests > 1 ? 's' : ''} · {peso(item.booking.total_php)}
                </Text>
                <StatusBadge status={item.booking.status} />
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </Pressable>
          ) : (
            // A reference that failed to load (island offline, or deleted).
            <View key={item.reference} style={[st.card, { flexDirection: 'column', alignItems: 'flex-start' }]}>
              <Text style={st.ref}>{item.reference}</Text>
              <Text style={st.meta}>{item.error}</Text>
              <Pressable onPress={() => forget(item.reference)}><Text style={st.link}>Remove from this phone</Text></Pressable>
            </View>
          )))}
        </View>
      )}

      {/* Lookup form */}
      <View style={st.find}>
        <SectionTitle title="Find a booking" />
        <Field label="Reference" icon="pricetag-outline" value={ref} onChangeText={setRef} placeholder="e.g. MRP-7F3K2" autoCapitalize="characters" />
        <Field label="E-mail used when booking" icon="mail-outline" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <ErrorBox message={findError} />
        <Button label="Find booking" onPress={find} busy={finding} disabled={!ref.trim() || !email.trim()} icon="search" />
      </View>
    </ScrollView>
  );
}

// Calendar timeline: each reservation is a coloured bar across the days its
// services are used. Tap a day to list the trips on it.
function Timeline({ bookings, onOpen }: { bookings: Booking[]; onOpen: (b: Booking) => void }) {
  const first = bookings.map((b) => b.day).sort()[0] ?? isoDay(new Date());
  const [month, setMonth] = useState(() => { const d = parseDay(first); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [picked, setPicked] = useState<string | null>(null);
  const colorOf = useMemo(() => Object.fromEntries(bookings.map((b, i) => [b.reference, BAR_COLORS[i % BAR_COLORS.length]])), [bookings]);
  const on = (d: string) => bookings.filter((b) => d >= b.day && d <= (b.end_day || b.day));

  const lead = (month.getDay() + 6) % 7;
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysIn }, (_, i) => isoDay(new Date(month.getFullYear(), month.getMonth(), i + 1))),
  ];
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const list = picked ? on(picked) : bookings.filter((b) => (b.end_day || b.day) >= isoDay(month) && b.day < isoDay(new Date(month.getFullYear(), month.getMonth() + 1, 1)));

  return (
    <View style={st.timeline}>
      <View style={st.calHead}>
        <Pressable onPress={() => shift(-1)} hitSlop={10}><Ionicons name="chevron-back" size={22} color={colors.ink} /></Pressable>
        <Text style={st.calMonth}>{month.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</Text>
        <Pressable onPress={() => shift(1)} hitSlop={10}><Ionicons name="chevron-forward" size={22} color={colors.ink} /></Pressable>
      </View>
      <View style={st.weekRow}>{WEEK.map((w, i) => <Text key={i} style={st.week}>{w}</Text>)}</View>
      <View style={st.grid}>
        {cells.map((d, i) => {
          if (!d) return <View key={`b${i}`} style={st.cell} />;
          const here = on(d);
          return (
            <Pressable key={d} style={[st.cell, picked === d && st.cellPicked]} onPress={() => setPicked(picked === d ? null : d)}>
              <Text style={[st.cellNum, d === isoDay(new Date()) && { color: colors.primary, fontWeight: '800' }]}>{parseDay(d).getDate()}</Text>
              {/* One bar per reservation that uses services this day */}
              {here.slice(0, 3).map((b) => (
                <View key={b.reference} style={[st.bar, { backgroundColor: colorOf[b.reference] },
                  d === b.day && st.barStart, d === (b.end_day || b.day) && st.barEnd]} />
              ))}
            </Pressable>
          );
        })}
      </View>
      <Text style={st.listHead}>{picked ? `On ${prettyDay(picked)}` : 'This month'}</Text>
      {list.length === 0 ? <Text style={st.meta}>No trips{picked ? ' on this day' : ' this month'}.</Text> : list.map((b) => (
        <Pressable key={b.reference} onPress={() => onOpen(b)} style={st.tlRow}>
          <View style={[st.dot, { backgroundColor: colorOf[b.reference] }]} />
          <View style={{ flex: 1 }}>
            <Text style={st.name} numberOfLines={1}>{b.package_name}</Text>
            <Text style={st.meta}>{prettyDay(b.day)}{b.end_day && b.end_day !== b.day ? ` – ${prettyDay(b.end_day)}` : ''} · {b.days ?? 1} day(s) · {b.reference}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
      ))}
    </View>
  );
}

// Styles for this screen.
const st = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.ink, fontSize: 28, fontWeight: '800' },
  sub: { color: colors.muted },
  nudge: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.sun, borderRadius: radius.md, padding: 14 },
  nudgeText: { flex: 1, color: colors.onLight, fontWeight: '700' },
  empty: { alignItems: 'center', gap: 8, marginVertical: space.md },
  emptyText: { color: colors.muted },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 10, ...shadow, shadowOpacity: 0.06 },
  thumb: { width: 76, height: 92, borderRadius: 14 },
  ref: { color: colors.primary, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  name: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 12 },
  link: { color: colors.primary, fontWeight: '700', marginTop: 4 },
  find: { gap: space.sm, marginTop: space.lg },

  // Timeline calendar
  timeline: { backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, gap: 6, ...shadow, shadowOpacity: 0.06 },
  calHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  calMonth: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  weekRow: { flexDirection: 'row' },
  week: { flex: 1, textAlign: 'center', color: colors.muted, fontWeight: '600', fontSize: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, minHeight: 52, paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.line, gap: 2 },
  cellPicked: { backgroundColor: colors.skySoft },
  cellNum: { textAlign: 'center', color: colors.ink, fontSize: 13 },
  bar: { height: 6 },
  barStart: { marginLeft: 3, borderTopLeftRadius: 3, borderBottomLeftRadius: 3 },
  barEnd: { marginRight: 3, borderTopRightRadius: 3, borderBottomRightRadius: 3 },
  listHead: { color: colors.ink, fontWeight: '800', marginTop: space.sm },
  tlRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
  dot: { width: 12, height: 12, borderRadius: 6 },
}));
