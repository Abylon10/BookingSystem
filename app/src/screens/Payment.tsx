/**
 * app/src/screens/Payment.tsx
 *
 * Simulated payment (no real money moves). The booking is HELD on the island
 * with a countdown. "Pay" → central confirms the hold on the island
 * (CONFIRMED). "Simulate failed payment" → central releases the hold
 * (compensating step of the saga) and the units go back on sale.
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, payBooking, type Booking } from '../api';
import { colors, peso, radius, space } from '../theme';
import { Button, Card, ErrorBox, Header, InfoRow, Pills, prettyDay } from '../ui';

// Payment methods shown to the guest (all simulated).
const METHODS = ['GCash', 'Maya', 'Card'];

export function Payment({ booking, onPaid, onCancel }: { booking: Booking; onPaid: (b: Booking) => void; onCancel: () => void }) {
  const [method, setMethod] = useState(METHODS[0]);
  const [busy, setBusy] = useState<'pay' | 'fail' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [released, setReleased] = useState(false);
  const left = useCountdown(booking.hold_expires_at);

  // Sends the payment result to central (success, or a simulated decline).
  async function pay(fail: boolean) {
    setBusy(fail ? 'fail' : 'pay');
    setError(null);
    try {
      onPaid(await payBooking(booking.reference, method.toLowerCase(), fail));
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

  return (
    <View style={st.screen}>
      <Header title="Payment" subtitle={`${booking.package_name} · ${booking.island_name}`} onBack={onCancel} />
      <ScrollView contentContainerStyle={st.body}>
        {/* Hold timer: the island keeps the units only until it runs out */}
        <View style={[st.timer, (expired || released) && { backgroundColor: colors.danger }]}>
          <Text style={st.timerText}>
            {released ? 'Hold released' : expired ? 'Hold expired' : `Spot held for ${fmt(left)}`}
          </Text>
          <Text style={st.timerRef}>Ref {booking.reference}</Text>
        </View>

        {/* What is being paid for */}
        <Card>
          <InfoRow label="Package" value={booking.package_name} />
          <InfoRow label="Date" value={prettyDay(booking.day)} />
          <InfoRow label="Guests" value={String(booking.guests)} />
          <InfoRow label="Guest" value={booking.guest_name} />
          <InfoRow label="Amount" value={peso(booking.total_php)} strong />
        </Card>

        {released || expired ? (
          <>
            <ErrorBox message={error ?? 'The hold ran out before payment. Nothing was charged; please book again.'} />
            <Button label="Back to packages" onPress={onCancel} />
          </>
        ) : (
          <>
            <Text style={st.section}>Pay with</Text>
            <Pills options={METHODS} value={method} onChange={setMethod} />
            <ErrorBox message={error} />
            <Button label={`Pay ${peso(booking.total_php)}`} onPress={() => pay(false)} busy={busy === 'pay'} disabled={!!busy} variant="accent" />
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
  screen: { flex: 1, backgroundColor: colors.sand },
  body: { padding: space.md, gap: space.md, paddingBottom: 60 },
  timer: { backgroundColor: colors.ink, borderRadius: radius.md, padding: space.md, alignItems: 'center' },
  timerText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  timerRef: { color: '#D6E6EA', marginTop: 2 },
  section: { color: colors.ink, fontWeight: '700', fontSize: 15 },
  hint: { color: colors.muted, textAlign: 'center', fontSize: 12 },
});
