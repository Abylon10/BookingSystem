/**
 * app/src/screens/Payment.tsx
 *
 * Simulated payment (no real money moves). The booking is HELD on the island
 * with a countdown. "Pay" → central confirms the hold on the island
 * (CONFIRMED). "Simulate failed payment" → central releases the hold
 * (compensating step of the saga) and the units go back on sale.
 */
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, payBooking, type Booking } from '../api';
import { colors, peso, radius, shadow, space } from '../theme';
import { Button, Card, ErrorBox, InfoRow, Ionicons, TopBar, tripDates } from '../ui';

// Payment methods shown to the guest (all simulated).
const METHODS: { id: string; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'gcash', label: 'GCash', icon: 'phone-portrait-outline' },
  { id: 'maya', label: 'Maya', icon: 'wallet-outline' },
  { id: 'card', label: 'Credit / debit card', icon: 'card-outline' },
];

export function Payment({ booking, onPaid, onCancel }: { booking: Booking; onPaid: (b: Booking) => void; onCancel: () => void }) {
  const [method, setMethod] = useState(METHODS[0].id);
  const [busy, setBusy] = useState<'pay' | 'fail' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [released, setReleased] = useState(false);
  const left = useCountdown(booking.hold_expires_at);

  // Sends the payment result to central (success, or a simulated decline).
  async function pay(fail: boolean) {
    setBusy(fail ? 'fail' : 'pay');
    setError(null);
    try {
      onPaid(await payBooking(booking.reference, method, fail));
    } catch (err) {
      const e = err as ApiError;
      // 402 = declined and released; 409 = hold already expired/released.
      if (e.status === 402 || e.status === 409) setReleased(true);
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const expired = left === 0;
  const over = released || expired;

  return (
    <View style={st.screen}>
      <TopBar title="Payment" onBack={onCancel} />
      <ScrollView contentContainerStyle={st.body}>
        {/* Hold timer: the island keeps the units only until it runs out */}
        <View style={[st.timer, over && { backgroundColor: colors.danger }]}>
          <Ionicons name={over ? 'close-circle-outline' : 'time-outline'} size={26} color={colors.sun} />
          <View style={{ flex: 1 }}>
            <Text style={st.timerText}>{released ? 'Hold released' : expired ? 'Hold expired' : `Spot held for ${fmt(left)}`}</Text>
            <Text style={st.timerRef}>Reference {booking.reference}</Text>
          </View>
        </View>

        {/* What is being paid for */}
        <Card>
          <InfoRow label="Package" value={booking.package_name} />
          <InfoRow label="Date" value={tripDates(booking.day, booking.nights)} />
          <InfoRow label="Guests" value={String(booking.guests)} />
          <InfoRow label="Guest" value={booking.guest_name} />
          <View style={st.divider} />
          <InfoRow label="Total" value={peso(booking.total_php)} strong />
        </Card>

        {over ? (
          <>
            <ErrorBox message={error ?? 'The hold ran out before payment. Nothing was charged; please book again.'} />
            <Button label="Back to trips" onPress={onCancel} />
          </>
        ) : (
          <>
            {/* Method list (radio style) */}
            <Text style={st.h}>Pay with</Text>
            <View style={{ gap: 10 }}>
              {METHODS.map((m) => (
                <Pressable key={m.id} onPress={() => setMethod(m.id)} style={[st.method, method === m.id && st.methodOn]}>
                  <View style={st.methodIcon}><Ionicons name={m.icon} size={20} color={colors.primary} /></View>
                  <Text style={st.methodText}>{m.label}</Text>
                  <Ionicons name={method === m.id ? 'radio-button-on' : 'radio-button-off'} size={22} color={method === m.id ? colors.primary : colors.line} />
                </Pressable>
              ))}
            </View>
            <ErrorBox message={error} />
            <Button label={`Pay ${peso(booking.total_php)}`} onPress={() => pay(false)} busy={busy === 'pay'} disabled={!!busy} variant="accent" icon="shield-checkmark-outline" />
            {/* Demo button for the class: shows the saga's compensating step */}
            <Button label="Simulate failed payment" onPress={() => pay(true)} busy={busy === 'fail'} disabled={!!busy} variant="ghost" />
            <Text style={st.hint}>Demo only: no real payment is made.</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// Seconds left until `expiresAt` (ms), ticking every second; null if no expiry.
function useCountdown(expiresAt: number | null) {
  const calc = () => (expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : null);
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    const t = setInterval(() => setLeft(calc()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return left;
}

// 125 → "2:05".
function fmt(sec: number | null) {
  if (sec === null) return '—';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.md, gap: space.md, paddingBottom: 60 },
  timer: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.ink, borderRadius: radius.md, padding: space.md },
  timerText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  timerRef: { color: '#B9DCEA', marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 2 },
  h: { color: colors.ink, fontWeight: '800', fontSize: 17 },
  method: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 12, borderWidth: 1.5, borderColor: 'transparent', ...shadow, shadowOpacity: 0.05 },
  methodOn: { borderColor: colors.primary },
  methodIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.skySoft, alignItems: 'center', justifyContent: 'center' },
  methodText: { flex: 1, color: colors.ink, fontWeight: '600', fontSize: 15 },
  hint: { color: colors.muted, textAlign: 'center', fontSize: 12 },
});
