/**
 * app/src/screens/PackageDetail.tsx
 *
 * Package detail: big picture with the price tag, then a rounded sheet with
 * the name, place, information and what's included. Then the reservation:
 *  - guests (chosen here, not on the home screen),
 *  - the reservation timeline on a calendar coloured by availability; the
 *    guest can keep the services longer than the package (extra days, each
 *    adding the extra-day fee),
 *  - a switched-off service is shown shaded with a red "unavailable" note.
 * The bottom bar shows the total and "Book now".
 *
 * Changing guests or dates asks central again, so price and availability
 * are always what the island can actually sell.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { packageCalendar, searchPackages, type Package, type Trip } from '../api';
import { PackageImage, photosFor } from '../scene';
import { colors, peso, radius, shadow, space } from '../theme';
import { addDays, Button, daysBetween, ErrorBox, Ionicons, isoDay, RangeSheet, RoundButton, Stepper, tripDates, type DayStatus } from '../ui';

const TODAY = isoDay(new Date());
const LAST_DAY = addDays(TODAY, 59);

export function PackageDetail({ pkg: initial, onBack, onBook }: {
  pkg: Package;
  onBack: () => void;
  onBook: (t: Trip) => void;
}) {
  // Latest copy of the package for the chosen date / guests / extra days.
  const [pkg, setPkg] = useState(initial);
  const [guests, setGuests] = useState(Math.min(2, initial.max_guests));
  const [day, setDay] = useState(initial.day);
  const [extra, setExtra] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, { status: DayStatus; note: string | null }>>({});
  const [more, setMore] = useState(false);
  // Package photos (gallery) and the one on screen.
  const photos = photosFor(initial.id);
  const [photoIndex, setPhotoIndex] = useState(0);

  // Shortest booking in calendar days: a day trip = 1 day (up to 12 h), a
  // 2D1N = 2 days. The chosen end day decides the extra days.
  const baseDays = pkg.nights + 1;
  const endDay = addDays(day, baseDays - 1 + extra);

  // Re-checks price and availability on the island.
  useEffect(() => {
    let live = true;
    setLoading(true);
    searchPackages(day, guests, extra).then((r) => {
      if (!live) return;
      const fresh = r.packages.find((p) => p.id === initial.id);
      if (fresh) { setPkg(fresh); setError(null); } else setError(`${initial.island_name} is offline right now, so this package can't be booked online.`);
    }, (err) => live && setError((err as Error).message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [day, guests, extra, initial.id, initial.island_name]);

  // Availability colours for the calendar (60 days from today).
  useEffect(() => {
    packageCalendar(initial.id, TODAY, 60, guests)
      .then((r) => setStatuses(Object.fromEntries(r.days.map((d) => [d.day, { status: d.status, note: d.note }]))))
      .catch(() => setStatuses({}));
  }, [initial.id, guests]);

  // Calendar change: first day + last day -> day and extra days.
  function onRange(start: string, end: string) {
    setDay(start);
    setExtra(Math.max(0, daysBetween(start, end) - (baseDays - 1)));
  }

  const blocked = !pkg.available || !!error || guests > pkg.max_guests;
  const offIds = new Set(pkg.unavailable_services.map((s) => s.id));
  const perGuest = pkg.pricing === 'per_guest';

  // The trip handed to the guest form.
  const trip: Trip = {
    kind: 'package', title: pkg.name, islandId: pkg.island_id, islandName: pkg.island_name, imageId: pkg.id,
    packageId: pkg.id, extraDays: extra, day, endDay, days: baseDays + extra, guests, total: pkg.total_php,
  };

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
          {/* Gallery: tap a thumbnail to show that photo (reference design) */}
          {photos.length > 1 && (
            <View style={st.thumbs}>
              {photos.map((p, i) => (
                <Pressable key={i} onPress={() => setPhotoIndex(i)} style={[st.thumb, i === photoIndex && st.thumbOn]}>
                  <Image source={p} style={st.thumbImg} />
                </Pressable>
              ))}
            </View>
          )}
          <View style={st.priceTag}>
            <Text style={st.priceText}>{peso(pkg.price_php)}</Text>
            <Text style={st.priceUnit}>{perGuest ? 'per guest' : 'per package'}</Text>
          </View>
        </View>

        {/* Rounded sheet with the details */}
        <View style={st.sheet}>
          <Text style={st.name}>{pkg.name}</Text>
          <View style={st.place}>
            <Ionicons name="location-outline" size={15} color={colors.muted} />
            <Text style={st.placeText}>{pkg.location} · {pkg.island_name}</Text>
          </View>

          {/* Quick facts (no "spots left" count, just available or why not) */}
          <View style={st.facts}>
            <Fact icon={pkg.nights ? 'moon-outline' : 'sunny-outline'} text={pkg.nights ? `${pkg.nights} night${pkg.nights > 1 ? 's' : ''}` : 'Day trip · up to 12 h'} />
            <Fact icon="people-outline" text={`Up to ${pkg.max_guests}`} />
            <Fact icon={pkg.available ? 'checkmark-circle-outline' : 'close-circle-outline'} text={pkg.available ? 'Available' : pkg.reason ?? 'Unavailable'} warn={!pkg.available} />
          </View>

          {/* Information with "Read more" */}
          <Text style={st.h}>Information</Text>
          <Text style={st.desc} numberOfLines={more ? undefined : 3}>{pkg.description}</Text>
          {pkg.description.length > 120 && (
            <Pressable onPress={() => setMore(!more)}><Text style={st.more}>{more ? 'Show less' : 'Read more'}</Text></Pressable>
          )}

          {/* Included services; a switched-off one is shaded with a red note */}
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

          {/* Guests (only here, after choosing the package) */}
          <Text style={st.h}>Guests</Text>
          <View style={st.guestRow}>
            <Text style={st.guestHint}>{perGuest ? `${peso(pkg.price_php)} per guest` : `One price for up to ${pkg.max_guests} guests`}</Text>
            <Stepper value={guests} min={1} max={pkg.max_guests} onChange={setGuests} />
          </View>

          {/* Reservation timeline (calendar) */}
          <Text style={st.h}>Reservation dates</Text>
          <Pressable onPress={() => setCalendar(true)} style={st.dateRow}>
            <Ionicons name="calendar-outline" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={st.dateText}>{tripDates(day, daysBetween(day, endDay))}</Text>
              <Text style={st.dateSub}>{baseDays + extra} day{baseDays + extra > 1 ? 's' : ''} of service{extra ? ` · ${extra} extra (+${peso(extra * pkg.extra_day_php * (perGuest ? guests : 1))})` : ''}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
          <Text style={st.feeNote}>
            Want to stay longer? Each extra day adds {peso(pkg.extra_day_php)}{perGuest ? ' per guest' : ''}. Cancel before your trip date for a full refund (half on the day itself).
          </Text>

          {error ? <ErrorBox message={error} /> : !pkg.available ? <ErrorBox message={`${pkg.reason ?? 'Not available'} on these dates. Try other dates.`} /> : null}
        </View>
      </ScrollView>

      {/* Bottom bar: total + Book now */}
      <View style={st.bar}>
        <View>
          <Text style={st.barLabel}>Total</Text>
          {loading ? <ActivityIndicator color={colors.primary} /> : <Text style={st.barTotal}>{peso(pkg.total_php)}</Text>}
          <Text style={st.barSub}>{guests} guest{guests > 1 ? 's' : ''} · {baseDays + extra} day{baseDays + extra > 1 ? 's' : ''}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Book now" variant="accent" onPress={() => onBook(trip)} disabled={blocked || loading} />
        </View>
      </View>

      <RangeSheet
        open={calendar} onClose={() => setCalendar(false)} start={day} end={endDay} min={TODAY} max={LAST_DAY}
        minDays={baseDays} statuses={statuses} onChange={onRange}
        summary={`${tripDates(day, daysBetween(day, endDay))} · ${baseDays + extra} day(s)${extra ? ` · ${extra} extra` : ''}`}
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
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  hero: { height: 340, backgroundColor: colors.sky },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 52, paddingHorizontal: space.md },
  islandTag: { backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  islandTagText: { color: colors.ink, fontWeight: '700', fontSize: 12 },
  thumbs: { position: 'absolute', left: space.md, top: 110, gap: 10 },
  thumb: { width: 54, height: 54, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.7)', overflow: 'hidden' },
  thumbOn: { borderColor: '#fff', borderWidth: 3 },
  thumbImg: { width: '100%', height: '100%' },
  priceTag: { position: 'absolute', right: space.md, bottom: 44, backgroundColor: colors.accent, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center', ...shadow },
  priceText: { color: colors.ink, fontWeight: '800', fontSize: 18 },
  priceUnit: { color: colors.ink, fontSize: 11 },

  sheet: { marginTop: -28, backgroundColor: '#fff', borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, gap: 8 },
  name: { color: colors.ink, fontSize: 24, fontWeight: '800' },
  place: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  placeText: { color: colors.muted },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.skySoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 },
  factText: { color: colors.ink, fontWeight: '600', fontSize: 13 },
  h: { color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: space.md },
  desc: { color: colors.muted, lineHeight: 22 },
  more: { color: colors.primary, fontWeight: '700' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 6, borderRadius: 10 },
  itemOff: { backgroundColor: '#F2F2F2' },
  check: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.skySoft, alignItems: 'center', justifyContent: 'center' },
  itemText: { color: colors.ink, flex: 1 },
  itemTextOff: { color: '#9AA6AD', textDecorationLine: 'line-through' },
  offNote: { color: colors.danger, fontWeight: '800', fontSize: 12 },
  guestRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  guestHint: { color: colors.muted, flex: 1 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: 14 },
  dateText: { color: colors.ink, fontWeight: '700' },
  dateSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  feeNote: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: space.sm },

  bar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: '#fff', paddingHorizontal: space.md, paddingTop: 12, paddingBottom: 28, borderTopWidth: 1, borderTopColor: colors.line,
  },
  barLabel: { color: colors.muted, fontSize: 12 },
  barTotal: { color: colors.primary, fontWeight: '800', fontSize: 22 },
  barSub: { color: colors.muted, fontSize: 11 },
});
