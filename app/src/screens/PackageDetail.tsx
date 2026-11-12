/**
 * app/src/screens/PackageDetail.tsx
 *
 * Package detail: big picture with the price tag, then a rounded sheet with
 * the name, place, information, what's included, and the date. The bottom
 * bar holds the guest stepper and "Book now" (reference design).
 *
 * Changing the date or guests asks central again, so the price and spots
 * shown are always what the island can actually sell.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { searchPackages, type Package } from '../api';
import { PackageImage } from '../scene';
import { colors, peso, radius, shadow, space } from '../theme';
import { addDays, Button, DateSheet, ErrorBox, Ionicons, isoDay, RoundButton, Stepper, tripDates } from '../ui';
import { unavailableReason } from './Explore';

const TODAY = isoDay(new Date());
const LAST_DAY = addDays(TODAY, 59);

export function PackageDetail({ pkg: initial, onBack, onBook, onChange }: {
  pkg: Package;
  onBack: () => void;
  onBook: (p: Package) => void;
  onChange: (day: string, guests: number) => void; // keeps Explore's filters in step
}) {
  // Latest copy of the package for the chosen date/guests.
  const [pkg, setPkg] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState(false);
  const [more, setMore] = useState(false);

  // Re-checks price and spots on the island when date or guests change.
  async function refresh(day: string, guests: number) {
    onChange(day, guests);
    setPkg((p) => ({ ...p, day, guests }));
    setLoading(true);
    try {
      const r = await searchPackages(day, guests);
      const fresh = r.packages.find((p) => p.id === initial.id);
      if (fresh) { setPkg(fresh); setError(null); } else setError(`${initial.island_name} is offline right now, so this package can't be booked online.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Keep the package in sync if the screen is reopened with another one.
  useEffect(() => setPkg(initial), [initial]);

  const reason = unavailableReason(pkg);
  const blocked = !!reason || !!error;

  return (
    <View style={st.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 130 }} bounces={false}>
        {/* Hero picture with back button, island tag and price tag */}
        <View style={st.hero}>
          <PackageImage packageId={pkg.id} style={StyleSheet.absoluteFill} />
          <View style={st.heroTop}>
            <RoundButton icon="chevron-back" onPress={onBack} />
            <View style={st.islandTag}><Text style={st.islandTagText}>{pkg.island_name}</Text></View>
          </View>
          <View style={st.priceTag}>
            <Text style={st.priceText}>{peso(pkg.price_php)}</Text>
            <Text style={st.priceUnit}>{pkg.pricing === 'per_guest' ? 'per guest' : 'per package'}</Text>
          </View>
        </View>

        {/* Rounded sheet with the details */}
        <View style={st.sheet}>
          <Text style={st.name}>{pkg.name}</Text>
          <View style={st.place}>
            <Ionicons name="location-outline" size={15} color={colors.muted} />
            <Text style={st.placeText}>{pkg.location} · {pkg.island_name}</Text>
          </View>

          {/* Quick facts */}
          <View style={st.facts}>
            <Fact icon={pkg.nights ? 'moon-outline' : 'sunny-outline'} text={pkg.nights ? `${pkg.nights} night${pkg.nights > 1 ? 's' : ''}` : 'Day trip'} />
            <Fact icon="people-outline" text={`Up to ${pkg.max_guests}`} />
            <Fact icon="ticket-outline" text={reason ?? `${pkg.spots} left`} warn={!!reason} />
          </View>

          {/* Information with "Read more" */}
          <Text style={st.h}>Information</Text>
          <Text style={st.desc} numberOfLines={more ? undefined : 3}>{pkg.description}</Text>
          {pkg.description.length > 120 && (
            <Pressable onPress={() => setMore(!more)}><Text style={st.more}>{more ? 'Show less' : 'Read more'}</Text></Pressable>
          )}

          {/* What the package includes */}
          <Text style={st.h}>Included</Text>
          <View style={{ gap: 8 }}>
            {pkg.items.map((i) => (
              <View key={i.service_id} style={st.item}>
                <View style={st.check}><Ionicons name="checkmark" size={14} color={colors.primary} /></View>
                <Text style={st.itemText}>{i.name}{i.qty > 1 ? ` × ${i.qty}` : ''}{i.per_guest ? ' per guest' : ''}</Text>
              </View>
            ))}
          </View>

          {/* Date (opens the calendar) */}
          <Text style={st.h}>Date</Text>
          <Pressable onPress={() => setCalendar(true)} style={st.dateRow}>
            <Ionicons name="calendar-outline" size={20} color={colors.primary} />
            <Text style={st.dateText}>{tripDates(pkg.day, pkg.nights)}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>

          {error ? <ErrorBox message={error} /> : reason ? <ErrorBox message={pkg.guests > pkg.max_guests ? `This package allows at most ${pkg.max_guests} guests.` : 'Fully booked on this date. Try another date.'} /> : null}
        </View>
      </ScrollView>

      {/* Bottom bar: guests + Book now with the total */}
      <View style={st.bar}>
        <View>
          <Text style={st.barLabel}>Guests</Text>
          <Stepper value={pkg.guests} min={1} max={8} onChange={(g) => refresh(pkg.day, g)} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={st.barTotal}>{loading ? ' ' : `Total ${peso(pkg.total_php)}`}</Text>
          {loading ? <ActivityIndicator color={colors.primary} style={{ height: 54 }} />
            : <Button label="Book now" variant="accent" onPress={() => onBook(pkg)} disabled={blocked} />}
        </View>
      </View>

      <DateSheet open={calendar} onClose={() => setCalendar(false)} value={pkg.day} min={TODAY} max={LAST_DAY} nights={pkg.nights} onChange={(d) => refresh(d, pkg.guests)} />
    </View>
  );
}

// Small icon + text fact chip.
function Fact({ icon, text, warn }: { icon: keyof typeof Ionicons.glyphMap; text: string; warn?: boolean }) {
  return (
    <View style={st.fact}>
      <Ionicons name={icon} size={16} color={warn ? colors.danger : colors.primary} />
      <Text style={[st.factText, warn && { color: colors.danger }]}>{text}</Text>
    </View>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  hero: { height: 360, backgroundColor: colors.sky },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 52, paddingHorizontal: space.md },
  islandTag: { backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  islandTagText: { color: colors.ink, fontWeight: '700', fontSize: 12 },
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
  item: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  check: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.skySoft, alignItems: 'center', justifyContent: 'center' },
  itemText: { color: colors.ink, flex: 1 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: 14, marginBottom: space.sm },
  dateText: { flex: 1, color: colors.ink, fontWeight: '600' },

  bar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'flex-end', gap: space.md,
    backgroundColor: '#fff', paddingHorizontal: space.md, paddingTop: 12, paddingBottom: 28, borderTopWidth: 1, borderTopColor: colors.line,
  },
  barLabel: { color: colors.ink, fontWeight: '700', marginBottom: 4, marginLeft: 6 },
  barTotal: { color: colors.primary, fontWeight: '800', textAlign: 'center' },
});
