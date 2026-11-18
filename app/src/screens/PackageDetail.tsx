/**
 * app/src/screens/PackageDetail.tsx
 *
 * A resort / tour page: big picture (with a gallery when there are several
 * photos), name, place and information. Then the guest chooses how to book:
 *
 *  - Package: the ready package. Guests, the reservation timeline on a
 *    calendar coloured by availability, extra days (each adds the extra-day
 *    fee). A switched-off service shows shaded with a red "unavailable" note.
 *  - Build your own: a checklist of THIS island's services and activities
 *    (live from the island, so services an island admin adds appear at once).
 *    Tick what you want, set quantities and dates; the price is each
 *    service's day price × quantity × days.
 *
 * The bottom bar shows the total and "Book now". Changing anything asks the
 * island again, so prices and availability are always what it can sell.
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { packageCalendar, quote, searchPackages, type Package, type Service, type Trip } from '../api';
import { PackageImage, photosFor } from '../scene';
import { colors, peso, radius, shadow, space, themed } from '../theme';
import { addDays, Button, daysBetween, ErrorBox, Ionicons, isoDay, RangeSheet, RoundButton, Stepper, tripDates, type DayStatus } from '../ui';

const TODAY = isoDay(new Date());
const LAST_DAY = addDays(TODAY, 59);
const UNIT = { person: 'per person', room: 'per room', trip: 'per trip' } as const;
type Mode = 'package' | 'custom';

export function PackageDetail({ pkg: initial, onBack, onBook }: {
  pkg: Package;
  onBack: () => void;
  onBook: (t: Trip) => void;
}) {
  // Package or build-your-own.
  const [mode, setMode] = useState<Mode>('package');
  // Latest copy of the package, and the island's services checklist.
  const [pkg, setPkg] = useState(initial);
  const [services, setServices] = useState<Service[]>([]);
  // Shared choices: guests and first day.
  const [guests, setGuests] = useState(Math.min(2, initial.max_guests));
  const [day, setDay] = useState(initial.day);
  // Package: extra days. Build your own: last day and quantities (0 = not ticked).
  const [extra, setExtra] = useState(0);
  const [customEnd, setCustomEnd] = useState(initial.day);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [customTotal, setCustomTotal] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, { status: DayStatus; note: string | null }>>({});
  const [more, setMore] = useState(false);
  // Photos (gallery) and the one on screen.
  const photos = photosFor(initial.id);
  const [photoIndex, setPhotoIndex] = useState(0);

  // Package length in calendar days: a day trip = 1 day (up to 12 h), a
  // 2D1N = 2 days. The chosen end day decides the extra days.
  const baseDays = pkg.nights + 1;
  const pkgEnd = addDays(day, baseDays - 1 + extra);
  const cEnd = customEnd < day ? day : customEnd; // never before the first day
  const customDays = daysBetween(day, cEnd) + 1;
  const endDay = mode === 'package' ? pkgEnd : cEnd;

  // Asks the island again: the package for these guests/days, and its
  // services for the build-your-own dates.
  useEffect(() => {
    let live = true;
    setLoading(true);
    searchPackages(day, guests, extra, customDays).then((r) => {
      if (!live) return;
      const fresh = r.packages.find((p) => p.id === initial.id);
      setServices(r.services.filter((s) => s.island_id === initial.island_id));
      if (fresh) { setPkg(fresh); setError(null); } else setError(`${initial.island_name} is offline right now, so it can't be booked online.`);
    }, (err) => live && setError((err as Error).message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [day, guests, extra, customDays, initial.id, initial.island_id, initial.island_name]);

  // Availability colours for the package calendar (60 days from today).
  useEffect(() => {
    packageCalendar(initial.id, TODAY, 60, guests)
      .then((r) => setStatuses(Object.fromEntries(r.days.map((d) => [d.day, { status: d.status, note: d.note }]))))
      .catch(() => setStatuses({}));
  }, [initial.id, guests]);

  // Ticked services that can still be booked for these dates.
  const chosen = useMemo(() => services.filter((s) => (qty[s.id] ?? 0) > 0 && s.available), [services, qty]);

  // Live price of the build-your-own selection from the island.
  useEffect(() => {
    if (mode !== 'custom' || !chosen.length) { setCustomTotal(null); return; }
    let live = true;
    quote({ kind: 'custom', islandId: initial.island_id, items: chosen.map((s) => ({ serviceId: s.id, qty: qty[s.id], name: s.name })), days: customDays, day, guests })
      .then((q) => live && setCustomTotal(q.total_php), (err) => live && setError((err as Error).message));
    return () => { live = false; };
  }, [mode, chosen, qty, customDays, day, guests, initial.island_id]);

  // Calendar change: first and last day.
  function onRange(start: string, end: string) {
    setDay(start);
    if (mode === 'package') setExtra(Math.max(0, daysBetween(start, end) - (baseDays - 1)));
    else setCustomEnd(end);
  }

  // Tick / untick a service: per-person ones start at the guest count.
  const toggle = (s: Service) => setQty((q) => ({ ...q, [s.id]: q[s.id] ? 0 : (s.unit === 'person' ? guests : 1) }));

  const offIds = new Set(pkg.unavailable_services.map((s) => s.id));
  const perGuest = pkg.pricing === 'per_guest';
  const total = mode === 'package' ? pkg.total_php : customTotal;
  const days = mode === 'package' ? baseDays + extra : customDays;
  const blocked = mode === 'package'
    ? !pkg.available || !!error || guests > pkg.max_guests
    : !chosen.length || customTotal === null || !!error;

  // The trip handed to the guest form.
  const trip: Trip = mode === 'package'
    ? { kind: 'package', title: pkg.name, islandId: pkg.island_id, islandName: pkg.island_name, imageId: pkg.id,
      packageId: pkg.id, extraDays: extra, day, endDay, days, guests, total: pkg.total_php }
    : { kind: 'custom', title: `Custom trip · ${pkg.island_name}`, islandId: pkg.island_id, islandName: pkg.island_name, imageId: pkg.id,
      items: chosen.map((s) => ({ serviceId: s.id, qty: qty[s.id], name: s.name })), day, endDay, days, guests, total: customTotal ?? 0 };

  return (
    <View style={st.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }} bounces={false}>
        {/* Hero picture with back button, island tag, photo thumbnails and price tag */}
        <View style={st.hero}>
          <PackageImage packageId={pkg.id} photo={photos[photoIndex]} style={StyleSheet.absoluteFill} />
          <View style={st.heroTop}>
            <RoundButton icon="chevron-back" onPress={onBack} />
            <View style={st.islandTag}><Text style={st.islandTagText}>{pkg.island_name}</Text></View>
          </View>
          {photos.length > 1 && (
            <View style={st.thumbs}>
              {photos.map((p, i) => (
                <Pressable key={i} onPress={() => setPhotoIndex(i)} style={[st.thumb, i === photoIndex && st.thumbOn]}>
                  <Image source={p} style={st.thumbImg} />
                </Pressable>
              ))}
            </View>
          )}
          {mode === 'package' && (
            <View style={st.priceTag}>
              <Text style={st.priceText}>{peso(pkg.price_php)}</Text>
              <Text style={st.priceUnit}>{perGuest ? 'per guest' : 'per package'}</Text>
            </View>
          )}
        </View>

        {/* Rounded sheet with the details */}
        <View style={st.sheet}>
          <Text style={st.name}>{pkg.name}</Text>
          <View style={st.place}>
            <Ionicons name="location-outline" size={15} color={colors.muted} />
            <Text style={st.placeText}>{pkg.location} · {pkg.island_name}</Text>
          </View>

          {/* Information with "Read more" */}
          <Text style={st.desc} numberOfLines={more ? undefined : 3}>{pkg.description}</Text>
          {pkg.description.length > 120 && (
            <Pressable onPress={() => setMore(!more)}><Text style={st.more}>{more ? 'Show less' : 'Read more'}</Text></Pressable>
          )}

          {/* The choice: ready package, or build your own from the checklist */}
          <View style={st.seg}>
            {(['package', 'custom'] as Mode[]).map((m) => (
              <Pressable key={m} onPress={() => setMode(m)} style={[st.segBtn, mode === m && st.segOn]}>
                <Ionicons name={m === 'package' ? 'gift-outline' : 'options-outline'} size={16} color={mode === m ? '#fff' : colors.ink} />
                <Text style={[st.segText, mode === m && st.segTextOn]}>{m === 'package' ? 'Package' : 'Build your own'}</Text>
              </Pressable>
            ))}
          </View>

          {mode === 'package' ? (
            <>
              {/* Quick facts (no "spots left" count, just available or why not) */}
              <View style={st.facts}>
                <Fact icon={pkg.nights ? 'moon-outline' : 'sunny-outline'} text={pkg.nights ? `${pkg.nights} night${pkg.nights > 1 ? 's' : ''}` : 'Day trip · up to 12 h'} />
                <Fact icon="people-outline" text={`Up to ${pkg.max_guests}`} />
                <Fact icon={pkg.available ? 'checkmark-circle-outline' : 'close-circle-outline'} text={pkg.available ? 'Available' : pkg.reason ?? 'Unavailable'} warn={!pkg.available} />
              </View>

              {/* What the package includes; a switched-off service is shaded with a red note */}
              <Text style={st.h}>Included</Text>
              <View style={{ gap: 8 }}>
                {pkg.items.map((i) => {
                  const off = offIds.has(i.service_id);
                  return (
                    <View key={i.service_id} style={[st.item, off && st.itemOff]}>
                      <View style={[st.check, off && { backgroundColor: '#F6DDD6' }]}>
                        <Ionicons name={off ? 'close' : 'checkmark'} size={14} color={off ? colors.danger : colors.primary} />
                      </View>
                      <Text style={[st.itemText, off && st.itemTextOff]}>{i.name}{i.qty > 1 ? ` × ${i.qty}` : ''}{i.per_guest ? ' per guest' : ''}</Text>
                      {off && <Text style={st.offNote}>Unavailable</Text>}
                    </View>
                  );
                })}
              </View>
            </>
          ) : (
            <>
              {/* Build your own: this island's services and activities */}
              <Text style={st.h}>Choose services & activities</Text>
              <Text style={st.hint}>From {pkg.island_name}. Prices are per day.</Text>
              <View style={{ gap: 10 }}>
                {services.length === 0 && !loading && <Text style={st.hint}>No services listed yet.</Text>}
                {services.map((s) => {
                  const on = (qty[s.id] ?? 0) > 0 && s.available;
                  return (
                    <View key={s.id} style={[st.svc, on && st.svcOn, !s.available && st.svcOff]}>
                      <Pressable onPress={() => s.available && toggle(s)} style={st.svcMain} disabled={!s.available}>
                        <Ionicons name={on ? 'checkbox' : 'square-outline'} size={24} color={!s.available ? '#C3CCD1' : on ? colors.primary : colors.muted} />
                        <View style={{ flex: 1 }}>
                          <Text style={[st.svcName, !s.available && st.itemTextOff]}>{s.name}</Text>
                          <Text style={st.svcPrice}>{peso(s.price_php)} {UNIT[s.unit]} per day</Text>
                          {!s.available && <Text style={st.offNote}>{s.reason ?? 'Unavailable'}</Text>}
                        </View>
                      </Pressable>
                      {on && <Stepper value={qty[s.id]} min={1} max={50} onChange={(n) => setQty((q) => ({ ...q, [s.id]: n }))} />}
                    </View>
                  );
                })}
              </View>
            </>
          )}

          {/* Guests */}
          <Text style={st.h}>Guests</Text>
          <View style={st.guestRow}>
            <Text style={st.hint}>
              {mode === 'custom' ? 'Per-person services start at this number' : perGuest ? `${peso(pkg.price_php)} per guest` : `One price for up to ${pkg.max_guests} guests`}
            </Text>
            <Stepper value={guests} min={1} max={mode === 'package' ? pkg.max_guests : 20} onChange={setGuests} />
          </View>

          {/* Reservation timeline (calendar) */}
          <Text style={st.h}>Reservation dates</Text>
          <Pressable onPress={() => setCalendar(true)} style={st.dateRow}>
            <Ionicons name="calendar-outline" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={st.dateText}>{tripDates(day, daysBetween(day, endDay))}</Text>
              <Text style={st.dateSub}>
                {days} day{days > 1 ? 's' : ''} of service
                {mode === 'package' && extra ? ` · ${extra} extra (+${peso(extra * pkg.extra_day_php * (perGuest ? guests : 1))})` : ''}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
          <Text style={st.feeNote}>
            {mode === 'package'
              ? `Want to stay longer? Each extra day adds ${peso(pkg.extra_day_php)}${perGuest ? ' per guest' : ''}. `
              : 'Each chosen service is reserved for every day of your stay. '}
            Cancel before your trip date for a full refund (half on the day itself).
          </Text>

          {error ? <ErrorBox message={error} />
            : mode === 'package' && !pkg.available ? <ErrorBox message={`${pkg.reason ?? 'Not available'} on these dates. Try other dates or build your own.`} /> : null}
        </View>
      </ScrollView>

      {/* Bottom bar: total + Book now */}
      <View style={st.bar}>
        <View>
          <Text style={st.barLabel}>Total</Text>
          {loading ? <ActivityIndicator color={colors.primary} /> : <Text style={st.barTotal}>{total === null ? '—' : peso(total)}</Text>}
          <Text style={st.barSub}>
            {mode === 'custom' ? `${chosen.length} service${chosen.length === 1 ? '' : 's'} · ` : ''}{guests} guest{guests > 1 ? 's' : ''} · {days} day{days > 1 ? 's' : ''}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Book now" variant="accent" onPress={() => onBook(trip)} disabled={blocked || loading} />
        </View>
      </View>

      <RangeSheet
        open={calendar} onClose={() => setCalendar(false)} start={day} end={endDay} min={TODAY} max={LAST_DAY}
        minDays={mode === 'package' ? baseDays : 1} statuses={mode === 'package' ? statuses : undefined} onChange={onRange}
        summary={`${tripDates(day, daysBetween(day, endDay))} · ${days} day(s)${mode === 'package' && extra ? ` · ${extra} extra` : ''}`}
      />
    </View>
  );
}

// Small icon + text fact chip.
function Fact({ icon, text, warn }: { icon: keyof typeof Ionicons.glyphMap; text: string; warn?: boolean }) {
  return (
    <View style={[st.fact, warn && { backgroundColor: '#FBE7E1' }]}>
      <Ionicons name={icon} size={16} color={warn ? colors.danger : colors.primary} />
      <Text style={[st.factText, warn && { color: colors.danger }]}>{text}</Text>
    </View>
  );
}

// Styles for this screen.
const st = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.card },
  hero: { height: 340, backgroundColor: colors.sky },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 52, paddingHorizontal: space.md },
  islandTag: { backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  islandTagText: { color: colors.onLight, fontWeight: '700', fontSize: 12 },
  thumbs: { position: 'absolute', left: space.md, top: 110, gap: 10 },
  thumb: { width: 54, height: 54, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.7)', overflow: 'hidden' },
  thumbOn: { borderColor: '#fff', borderWidth: 3 },
  thumbImg: { width: '100%', height: '100%' },
  priceTag: { position: 'absolute', right: space.md, bottom: 44, backgroundColor: colors.accent, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center', ...shadow },
  priceText: { color: colors.onLight, fontWeight: '800', fontSize: 18 },
  priceUnit: { color: colors.onLight, fontSize: 11 },

  sheet: { marginTop: -28, backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, gap: 8 },
  name: { color: colors.ink, fontSize: 24, fontWeight: '800' },
  place: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  placeText: { color: colors.muted },
  desc: { color: colors.muted, lineHeight: 22, marginTop: 4 },
  more: { color: colors.primary, fontWeight: '700' },

  // Package / Build your own switch
  seg: { flexDirection: 'row', backgroundColor: colors.skySoft, borderRadius: radius.pill, padding: 4, marginTop: space.md },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: radius.pill },
  segOn: { backgroundColor: colors.primary },
  segText: { color: colors.ink, fontWeight: '700' },
  segTextOn: { color: '#fff' },

  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.skySoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 },
  factText: { color: colors.ink, fontWeight: '600', fontSize: 13 },
  h: { color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: space.md },
  hint: { color: colors.muted, flex: 1 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 6, borderRadius: 10 },
  itemOff: { backgroundColor: colors.offBg },
  check: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.skySoft, alignItems: 'center', justifyContent: 'center' },
  itemText: { color: colors.ink, flex: 1 },
  itemTextOff: { color: '#9AA6AD', textDecorationLine: 'line-through' },
  offNote: { color: colors.danger, fontWeight: '800', fontSize: 12 },

  // Services checklist
  svc: { backgroundColor: colors.card, borderRadius: radius.md, padding: 12, borderWidth: 1.5, borderColor: colors.line, gap: 10 },
  svcOn: { borderColor: colors.primary },
  svcOff: { backgroundColor: colors.offBg },
  svcMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  svcName: { color: colors.ink, fontWeight: '700', fontSize: 15 },
  svcPrice: { color: colors.muted, fontSize: 13 },

  guestRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: 14 },
  dateText: { color: colors.ink, fontWeight: '700' },
  dateSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  feeNote: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: space.sm },

  bar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: colors.card, paddingHorizontal: space.md, paddingTop: 12, paddingBottom: 28, borderTopWidth: 1, borderTopColor: colors.line,
  },
  barLabel: { color: colors.muted, fontSize: 12 },
  barTotal: { color: colors.primary, fontWeight: '800', fontSize: 22 },
  barSub: { color: colors.muted, fontSize: 11 },
}));
