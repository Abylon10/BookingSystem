/**
 * app/src/screens/BuildTrip.tsx
 *
 * Build your own trip on one island: a checklist of the island's services
 * (rooms, tours, boats…) with a quantity for each, the reservation dates on
 * a calendar (how many days the services are used), and the number of
 * guests. The price is each service's day price × quantity × days, checked
 * live with the island. A service that is switched off or full for those
 * dates is shaded with a red note and can't be ticked.
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { quote, searchPackages, type IslandStatus, type Service, type Trip } from '../api';
import { PackageImage } from '../scene';
import { colors, peso, radius, space } from '../theme';
import { addDays, Button, daysBetween, ErrorBox, Ionicons, isoDay, RangeSheet, Stepper, TopBar, tripDates } from '../ui';

const TODAY = isoDay(new Date());
const LAST_DAY = addDays(TODAY, 59);
const UNIT = { person: 'per person', room: 'per room', trip: 'per trip' } as const;

export function BuildTrip({ island, startDay, onBack, onContinue }: {
  island: IslandStatus; startDay: string; onBack: () => void; onContinue: (t: Trip) => void;
}) {
  const [day, setDay] = useState(startDay);
  const [end, setEnd] = useState(startDay);
  const [guests, setGuests] = useState(2);
  const [services, setServices] = useState<Service[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({}); // 0 / missing = not chosen
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [calendar, setCalendar] = useState(false);
  const days = daysBetween(day, end) + 1;

  // The island's services for these dates (availability for every day).
  useEffect(() => {
    setLoading(true);
    searchPackages(day, guests, 0, days)
      .then((r) => {
        setServices(r.services.filter((s) => s.island_id === island.id));
        setError(r.islands.find((i) => i.id === island.id)?.status === 'online' ? null : `${island.name ?? island.id} is offline right now.`);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [day, days, guests, island.id, island.name]);

  // Chosen services (quantity > 0 and still available).
  const chosen = useMemo(() => services.filter((s) => (qty[s.id] ?? 0) > 0 && s.available), [services, qty]);

  // Live price from the island whenever the selection changes.
  useEffect(() => {
    if (!chosen.length) { setTotal(null); return; }
    let live = true;
    quote({ kind: 'custom', islandId: island.id, items: chosen.map((s) => ({ serviceId: s.id, qty: qty[s.id], name: s.name })), days, day, guests })
      .then((q) => live && setTotal(q.total_php), (err) => live && setError((err as Error).message));
    return () => { live = false; };
  }, [chosen, qty, days, day, guests, island.id]);

  // Tick / untick a service: per-person services default to the guest count.
  const toggle = (s: Service) => setQty((q) => ({ ...q, [s.id]: q[s.id] ? 0 : (s.unit === 'person' ? guests : 1) }));

  const trip: Trip = {
    kind: 'custom', title: `Custom trip · ${island.name ?? island.id}`, islandId: island.id, islandName: island.name ?? island.id,
    imageId: island.id, items: chosen.map((s) => ({ serviceId: s.id, qty: qty[s.id], name: s.name })),
    day, endDay: end, days, guests, total: total ?? 0,
  };

  return (
    <View style={st.screen}>
      <TopBar title="Build your own trip" onBack={onBack} />
      <ScrollView contentContainerStyle={st.body}>
        {/* Island banner */}
        <View style={st.banner}>
          <PackageImage packageId={island.id === 'biliran' ? 'falls' : island.id === 'higatangan' ? 'sandbar' : 'island'} style={StyleSheet.absoluteFill} />
          <View style={st.bannerShade} />
          <Text style={st.bannerTitle}>{island.name}</Text>
          <Text style={st.bannerSub}>Choose the services you want, for as many days as you like.</Text>
        </View>

        {/* Dates and guests */}
        <Pressable onPress={() => setCalendar(true)} style={st.dateRow}>
          <Ionicons name="calendar-outline" size={20} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={st.dateText}>{tripDates(day, daysBetween(day, end))}</Text>
            <Text style={st.dateSub}>{days} day{days > 1 ? 's' : ''} of service</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
        <View style={st.guestRow}>
          <Text style={st.h}>Guests</Text>
          <Stepper value={guests} min={1} max={20} onChange={setGuests} />
        </View>

        {/* Services checklist */}
        <Text style={st.h}>Services</Text>
        {loading && <ActivityIndicator color={colors.primary} />}
        <ErrorBox message={error} />
        <View style={{ gap: 10 }}>
          {services.map((s) => {
            const on = (qty[s.id] ?? 0) > 0 && s.available;
            return (
              <View key={s.id} style={[st.svc, on && st.svcOn, !s.available && st.svcOff]}>
                <Pressable onPress={() => s.available && toggle(s)} style={st.svcMain} disabled={!s.available}>
                  <Ionicons name={on ? 'checkbox' : 'square-outline'} size={24} color={!s.available ? '#C3CCD1' : on ? colors.primary : colors.muted} />
                  <View style={{ flex: 1 }}>
                    <Text style={[st.svcName, !s.available && st.svcNameOff]}>{s.name}</Text>
                    <Text style={st.svcPrice}>{peso(s.price_php)} {UNIT[s.unit]} per day</Text>
                    {!s.available && <Text style={st.svcOffNote}>{s.reason ?? 'Unavailable'}</Text>}
                  </View>
                </Pressable>
                {on && <Stepper value={qty[s.id]} min={1} max={50} onChange={(n) => setQty((q) => ({ ...q, [s.id]: n }))} />}
              </View>
            );
          })}
        </View>
      </ScrollView>

      {/* Bottom bar: total + continue */}
      <View style={st.bar}>
        <View>
          <Text style={st.barLabel}>Total</Text>
          <Text style={st.barTotal}>{total === null ? '—' : peso(total)}</Text>
          <Text style={st.barSub}>{chosen.length} service{chosen.length === 1 ? '' : 's'} · {days} day{days > 1 ? 's' : ''}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Continue" variant="accent" onPress={() => onContinue(trip)} disabled={!chosen.length || total === null || !!error} />
        </View>
      </View>

      <RangeSheet open={calendar} onClose={() => setCalendar(false)} start={day} end={end} min={TODAY} max={LAST_DAY}
        onChange={(a, b) => { setDay(a); setEnd(b); }} summary={`${tripDates(day, daysBetween(day, end))} · ${days} day(s)`} />
    </View>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.md, gap: space.md, paddingBottom: 150 },
  banner: { height: 150, borderRadius: radius.md, overflow: 'hidden', justifyContent: 'flex-end', padding: space.md },
  bannerShade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(1,60,88,0.45)' },
  bannerTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  bannerSub: { color: '#E3F6FC', fontSize: 13 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, padding: 14 },
  dateText: { color: colors.ink, fontWeight: '700' },
  dateSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  guestRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  svc: { backgroundColor: '#fff', borderRadius: radius.md, padding: 12, borderWidth: 1.5, borderColor: 'transparent', gap: 10 },
  svcOn: { borderColor: colors.primary },
  svcOff: { backgroundColor: '#F2F2F2' },
  svcMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  svcName: { color: colors.ink, fontWeight: '700', fontSize: 15 },
  svcNameOff: { color: '#9AA6AD', textDecorationLine: 'line-through' },
  svcPrice: { color: colors.muted, fontSize: 13 },
  svcOffNote: { color: colors.danger, fontWeight: '800', fontSize: 12, marginTop: 2 },
  bar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: '#fff', paddingHorizontal: space.md, paddingTop: 12, paddingBottom: 28, borderTopWidth: 1, borderTopColor: colors.line,
  },
  barLabel: { color: colors.muted, fontSize: 12 },
  barTotal: { color: colors.primary, fontWeight: '800', fontSize: 22 },
  barSub: { color: colors.muted, fontSize: 11 },
});
