/**
 * app/src/screens/RepeatNotice.tsx
 *
 * Shown when the guest starts booking a resort they already booked and paid
 * for within the last 12 hours (or earlier the same day): an accidental
 * double booking is easy on a phone. They can see the earlier booking, book
 * again anyway, and tick "Don't show this again today" to stop the notice
 * until tomorrow.
 */
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { SavedBooking } from '../storage';
import { colors, radius, shadow, space, themed } from '../theme';
import { Button, Ionicons, prettyDay } from '../ui';

// "2 hours ago" / "35 minutes ago" for when the earlier booking was paid.
function ago(ms: number) {
  const min = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  if (min < 60) return `${min} minute${min > 1 ? 's' : ''} ago`;
  const h = Math.round(min / 60);
  return `${h} hour${h > 1 ? 's' : ''} ago`;
}

export function RepeatNotice({ earlier, onBookAgain, onViewTrips, onClose }: {
  earlier: SavedBooking;
  onBookAgain: (turnOffToday: boolean) => void;
  onViewTrips: (turnOffToday: boolean) => void;
  onClose: () => void;
}) {
  const [off, setOff] = useState(false);

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={st.backdrop}>
        <View style={st.card}>
          <View style={st.icon}><Ionicons name="alert-circle" size={30} color="#013C58" /></View>
          <Text style={st.title}>You already booked this resort</Text>
          <Text style={st.body}>
            {earlier.resort ?? 'This resort'} was booked {earlier.paidAt ? ago(earlier.paidAt) : 'today'}
            {earlier.day ? ` for ${prettyDay(earlier.day)}` : ''} (booking {earlier.reference}).
            Do you want to make another booking?
          </Text>

          {/* Don't show this again today */}
          <Pressable onPress={() => setOff(!off)} style={st.check} hitSlop={6} accessibilityRole="checkbox" accessibilityState={{ checked: off }}>
            <Ionicons name={off ? 'checkbox' : 'square-outline'} size={22} color={colors.primary} />
            <Text style={st.checkText}>Don't show this again today</Text>
          </Pressable>

          <Button label="Book again" icon="add-circle-outline" onPress={() => onBookAgain(off)} />
          <Button label="View my trips" variant="ghost" icon="ticket-outline" onPress={() => onViewTrips(off)} />
        </View>
      </View>
    </Modal>
  );
}

// Styles for the notice.
const st = themed(() => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(1, 30, 45, 0.55)', alignItems: 'center', justifyContent: 'center', padding: space.lg },
  card: { width: '100%', maxWidth: 380, backgroundColor: colors.card, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow },
  icon: { alignSelf: 'center', width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFD35B', alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.ink, fontSize: 19, fontWeight: '800', textAlign: 'center' },
  body: { color: colors.muted, lineHeight: 21, textAlign: 'center' },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.skySoft, borderRadius: radius.md, padding: 12 },
  checkText: { color: colors.ink, fontWeight: '600' },
}));
