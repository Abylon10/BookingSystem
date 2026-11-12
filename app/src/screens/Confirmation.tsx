/**
 * app/src/screens/Confirmation.tsx
 *
 * Shown after payment, and when opening a booking from "My bookings".
 * There is no ticket: the guest shows THIS information at the island's front
 * desk. The receptionist searches the reference (or name) and checks that the
 * ID matches the type and last 4 shown here, then checks the guest in.
 */
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, cancelBooking, getBooking, type Booking } from '../api';
import { colors, peso, radius, space } from '../theme';
import { Button, Card, ErrorBox, Header, InfoRow, prettyDay, StatusBadge } from '../ui';

export function Confirmation({ booking: initial, onDone, justPaid }: { booking: Booking; onDone: () => void; justPaid?: boolean }) {
  const [b, setB] = useState(initial);
  const [busy, setBusy] = useState<'refresh' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-reads the booking from central (e.g. to see CHECKED_IN after arrival).
  async function refresh() {
    setBusy('refresh');
    setError(null);
    try {
      setB({ ...(await getBooking(b.reference, b.email)), payment: b.payment });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  // Asks first, then cancels on the island (units go back on sale).
  function cancel() {
    Alert.alert('Cancel booking?', `${b.reference} · ${b.package_name}`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel booking', style: 'destructive', onPress: async () => {
          setBusy('cancel');
          setError(null);
          try {
            setB(await cancelBooking(b.reference, b.email));
          } catch (err) {
            setError((err as ApiError).message);
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  }

  const canCancel = b.status === 'CONFIRMED' || b.status === 'HELD';

  return (
    <View style={st.screen}>
      <Header title={justPaid ? 'You’re booked!' : 'Booking'} subtitle={`${b.package_name} · ${b.island_name}`} onBack={onDone} />
      <ScrollView contentContainerStyle={st.body}>
        {/* Big reference: what the receptionist types in */}
        <View style={st.refBox}>
          <Text style={st.refLabel}>Show this at the {b.island_name} front desk</Text>
          <Text style={st.ref} selectable>{b.reference}</Text>
          <StatusBadge status={b.status} />
        </View>

        {b.stale && <Text style={st.stale}>The island is offline; this is the last copy central received.</Text>}

        {/* Trip details */}
        <Card>
          <InfoRow label="Package" value={b.package_name} />
          <InfoRow label="Where" value={b.location} />
          <InfoRow label="Date" value={prettyDay(b.day)} />
          <InfoRow label="Length" value={b.nights ? `${b.nights} night${b.nights > 1 ? 's' : ''}` : 'Day trip'} />
          <InfoRow label="Guests" value={String(b.guests)} />
          <InfoRow label="Paid" value={peso(b.total_php)} strong />
          {b.payment && <InfoRow label="Payment ref" value={`${b.payment.ref} (${b.payment.method})`} />}
        </Card>

        {/* Who must show up and which ID they must bring */}
        <Card>
          <InfoRow label="Guest" value={b.guest_name} />
          <InfoRow label="Bring your ID" value={`${b.id_type} ending ${b.id_last4}`} />
          <InfoRow label="E-mail" value={b.email} />
        </Card>

        <ErrorBox message={error} />
        <Button label="Refresh status" onPress={refresh} busy={busy === 'refresh'} disabled={!!busy} variant="ghost" />
        {canCancel && <Button label="Cancel booking" onPress={cancel} busy={busy === 'cancel'} disabled={!!busy} variant="danger" />}
        <Button label="Done" onPress={onDone} />
      </ScrollView>
    </View>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sand },
  body: { padding: space.md, gap: space.md, paddingBottom: 60 },
  refBox: { backgroundColor: colors.ink, borderRadius: radius.md, padding: space.lg, alignItems: 'center', gap: space.sm },
  refLabel: { color: '#D6E6EA', fontSize: 13 },
  ref: { color: colors.accent, fontSize: 34, fontWeight: '800', letterSpacing: 2 },
  stale: { backgroundColor: '#FBEBD7', color: colors.ink, padding: space.md, borderRadius: radius.sm },
});
