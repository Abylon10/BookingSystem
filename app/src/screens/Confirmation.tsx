/**
 * app/src/screens/Confirmation.tsx
 *
 * Shown after payment, and when opening a booking from "My bookings".
 * There is no ticket to scan: the guest shows THIS screen at the island's
 * front desk. The receptionist searches the reference (or name) and checks
 * that the ID matches the type and last 4 shown here, then checks them in.
 */
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, cancelBooking, getBooking, type Booking } from '../api';
import { PackageImage } from '../scene';
import { colors, peso, radius, shadow, space } from '../theme';
import { Button, Card, ErrorBox, InfoRow, Ionicons, StatusBadge, TopBar, tripDates } from '../ui';

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
      <TopBar title={justPaid ? 'You’re booked!' : 'My booking'} onBack={onDone} />
      <ScrollView contentContainerStyle={st.body}>
        {/* Pass card: picture, big reference, status */}
        <View style={st.pass}>
          <PackageImage packageId={b.package_id} style={st.passImg} />
          <View style={st.passBody}>
            <Text style={st.passLabel}>Show this at the {b.island_name} front desk</Text>
            <Text style={st.ref} selectable>{b.reference}</Text>
            <StatusBadge status={b.status} center />
          </View>
          {/* Dashed tear line, like a ticket stub */}
          <View style={st.tear} />
          <View style={st.passFoot}>
            <View style={st.idIcon}><Ionicons name="id-card-outline" size={22} color={colors.ink} /></View>
            <View style={{ flex: 1 }}>
              <Text style={st.idTitle}>{b.guest_name}</Text>
              <Text style={st.idText}>Bring your {b.id_type} ending {b.id_last4}</Text>
            </View>
          </View>
        </View>

        {b.stale && <ErrorBox tone="notice" message="The island is offline; this is the last copy central received." />}

        {/* Trip details */}
        <Card>
          <InfoRow label="Package" value={b.package_name} />
          <InfoRow label="Where" value={b.location} />
          <InfoRow label="Date" value={tripDates(b.day, b.nights)} />
          <InfoRow label="Guests" value={String(b.guests)} />
          <InfoRow label="E-mail" value={b.email} />
          {b.payment && <InfoRow label="Payment ref" value={`${b.payment.ref} (${b.payment.method})`} />}
          <InfoRow label="Paid" value={peso(b.total_php)} strong />
        </Card>

        <ErrorBox message={error} />
        <Button label="Refresh status" onPress={refresh} busy={busy === 'refresh'} disabled={!!busy} variant="ghost" icon="refresh" />
        {canCancel && <Button label="Cancel booking" onPress={cancel} busy={busy === 'cancel'} disabled={!!busy} variant="danger" />}
        <Button label="Done" onPress={onDone} />
      </ScrollView>
    </View>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.md, gap: space.md, paddingBottom: 60 },
  pass: { backgroundColor: '#fff', borderRadius: radius.lg, overflow: 'hidden', ...shadow },
  passImg: { height: 140 },
  passBody: { padding: space.lg, alignItems: 'center', gap: 8 },
  passLabel: { color: colors.muted, fontSize: 13 },
  ref: { color: colors.ink, fontSize: 36, fontWeight: '800', letterSpacing: 2 },
  tear: { borderTopWidth: 2, borderStyle: 'dashed', borderColor: colors.line, marginHorizontal: space.md },
  passFoot: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: space.md, backgroundColor: '#FFF7E0' },
  idIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.sun, alignItems: 'center', justifyContent: 'center' },
  idTitle: { color: colors.ink, fontWeight: '800', fontSize: 15 },
  idText: { color: colors.ink, fontSize: 13 },
});
